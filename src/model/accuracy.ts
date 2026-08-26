import type { Database } from 'better-sqlite3';
import type { Rules } from '../config/schema.js';
import { nowSeconds } from '../db/index.js';

/**
 * Measuring the model against what actually happened.
 *
 * A projection nobody grades is just an opinion. Every recommendation is stored with its model
 * version, and once actual points arrive the two can be joined: how far out were we, in which
 * direction, for which kinds of player, and how much did the errors cost in real points.
 *
 * Two numbers matter most and they answer different questions:
 *  - mean absolute error says how far out a typical projection was
 *  - bias says whether we are systematically too optimistic or too pessimistic, which is the
 *    fixable kind of wrong. An unbiased model with high error is noisy; a biased one is tuned
 *    incorrectly, and the weights in config can be adjusted for it.
 */

export interface PlayerError {
  playerId: number;
  name: string;
  position: string;
  club: string;
  predicted: number;
  actual: number;
  error: number;
  confidence: string | null;
}

export interface GameweekAccuracy {
  eventId: number;
  modelVersion: string | null;
  playersScored: number;
  /** Mean absolute error, in points. */
  meanAbsoluteError: number;
  /** Mean signed error: positive means the model was too optimistic. */
  bias: number;
  rootMeanSquareError: number;
  /** Per position, so a defensive blind spot is visible separately from an attacking one. */
  byPosition: { position: string; players: number; meanAbsoluteError: number; bias: number }[];
  byConfidence: { confidence: string; players: number; meanAbsoluteError: number; bias: number }[];
  /** Where the model was most wrong, in both directions. */
  overRated: PlayerError[];
  underRated: PlayerError[];
  /** What the recommended XI actually went on to score, if one was stored. */
  recommendedXiActual: number | null;
  recommendedXiPredicted: number | null;
  /** The best legal XI in hindsight, from the squad that was recommended. */
  bestPossibleFromSquad: number | null;
  /**
   * The whole game's gameweek score, from the FPL API's own event data - not something this
   * app derives. Populated automatically the next time bootstrap-static is imported after the
   * gameweek finishes; there is nothing separate to upload for it.
   */
  leagueAverage: number | null;
  leagueHighest: number | null;
  notes: string[];
}

export interface SeasonAccuracy {
  gameweeks: {
    eventId: number;
    playersScored: number;
    meanAbsoluteError: number;
    bias: number;
    recommendedXiActual: number | null;
    bestPossibleFromSquad: number | null;
    yourActual: number | null;
    leagueAverage: number | null;
    leagueHighest: number | null;
  }[];
  overall: {
    playersScored: number;
    meanAbsoluteError: number;
    bias: number;
    gameweeks: number;
  } | null;
  notes: string[];
}

/** Store a recommendation so it can be graded once the gameweek has been played. */
export function saveRecommendation(
  db: Database,
  options: {
    eventId: number;
    entryId: number | null;
    kind: string;
    modelVersion: string;
    summary: string;
    detail: unknown;
    dataTakenAt: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO recommendation (created_at, event_id, entry_id, kind, model_version,
                                 summary, detail_json, data_taken_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowSeconds(),
    options.eventId,
    options.entryId,
    options.kind,
    options.modelVersion,
    options.summary,
    JSON.stringify(options.detail),
    options.dataTakenAt,
  );
}

export interface StoredRecommendationDetail {
  eventId: number;
  eventName: string | null;
  starters: { playerId: number; name: string; xPts: number }[];
  bench: { playerId: number; name: string; xPts: number }[];
  captainId: number | null;
  viceCaptainId: number | null;
}

/**
 * The most recent recommendation stored for a gameweek before the given one, if any - what
 * "since last week" is measured against.
 *
 * Every recommend() call already saves its starters, bench, captain and vice-captain (it has to,
 * for grading later), so there is nothing new to record here: this just reads that same history
 * back for the gameweek before the one being generated now.
 *
 * Deliberately excludes kind='squad' (a from-scratch build, saved whenever no owned squad could
 * be loaded that time - see recommend()'s build-squad path). That squad was never actually
 * "yours"; diffing today's real squad against it produces nonsense like a made-up player
 * "dropping to the bench" who you never owned. Only kind='xi', a recommendation made from a
 * genuinely loaded squad, is a fair baseline for "what changed". Also scoped to the same entry,
 * so a stale or differently-configured team's history can never bleed into this one's diff.
 */
export function previousRecommendationDetail(
  db: Database,
  beforeEventId: number,
  entryId: number | null = null,
): StoredRecommendationDetail | null {
  const stored = db
    .prepare(
      `SELECT r.event_id AS eventId, e.name AS eventName, r.detail_json AS detail
       FROM recommendation r
       LEFT JOIN event e ON e.id = r.event_id
       WHERE r.event_id < ? AND r.kind = 'xi' AND r.entry_id IS ?
       ORDER BY r.event_id DESC, r.created_at DESC, r.id DESC LIMIT 1`,
    )
    .get(beforeEventId, entryId) as
    | { eventId: number; eventName: string | null; detail: string }
    | undefined;
  if (!stored) return null;

  try {
    const detail = JSON.parse(stored.detail) as {
      starters?: { playerId: number; name: string; xPts: number }[];
      bench?: { playerId: number; name: string; xPts: number }[];
      captainId?: number;
      viceCaptainId?: number;
    };
    if (!detail.starters || detail.starters.length === 0) return null;

    return {
      eventId: stored.eventId,
      eventName: stored.eventName,
      starters: detail.starters,
      bench: detail.bench ?? [],
      captainId: detail.captainId ?? null,
      viceCaptainId: detail.viceCaptainId ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Copy actual points from imported per-gameweek stats into the results table.
 *
 * Kept as a separate step because stats and results arrive from different places: a stats file
 * for a season already played is history, while the same shape of file for the season in
 * progress is a result to grade against.
 */
export function recordActualsFromStats(db: Database, seasonName: string): number {
  const result = db
    .prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       SELECT player_id, gameweek, COALESCE(total_points, 0), minutes, 'csv', ?
       FROM player_gameweek_stat
       WHERE season_name = ? AND total_points IS NOT NULL
       ON CONFLICT (player_id, event_id) DO UPDATE SET
         points = excluded.points, minutes = excluded.minutes, recorded_at = excluded.recorded_at`,
    )
    .run(nowSeconds(), seasonName);
  return result.changes;
}

/** Record what you actually scored in a gameweek, for comparison against what was advised. */
export function recordGameweekResult(
  db: Database,
  entryId: number,
  eventId: number,
  values: {
    actualPoints?: number | null;
    benchPoints?: number | null;
    transfersMade?: number | null;
    transferCost?: number | null;
    chip?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO gameweek_result (entry_id, event_id, actual_points, bench_points,
                                  transfers_made, transfer_cost, chip, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, event_id) DO UPDATE SET
       actual_points = COALESCE(excluded.actual_points, gameweek_result.actual_points),
       bench_points = COALESCE(excluded.bench_points, gameweek_result.bench_points),
       transfers_made = COALESCE(excluded.transfers_made, gameweek_result.transfers_made),
       transfer_cost = COALESCE(excluded.transfer_cost, gameweek_result.transfer_cost),
       chip = COALESCE(excluded.chip, gameweek_result.chip),
       recorded_at = excluded.recorded_at`,
  ).run(
    entryId,
    eventId,
    values.actualPoints ?? null,
    values.benchPoints ?? null,
    values.transfersMade ?? null,
    values.transferCost ?? null,
    values.chip ?? null,
    nowSeconds(),
  );
}

interface JoinedRow {
  playerId: number;
  name: string;
  position: string;
  club: string;
  predicted: number;
  actual: number;
  confidence: string | null;
  modelVersion: string;
}

function summarise(rows: { predicted: number; actual: number }[]): {
  meanAbsoluteError: number;
  bias: number;
  rootMeanSquareError: number;
} {
  if (rows.length === 0) return { meanAbsoluteError: 0, bias: 0, rootMeanSquareError: 0 };
  let absolute = 0;
  let signed = 0;
  let squared = 0;
  for (const row of rows) {
    const error = row.predicted - row.actual;
    absolute += Math.abs(error);
    signed += error;
    squared += error * error;
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    meanAbsoluteError: round(absolute / rows.length),
    bias: round(signed / rows.length),
    rootMeanSquareError: round(Math.sqrt(squared / rows.length)),
  };
}

/**
 * The whole game's average and highest score for a gameweek, straight from the FPL API's own
 * event data (bootstrap-static). Both are null until the gameweek finishes and a fresh
 * bootstrap-static is imported - there is no separate upload for this, it rides along.
 */
function leagueScores(
  db: Database,
  eventId: number,
): { leagueAverage: number | null; leagueHighest: number | null } {
  const row = db
    .prepare('SELECT average_score AS leagueAverage, highest_score AS leagueHighest FROM event WHERE id = ?')
    .get(eventId) as { leagueAverage: number | null; leagueHighest: number | null } | undefined;
  return row ?? { leagueAverage: null, leagueHighest: null };
}

/**
 * Grade one gameweek.
 *
 * Only players who were actually projected AND have a recorded result are scored: counting a
 * player we never projected as a zero-error hit would flatter the model, and counting one with
 * no result as a miss would slander it.
 */
export function evaluateGameweek(
  db: Database,
  eventId: number,
  rules: Rules,
  entryId: number | null = null,
): GameweekAccuracy {
  const notes: string[] = [];

  const rows = db
    .prepare(
      `SELECT pr.player_id AS playerId, p.web_name AS name, pos.short_name AS position,
              t.short_name AS club, pr.xpts AS predicted, a.points AS actual,
              pr.confidence, pr.model_version AS modelVersion
       FROM projection pr
       JOIN actual_points a ON a.player_id = pr.player_id AND a.event_id = pr.event_id
       JOIN player p ON p.id = pr.player_id
       JOIN team t ON t.id = p.team_id
       JOIN position pos ON pos.id = p.position_id
       WHERE pr.event_id = ?
         -- One projection per player: the most recent run before the gameweek.
         AND pr.created_at = (
           SELECT MAX(created_at) FROM projection
           WHERE player_id = pr.player_id AND event_id = pr.event_id
         )`,
    )
    .all(eventId) as JoinedRow[];

  if (rows.length === 0) {
    const anyProjections = (
      db.prepare('SELECT COUNT(*) AS n FROM projection WHERE event_id = ?').get(eventId) as {
        n: number;
      }
    ).n;
    const anyActuals = (
      db.prepare('SELECT COUNT(*) AS n FROM actual_points WHERE event_id = ?').get(eventId) as {
        n: number;
      }
    ).n;

    notes.push(
      anyProjections === 0
        ? `No projections stored for gameweek ${eventId}. Run an optimise before the deadline ` +
          'and the projection is kept for grading afterwards.'
        : anyActuals === 0
          ? `No actual results recorded for gameweek ${eventId}. Import a stats file covering ` +
            'it, marked as the current season.'
          : `Projections and results exist for gameweek ${eventId} but none are for the same players.`,
    );

    return {
      eventId,
      modelVersion: null,
      playersScored: 0,
      meanAbsoluteError: 0,
      bias: 0,
      rootMeanSquareError: 0,
      byPosition: [],
      byConfidence: [],
      overRated: [],
      underRated: [],
      recommendedXiActual: null,
      recommendedXiPredicted: null,
      bestPossibleFromSquad: null,
      ...leagueScores(db, eventId),
      notes,
    };
  }

  const overall = summarise(rows);

  const positions = [...new Set(rows.map((row) => row.position))].sort();
  const byPosition = positions.map((position) => {
    const subset = rows.filter((row) => row.position === position);
    const stats = summarise(subset);
    return {
      position,
      players: subset.length,
      meanAbsoluteError: stats.meanAbsoluteError,
      bias: stats.bias,
    };
  });

  const confidences = [...new Set(rows.map((row) => row.confidence ?? 'unknown'))].sort();
  const byConfidence = confidences.map((confidence) => {
    const subset = rows.filter((row) => (row.confidence ?? 'unknown') === confidence);
    const stats = summarise(subset);
    return {
      confidence,
      players: subset.length,
      meanAbsoluteError: stats.meanAbsoluteError,
      bias: stats.bias,
    };
  });

  const withError: PlayerError[] = rows.map((row) => ({
    playerId: row.playerId,
    name: row.name,
    position: row.position,
    club: row.club,
    predicted: Math.round(row.predicted * 100) / 100,
    actual: row.actual,
    error: Math.round((row.predicted - row.actual) * 100) / 100,
    confidence: row.confidence,
  }));

  const sorted = [...withError].sort((a, b) => b.error - a.error);
  const overRated = sorted.slice(0, 5);
  const underRated = [...sorted].reverse().slice(0, 5);

  // How the advice actually fared, if a recommendation was stored before the deadline.
  let recommendedXiActual: number | null = null;
  let recommendedXiPredicted: number | null = null;
  let bestPossibleFromSquad: number | null = null;

  // kind='xi' only: a kind='squad' row is a from-scratch build (saved whenever no owned squad
  // could be loaded that time), never actually "your" recommended XI, so grading against it
  // would score a fantasy team that was never followed. Scoped to entry_id for the same reason
  // previousRecommendationDetail() is - another team's history must never bleed in here either.
  const stored = db
    .prepare(
      `SELECT detail_json AS detail FROM recommendation
       WHERE event_id = ? AND kind = 'xi' AND entry_id IS ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(eventId, entryId) as { detail: string } | undefined;

  if (stored) {
    try {
      const detail = JSON.parse(stored.detail) as {
        starters?: { playerId: number; xPts: number }[];
        bench?: { playerId: number; xPts: number }[];
        captainId?: number;
        viceCaptainId?: number;
        squad?: { playerId: number; position: string }[];
      };

      const actualById = new Map(withError.map((row) => [row.playerId, row.actual]));

      if (detail.starters && detail.starters.length > 0) {
        let predicted = 0;
        let scored = 0;
        for (const starter of detail.starters) {
          const multiplier = starter.playerId === detail.captainId ? rules.captain.multiplier : 1;
          if (actualById.has(starter.playerId)) scored += 1;
          predicted += starter.xPts * multiplier;
        }

        if (scored > 0) {
          recommendedXiPredicted = Math.round(predicted * 10) / 10;

          if (detail.bench && detail.squad && detail.squad.length > 0) {
            // Replays FPL's own auto-sub and captain-armband rules against what actually
            // happened this gameweek, so this grades the score that really would have counted
            // - not just the 11 names originally picked, which understates it every time a
            // starter blanks.
            const positionById = new Map(detail.squad.map((player) => [player.playerId, player.position]));
            const squadIds = detail.squad.map((player) => player.playerId);
            const minutesRows = squadIds.length
              ? (db
                  .prepare(
                    `SELECT player_id AS playerId, points, minutes FROM actual_points
                     WHERE event_id = ? AND player_id IN (${squadIds.map(() => '?').join(',')})`,
                  )
                  .all(eventId, ...squadIds) as {
                  playerId: number;
                  points: number;
                  minutes: number | null;
                }[])
              : [];
            const actualWithMinutesById = new Map(
              minutesRows.map((row) => [row.playerId, { points: row.points, minutes: row.minutes }]),
            );

            recommendedXiActual = simulateAutoSubs(
              detail.starters,
              detail.bench,
              positionById,
              actualWithMinutesById,
              detail.captainId ?? null,
              detail.viceCaptainId ?? null,
              rules,
            ).total;
          } else {
            // An older stored recommendation from before auto-sub grading existed - fall back
            // to the plain sum rather than losing the row entirely.
            let total = 0;
            for (const starter of detail.starters) {
              const actual = actualById.get(starter.playerId);
              if (actual === undefined) continue;
              const multiplier = starter.playerId === detail.captainId ? rules.captain.multiplier : 1;
              total += actual * multiplier;
            }
            recommendedXiActual = total;
          }
        }

        if (scored < detail.starters.length) {
          notes.push(
            `${detail.starters.length - scored} of the recommended XI have no recorded result, ` +
              'so the actual total is understated.',
          );
        }
      }

      // The best XI that squad could have fielded, knowing the results: the gap between this
      // and what was recommended is what better projections were worth, in points.
      if (detail.squad && detail.squad.length === rules.squad.size) {
        bestPossibleFromSquad = bestElevenByActual(detail.squad, actualById, rules);
      }
    } catch {
      notes.push('A stored recommendation for this gameweek could not be read.');
    }
  } else {
    notes.push(
      `No recommendation was stored for gameweek ${eventId}, so only player-level accuracy is ` +
        'available. Recommendations are kept automatically from now on.',
    );
  }

  return {
    eventId,
    modelVersion: rows[0]!.modelVersion,
    playersScored: rows.length,
    ...overall,
    byPosition,
    byConfidence,
    overRated,
    underRated,
    recommendedXiActual,
    recommendedXiPredicted,
    bestPossibleFromSquad,
    ...leagueScores(db, eventId),
    notes,
  };
}

/**
 * Replay FPL's own auto-sub and captain-armband rules against what actually happened, so grading
 * reflects the score that really would have counted - not just the 11 names originally picked,
 * which understates it every time a starter blanks.
 *
 * A starter with 0 actual minutes (or no recorded minutes at all) is replaced by the first bench
 * player, in auto-sub priority order, who did play and keeps the formation legal. A goalkeeper
 * can only be replaced by the bench goalkeeper, never an outfield player, whatever the formation
 * bounds would otherwise allow. If the captain blanks, the doubled points move to the
 * vice-captain instead - independently of which bench player, if any, fills either's vacated
 * slot - and if both blank, nobody is doubled that gameweek, exactly as FPL itself behaves.
 */
export function simulateAutoSubs(
  starters: { playerId: number }[],
  bench: { playerId: number }[],
  positionById: Map<number, string>,
  actualById: Map<number, { points: number; minutes: number | null }>,
  captainId: number | null,
  viceCaptainId: number | null,
  rules: Rules,
): { total: number; finalXi: number[] } {
  const blanked = (playerId: number): boolean => {
    const actual = actualById.get(playerId);
    return !actual || (actual.minutes ?? 0) === 0;
  };

  const positionCounts = (ids: number[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const position = positionById.get(id) ?? 'MID';
      counts[position] = (counts[position] ?? 0) + 1;
    }
    return counts;
  };

  let xi = starters.map((s) => s.playerId);
  const used = new Set(xi);
  const benchOrder = bench.map((b) => b.playerId);

  for (const outId of starters.map((s) => s.playerId)) {
    if (!blanked(outId)) continue;
    const outIsGoalkeeper = positionById.get(outId) === 'GKP';

    for (const inId of benchOrder) {
      if (used.has(inId) || blanked(inId)) continue;
      const inIsGoalkeeper = positionById.get(inId) === 'GKP';
      if (outIsGoalkeeper !== inIsGoalkeeper) continue;

      const candidate = xi.map((id) => (id === outId ? inId : id));
      const counts = positionCounts(candidate);
      const legal = Object.entries(rules.startingXi.positionBounds).every(
        ([position, bounds]) => (counts[position] ?? 0) >= bounds.min && (counts[position] ?? 0) <= bounds.max,
      );
      if (!legal) continue;

      xi = candidate;
      used.delete(outId);
      used.add(inId);
      break;
    }
  }

  const captainPlayed = captainId !== null && !blanked(captainId);
  const vicePlayed = viceCaptainId !== null && !blanked(viceCaptainId);
  const doubledId = captainPlayed ? captainId : vicePlayed ? viceCaptainId : null;

  const total = xi.reduce((sum, id) => {
    const points = actualById.get(id)?.points ?? 0;
    const multiplier = id === doubledId ? rules.captain.multiplier : 1;
    return sum + points * multiplier;
  }, 0);

  return { total, finalXi: xi };
}

/**
 * The highest-scoring legal XI from a squad, using the points that were actually scored.
 *
 * Small enough to solve directly: try every legal split of the 15 that satisfies the formation
 * bounds, and take the best. No solver needed for 1365 combinations.
 */
export function bestElevenByActual(
  squad: { playerId: number; position: string }[],
  actualById: Map<number, number>,
  rules: Rules,
): number | null {
  const scored = squad.filter((player) => actualById.has(player.playerId));
  if (scored.length < rules.startingXi.size) return null;

  let best: number | null = null;

  const choose = (index: number, chosen: typeof scored): void => {
    if (chosen.length === rules.startingXi.size) {
      const counts = new Map<string, number>();
      for (const player of chosen) {
        counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
      }
      for (const [position, bounds] of Object.entries(rules.startingXi.positionBounds)) {
        const count = counts.get(position) ?? 0;
        if (count < bounds.min || count > bounds.max) return;
      }
      const total = chosen.reduce((sum, p) => sum + (actualById.get(p.playerId) ?? 0), 0);
      // The captain doubles, and in hindsight it would have been the best scorer.
      const bestScore = Math.max(...chosen.map((p) => actualById.get(p.playerId) ?? 0));
      const withCaptain = total + bestScore * (rules.captain.multiplier - 1);
      if (best === null || withCaptain > best) best = withCaptain;
      return;
    }
    if (index >= scored.length) return;
    // Prune: not enough players left to fill the XI.
    if (scored.length - index < rules.startingXi.size - chosen.length) return;
    choose(index + 1, [...chosen, scored[index]!]);
    choose(index + 1, chosen);
  };

  choose(0, []);
  return best;
}

/** Grade every gameweek that has both projections and results. */
export function evaluateSeason(db: Database, rules: Rules, entryId: number | null = null): SeasonAccuracy {
  const eventIds = (
    db
      .prepare(
        `SELECT DISTINCT pr.event_id AS eventId
         FROM projection pr
         JOIN actual_points a ON a.event_id = pr.event_id AND a.player_id = pr.player_id
         ORDER BY pr.event_id`,
      )
      .all() as { eventId: number }[]
  ).map((row) => row.eventId);

  if (eventIds.length === 0) {
    return {
      gameweeks: [],
      overall: null,
      notes: [
        'Nothing to grade yet. Accuracy needs a projection made before a deadline and the ' +
          'results afterwards, so it becomes available once you have run an optimise and then ' +
          'imported the stats for that gameweek.',
      ],
    };
  }

  const yourResults = new Map(
    (
      db
        .prepare('SELECT event_id AS eventId, actual_points AS points FROM gameweek_result WHERE entry_id IS ?')
        .all(entryId) as {
        eventId: number;
        points: number | null;
      }[]
    ).map((row) => [row.eventId, row.points]),
  );

  const gameweeks = eventIds.map((eventId) => {
    const accuracy = evaluateGameweek(db, eventId, rules, entryId);
    return {
      eventId,
      playersScored: accuracy.playersScored,
      meanAbsoluteError: accuracy.meanAbsoluteError,
      bias: accuracy.bias,
      recommendedXiActual: accuracy.recommendedXiActual,
      bestPossibleFromSquad: accuracy.bestPossibleFromSquad,
      yourActual: yourResults.get(eventId) ?? null,
      leagueAverage: accuracy.leagueAverage,
      leagueHighest: accuracy.leagueHighest,
    };
  });

  const allRows = db
    .prepare(
      `SELECT pr.xpts AS predicted, a.points AS actual
       FROM projection pr
       JOIN actual_points a ON a.player_id = pr.player_id AND a.event_id = pr.event_id
       WHERE pr.created_at = (
         SELECT MAX(created_at) FROM projection
         WHERE player_id = pr.player_id AND event_id = pr.event_id
       )`,
    )
    .all() as { predicted: number; actual: number }[];

  const overallStats = summarise(allRows);

  return {
    gameweeks,
    overall: {
      playersScored: allRows.length,
      meanAbsoluteError: overallStats.meanAbsoluteError,
      bias: overallStats.bias,
      gameweeks: gameweeks.length,
    },
    notes: [],
  };
}
