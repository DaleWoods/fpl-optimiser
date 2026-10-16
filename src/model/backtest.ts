import type { Database } from 'better-sqlite3';
import type { Rules, ModelWeights } from '../config/schema.js';
import type { ProjectedPlayer } from '../domain/types.js';
import { buildProjections } from './build.js';
import { simulateAutoSubs } from './accuracy.js';

/**
 * Replaying the season to find out whether any of this is worth running.
 *
 * Every figure the Accuracy page reports is an *error* measurement - how far a projection was
 * from an outcome. None of them is the objective. The objective is points, and the assumption
 * that a smaller error produces more of them has never been checked. It is not obviously true:
 * mean absolute error rewards correctly predicting the several hundred players who score 0-2,
 * which has no bearing at all on choosing eleven.
 *
 * So this replays each gameweek from the squad actually held, using only data that existed
 * before that deadline, and scores four ways of picking an XI and a captain in the currency that
 * matters:
 *
 *  - **this model** - what it would have told you to play;
 *  - **what you played** - the honest benchmark, and the one it has been losing to;
 *  - **FPL's own number** - `ep_next`, free from the API, what you get for doing nothing;
 *  - **hold** - last week's XI and captain again, the cost of simply not deciding.
 *
 * Scored with FPL's real auto-substitution and vice-captain rules, so these are points that
 * would genuinely have counted rather than the sum of eleven names.
 *
 * Transfers are deliberately out of scope. Simulating a counterfactual transfer would change the
 * squad, and from the second gameweek on nothing would be comparable to anything. Holding the
 * squad fixed isolates the decision the model makes every single week, and it is the decision
 * the armband evidence says is costing the most.
 */

export interface PolicyScore {
  key: 'model' | 'you' | 'fpl' | 'hold';
  label: string;
  /** Points per gameweek, in replay order. */
  weekly: number[];
  total: number;
  mean: number;
}

export interface BacktestWeek {
  eventId: number;
  squadSize: number;
  scores: Record<PolicyScore['key'], number>;
  captainByPolicy: Record<PolicyScore['key'], string | null>;
}

export interface BacktestResult {
  weeks: BacktestWeek[];
  policies: PolicyScore[];
  /** Paired comparisons against what you actually played. */
  versusYou: {
    key: PolicyScore['key'];
    label: string;
    meanDifference: number;
    /** 95% interval from a paired bootstrap of the weekly differences. */
    low: number;
    high: number;
    significant: boolean;
  }[];
  /**
   * The smallest per-week edge this many gameweeks could detect at all, from the observed
   * spread of the differences. Reported because it is usually larger than the effect being
   * argued about, and saying so is more useful than a point estimate nobody can act on.
   */
  detectableEdge: number | null;
  notes: string[];
}

interface SquadMember {
  playerId: number;
  position: string;
}

/** The squad actually held going into a gameweek, from the advice stored before that deadline. */
function squadForEvent(db: Database, eventId: number): SquadMember[] {
  const stored = db
    .prepare(
      `SELECT detail_json AS detail FROM recommendation
       WHERE event_id = ? AND kind = 'xi'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(eventId) as { detail: string } | undefined;

  if (stored) {
    try {
      const detail = JSON.parse(stored.detail) as { squad?: SquadMember[] };
      if (detail.squad && detail.squad.length > 0) return detail.squad;
    } catch {
      // Falls through to the picks below.
    }
  }

  // squad_pick carries no gameweek of its own - it hangs off the manager_state capture that
  // wrote it, so the gameweek comes from there.
  return db
    .prepare(
      `SELECT sp.player_id AS playerId, pos.short_name AS position
       FROM squad_pick sp
       JOIN manager_state ms ON ms.id = sp.manager_state_id
       JOIN player p ON p.id = sp.player_id
       JOIN position pos ON pos.id = p.position_id
       WHERE ms.event_id = ?
       ORDER BY ms.captured_at DESC, ms.id DESC, sp.slot ASC`,
    )
    .all(eventId) as SquadMember[];
}

/** The last snapshot taken before a gameweek's deadline - the only data a replay may use. */
function snapshotBefore(db: Database, eventId: number): number | null {
  const row = db
    .prepare(
      `SELECT s.id FROM snapshot s
       JOIN event e ON e.id = ?
       WHERE e.deadline_time IS NULL OR s.taken_at <= e.deadline_time
       ORDER BY s.taken_at DESC, s.id DESC LIMIT 1`,
    )
    .get(eventId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Pick eleven and a captain by a given value, respecting formation bounds. */
function pickEleven(
  squad: SquadMember[],
  valueOf: (playerId: number) => number,
  rules: Rules,
): { starters: SquadMember[]; bench: SquadMember[]; captainId: number | null } {
  const bounds = rules.startingXi.positionBounds;
  const byValue = [...squad].sort((a, b) => valueOf(b.playerId) - valueOf(a.playerId));

  const starters: SquadMember[] = [];
  const counts = new Map<string, number>();
  // Minimums first, so a formation is always legal; then the best of whoever is left.
  for (const [position, bound] of Object.entries(bounds)) {
    for (const player of byValue) {
      if (starters.includes(player) || player.position !== position) continue;
      if ((counts.get(position) ?? 0) >= bound.min) break;
      starters.push(player);
      counts.set(position, (counts.get(position) ?? 0) + 1);
    }
  }
  for (const player of byValue) {
    if (starters.length >= rules.startingXi.size) break;
    if (starters.includes(player)) continue;
    const bound = bounds[player.position];
    if (bound && (counts.get(player.position) ?? 0) >= bound.max) continue;
    starters.push(player);
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
  }

  const bench = squad.filter((player) => !starters.includes(player));
  const captain =
    starters.length > 0
      ? starters.reduce((best, player) =>
          valueOf(player.playerId) > valueOf(best.playerId) ? player : best,
        )
      : null;
  return { starters, bench, captainId: captain?.playerId ?? null };
}

export function runBacktest(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
): BacktestResult {
  const notes: string[] = [];

  const graded = (
    db
      .prepare(
        `SELECT e.id FROM event e
         WHERE e.finished = 1
           AND EXISTS (SELECT 1 FROM actual_points a WHERE a.event_id = e.id)
         ORDER BY e.id`,
      )
      .all() as { id: number }[]
  ).map((row) => row.id);

  const weeks: BacktestWeek[] = [];
  let previousXi: { starters: SquadMember[]; bench: SquadMember[]; captainId: number | null } | null =
    null;

  for (const eventId of graded) {
    const squad = squadForEvent(db, eventId);
    if (squad.length < rules.startingXi.size) {
      notes.push(`Gameweek ${eventId}: no squad on record, so it cannot be replayed.`);
      continue;
    }

    const asOfSnapshotId = snapshotBefore(db, eventId);
    if (asOfSnapshotId === null) {
      notes.push(`Gameweek ${eventId}: no snapshot from before the deadline, so it is skipped.`);
      continue;
    }

    const actual = new Map(
      (
        db
          .prepare(
            'SELECT player_id AS playerId, points, minutes FROM actual_points WHERE event_id = ?',
          )
          .all(eventId) as { playerId: number; points: number; minutes: number | null }[]
      ).map((row) => [row.playerId, { points: row.points, minutes: row.minutes }]),
    );

    // Re-derived, not read back: a stored projection exists only for weeks a team happened to
    // be generated, under whatever model version was current, and cannot be ablated later.
    const projections: ProjectedPlayer[] = buildProjections(db, eventId, rules, weights, {
      asOfSnapshotId,
      asOfEventId: eventId,
    });
    const projected = new Map(projections.map((p) => [p.playerId, p.xPts]));

    const epNext = new Map(
      (
        db
          .prepare(
            'SELECT player_id AS playerId, ep_next AS ep FROM player_snapshot WHERE snapshot_id = ?',
          )
          .all(asOfSnapshotId) as { playerId: number; ep: number | null }[]
      ).map((row) => [row.playerId, row.ep ?? 0]),
    );

    const positionById = new Map(squad.map((player) => [player.playerId, player.position]));
    const score = (picked: ReturnType<typeof pickEleven>): number =>
      simulateAutoSubs(
        picked.starters,
        picked.bench,
        positionById,
        actual,
        picked.captainId,
        picked.starters.find((p) => p.playerId !== picked.captainId)?.playerId ?? null,
        rules,
      ).total;

    const modelXi = pickEleven(squad, (id) => projected.get(id) ?? 0, rules);
    const fplXi = pickEleven(squad, (id) => epNext.get(id) ?? 0, rules);
    const yourTotal = (
      db
        .prepare('SELECT actual_points AS pts FROM gameweek_result WHERE event_id = ? LIMIT 1')
        .get(eventId) as { pts: number | null } | undefined
    )?.pts;

    // Holding means fielding last week's XI again, which is only possible from week two, and
    // only for players still in the squad.
    const holdXi =
      previousXi &&
      previousXi.starters.every((player) => squad.some((s) => s.playerId === player.playerId))
        ? previousXi
        : modelXi;

    const nameOf = (id: number | null): string | null =>
      id === null ? null : (projections.find((p) => p.playerId === id)?.name ?? `#${id}`);

    weeks.push({
      eventId,
      squadSize: squad.length,
      scores: {
        model: score(modelXi),
        fpl: score(fplXi),
        hold: score(holdXi),
        // Your real total, including hits and chips - the honest benchmark, not a reconstruction.
        you: yourTotal ?? score(modelXi),
      },
      captainByPolicy: {
        model: nameOf(modelXi.captainId),
        fpl: nameOf(fplXi.captainId),
        hold: nameOf(holdXi.captainId),
        you: null,
      },
    });

    if (yourTotal === null || yourTotal === undefined) {
      notes.push(
        `Gameweek ${eventId}: your own score is not recorded, so that column repeats the model's.`,
      );
    }

    previousXi = modelXi;
  }

  const labels: Record<PolicyScore['key'], string> = {
    model: 'This model',
    you: 'What you played',
    fpl: "FPL's own number",
    hold: 'Last week again',
  };

  const policies: PolicyScore[] = (['model', 'you', 'fpl', 'hold'] as const).map((key) => {
    const weekly = weeks.map((week) => week.scores[key]);
    const total = weekly.reduce((sum, value) => sum + value, 0);
    return {
      key,
      label: labels[key],
      weekly,
      total,
      mean: weekly.length > 0 ? round(total / weekly.length) : 0,
    };
  });

  const versusYou = (['model', 'fpl', 'hold'] as const).map((key) => {
    const differences = weeks.map((week) => week.scores[key] - week.scores.you);
    const interval = bootstrapInterval(differences);
    return {
      key,
      label: labels[key],
      meanDifference: round(mean(differences)),
      low: round(interval.low),
      high: round(interval.high),
      // Zero inside the interval means the sign of the effect is not established.
      significant: interval.low > 0 || interval.high < 0,
    };
  });

  const modelDifferences = weeks.map((week) => week.scores.model - week.scores.you);
  const detectableEdge =
    modelDifferences.length > 1
      ? round(standardDeviation(modelDifferences) * Math.sqrt(7.849 / modelDifferences.length))
      : null;

  return { weeks, policies, versusYou, detectableEdge, notes };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * A 95% interval for the mean difference, by resampling the weeks themselves.
 *
 * Deliberately a bootstrap rather than a t-interval: a handful of weekly point differences is a
 * small, lumpy, obviously non-normal sample, and resampling makes no claim about its shape. The
 * seed is fixed so the same data always gives the same interval - an interval that moves between
 * page loads is not evidence of anything.
 */
function bootstrapInterval(values: number[], iterations = 10000): { low: number; high: number } {
  if (values.length < 2) return { low: Number.NaN, high: Number.NaN };

  let seed = 1234567;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < values.length; j += 1) {
      total += values[Math.floor(next() * values.length)]!;
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(iterations * 0.025)]!,
    high: means[Math.floor(iterations * 0.975)]!,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
