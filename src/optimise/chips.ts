import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import type { ProjectedPlayer } from '../domain/types.js';
import { buildProjections } from '../model/build.js';
import type { Solver } from './solver.js';
import { selectBestEleven, selectBestSquad } from './squad.js';

/**
 * Chip strategy.
 *
 * Each chip is valued by what it would actually be worth in a given gameweek, from the same
 * projections that drive every other recommendation:
 *
 *  - Bench Boost   your four bench players' projected points, which is why it belongs in a
 *                  double gameweek: everyone plays twice, so the bench is worth roughly double.
 *  - Triple Captain the extra multiple on your captain - one more of their projected score.
 *  - Free Hit      the gap between the best XI available from the whole player pool and the
 *                  best XI from your own squad. Largest in a blank gameweek, when much of your
 *                  squad has no fixture at all.
 *  - Wildcard      the same gap, but it keeps the new squad permanently, so it is judged over
 *                  the remaining horizon rather than a single week.
 *
 * Chip legality comes from config, not from assumptions: two sets per season, one of each per
 * half, the first set lost at the GW19 deadline, one chip per gameweek.
 */

export interface GameweekShape {
  eventId: number;
  name: string | null;
  deadlineIso: string | null;
  /** Clubs playing twice or more. */
  doubleClubs: string[];
  /** Clubs with no fixture. */
  blankClubs: string[];
  fixtureCount: number;
  /** How many of the manager's own 15 have no fixture. */
  squadBlanks: number;
  /** How many of the manager's own 15 play twice. */
  squadDoubles: number;
}

export interface ChipRecommendation {
  chip: string;
  chipName: string;
  /** 1 = first half (expires at the GW19 deadline), 2 = second half. */
  half: 1 | 2;
  recommendedEvent: number | null;
  expectedGain: number;
  confident: boolean;
  reason: string;
  alternatives: { eventId: number; gain: number }[];
  warning: string | null;
}

export interface ChipAdvice {
  horizon: GameweekShape[];
  recommendations: ChipRecommendation[];
  notes: string[];
}

export interface ChipAdviceOptions {
  /** Gameweeks to look ahead. */
  horizon?: number;
  /** The manager's current 15, if known. */
  squad?: readonly ProjectedPlayer[];
  /** Chips already used, by code. */
  chipsUsed?: { name: string; event: number | null }[];
  /** Evaluating Free Hit and Wildcard rebuilds the squad, which is slow. */
  evaluateRebuilds?: boolean;
  solver: Solver;
}

/** Which half of the season a gameweek falls in, from the configured chip expiry. */
export function halfOf(eventId: number, rules: Rules): 1 | 2 {
  return eventId <= rules.chips.firstSetExpiresAfterGameweek ? 1 : 2;
}

interface EventRow {
  id: number;
  name: string | null;
  deadlineIso: string | null;
}

/**
 * Fixture structure for the coming gameweeks: who plays twice, who does not play at all.
 * This is what drives every chip decision, and it comes straight from the fixture list, so
 * re-uploading fixtures after a rearrangement immediately changes the advice.
 */
export function readHorizon(
  db: Database,
  fromEvent: number,
  horizon: number,
  squad?: readonly ProjectedPlayer[],
): GameweekShape[] {
  const events = db
    .prepare(
      `SELECT id, name, deadline_time_iso AS deadlineIso FROM event
       WHERE id >= ? ORDER BY id ASC LIMIT ?`,
    )
    .all(fromEvent, horizon) as EventRow[];

  const squadClubs = squad?.map((player) => player.clubId) ?? [];

  return events.map((event) => {
    const rows = db
      .prepare('SELECT team_h AS h, team_a AS a FROM fixture WHERE event_id = ?')
      .all(event.id) as { h: number; a: number }[];

    const counts = new Map<number, number>();
    for (const row of rows) {
      counts.set(row.h, (counts.get(row.h) ?? 0) + 1);
      counts.set(row.a, (counts.get(row.a) ?? 0) + 1);
    }

    const allClubs = db.prepare('SELECT id, short_name AS short FROM team').all() as {
      id: number;
      short: string;
    }[];

    const doubleClubs = allClubs.filter((c) => (counts.get(c.id) ?? 0) >= 2).map((c) => c.short);
    const blankClubs = allClubs.filter((c) => (counts.get(c.id) ?? 0) === 0).map((c) => c.short);

    return {
      eventId: event.id,
      name: event.name,
      deadlineIso: event.deadlineIso,
      doubleClubs,
      blankClubs,
      fixtureCount: rows.length,
      squadBlanks: squadClubs.filter((club) => (counts.get(club) ?? 0) === 0).length,
      squadDoubles: squadClubs.filter((club) => (counts.get(club) ?? 0) >= 2).length,
    };
  });
}

interface GameweekValue {
  shape: GameweekShape;
  benchBoostGain: number;
  tripleCaptainGain: number;
  freeHitGain: number;
  captainName: string | null;
}

/**
 * Recommend when to play each remaining chip.
 *
 * Every figure is an expected-points gain computed from the projections, not a rule of thumb.
 * Where the gain is small the advice says to hold rather than manufacturing a reason to spend.
 */
export async function adviseChips(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  fromEvent: number,
  options: ChipAdviceOptions,
): Promise<ChipAdvice> {
  // Chips are one-per-half-season, so a chip advisor that only looks a couple of months ahead
  // risks recommending a merely-decent window while a genuinely big one - once its fixtures are
  // published - sits just out of view. 16 gameweeks (roughly a third of a season) costs nothing
  // when nothing that far out is unusual yet; it only ever changes the advice when there is
  // something real to see.
  const horizonLength = options.horizon ?? 16;
  const notes: string[] = [];
  const horizon = readHorizon(db, fromEvent, horizonLength, options.squad);

  if (horizon.length === 0) {
    return {
      horizon: [],
      recommendations: [],
      notes: ['No upcoming gameweeks are stored. Import fixtures to get chip advice.'],
    };
  }

  const used = new Set(
    (options.chipsUsed ?? [])
      .filter((chip) => chip.event !== null && halfOf(chip.event, rules) === halfOf(fromEvent, rules))
      .map((chip) => chip.name),
  );

  const currentHalf = halfOf(fromEvent, rules);
  const values: GameweekValue[] = [];

  for (const shape of horizon) {
    const projections = buildProjections(db, shape.eventId, rules, weights);
    let benchBoostGain = 0;
    let tripleCaptainGain = 0;
    let freeHitGain = 0;
    let captainName: string | null = null;

    if (options.squad && options.squad.length === rules.squad.size && projections.length > 0) {
      const byId = new Map(projections.map((player) => [player.playerId, player]));
      const squadThisWeek = options.squad
        .map((player) => byId.get(player.playerId))
        .filter((player): player is ProjectedPlayer => player !== undefined);

      if (squadThisWeek.length === rules.squad.size) {
        try {
          const eleven = await selectBestEleven(squadThisWeek, rules, weights, options.solver);

          // Bench Boost: the bench simply scores as well.
          benchBoostGain = eleven.bench.reduce((total, player) => total + player.xPts, 0);

          // Triple Captain: one further multiple of the captain's projection.
          tripleCaptainGain =
            eleven.captain.xPts *
            (rules.captain.tripleCaptainMultiplier - rules.captain.multiplier);
          captainName = eleven.captain.name;

          if (options.evaluateRebuilds) {
            const best = await selectBestSquad(projections, rules, weights, options.solver);
            freeHitGain = best.eleven.expectedPoints - eleven.expectedPoints;
          }
        } catch {
          // No legal XI this week - usually a heavy blank. Leave the gains at zero and let the
          // fixture shape speak for itself.
        }
      }
    }

    values.push({ shape, benchBoostGain, tripleCaptainGain, freeHitGain, captainName });
  }

  const recommendations: ChipRecommendation[] = [];
  const expiry = rules.chips.firstSetExpiresAfterGameweek;

  const bestBy = (score: (value: GameweekValue) => number) =>
    [...values].sort((a, b) => score(b) - score(a));

  const describeShape = (shape: GameweekShape): string => {
    const parts: string[] = [];
    if (shape.doubleClubs.length > 0) {
      parts.push(`${shape.doubleClubs.length} club(s) play twice (${shape.doubleClubs.join(', ')})`);
    }
    if (shape.blankClubs.length > 0) {
      parts.push(`${shape.blankClubs.length} club(s) have no fixture`);
    }
    if (parts.length === 0) parts.push('a normal gameweek');
    return parts.join('; ');
  };

  for (const chip of rules.chips.available) {
    if (used.has(chip)) continue;

    const chipName = rules.chips.names[chip] ?? chip;
    const effect = rules.chips.effects[chip];

    let ranked: GameweekValue[];
    let gainOf: (value: GameweekValue) => number;

    if (effect?.benchScores) {
      gainOf = (value) => value.benchBoostGain;
      ranked = bestBy(gainOf);
    } else if (effect?.captainMultiplier) {
      gainOf = (value) => value.tripleCaptainGain;
      ranked = bestBy(gainOf);
    } else if (effect?.unlimitedTransfers) {
      gainOf = (value) => value.freeHitGain;
      ranked = bestBy(gainOf);
    } else {
      continue;
    }

    const best = ranked[0];
    const gain = best ? gainOf(best) : 0;
    const haveSquad = options.squad !== undefined && options.squad.length === rules.squad.size;

    // Without a squad there is nothing to value a chip against, so advise on fixture shape only.
    let reason: string;
    let recommendedEvent: number | null = null;
    let confident = false;

    if (!haveSquad) {
      const shapeRanked = [...horizon].sort((a, b) => {
        if (effect?.benchScores || effect?.captainMultiplier) {
          return b.doubleClubs.length - a.doubleClubs.length;
        }
        return b.blankClubs.length - a.blankClubs.length;
      });
      const target = shapeRanked[0];
      const interesting =
        target &&
        ((effect?.benchScores || effect?.captainMultiplier
          ? target.doubleClubs.length
          : target.blankClubs.length) > 0);

      recommendedEvent = interesting ? target.eventId : null;
      reason = interesting
        ? `No squad loaded, so this is based on fixture shape only: GW${target.eventId} has ` +
          `${describeShape(target)}, which is when ${chipName} is usually worth most. ` +
          'Load your squad for a points-based figure.'
        : `Nothing in the next ${horizon.length} gameweeks stands out for ${chipName}. ` +
          'Hold it, and re-check when fixtures are rearranged.';
    } else if (!best || gain <= 0) {
      reason =
        effect?.unlimitedTransfers && !options.evaluateRebuilds
          ? `${chipName} needs a full squad rebuild to value, which was not run. Use ` +
            '`fpl chips --deep` to evaluate it.'
          : `No gameweek in the next ${horizon.length} makes ${chipName} worth playing yet. Hold it.`;
    } else {
      recommendedEvent = best.shape.eventId;
      confident = true;
      const extras =
        effect?.captainMultiplier && best.captainName
          ? ` Captaining ${best.captainName} that week.`
          : '';
      reason =
        `GW${best.shape.eventId} is worth about ${gain.toFixed(1)} extra points: ` +
        `${describeShape(best.shape)}.${extras}`;
    }

    let warning: string | null = null;
    if (currentHalf === 1) {
      const deadline = expiry;
      if (recommendedEvent !== null && recommendedEvent > deadline) {
        warning =
          `That gameweek is past the GW${deadline} deadline, so it would use your ` +
          'second-half chip. The first-half one is lost if unused by then.';
      } else {
        const remaining = deadline - fromEvent + 1;
        if (remaining <= 6) {
          warning =
            `Only ${remaining} gameweek(s) left before the GW${deadline} deadline, after which ` +
            `this half's ${chipName} is lost.`;
        }
      }
    }

    recommendations.push({
      chip,
      chipName,
      half: currentHalf,
      recommendedEvent,
      expectedGain: Math.round(gain * 10) / 10,
      confident,
      reason,
      alternatives: ranked
        .slice(1, 4)
        .filter((value) => gainOf(value) > 0)
        .map((value) => ({
          eventId: value.shape.eventId,
          gain: Math.round(gainOf(value) * 10) / 10,
        })),
      warning,
    });
  }

  if (rules.chips.oneChipPerGameweek) {
    const byEvent = new Map<number, string[]>();
    for (const rec of recommendations) {
      if (rec.recommendedEvent === null) continue;
      const list = byEvent.get(rec.recommendedEvent) ?? [];
      list.push(rec.chipName);
      byEvent.set(rec.recommendedEvent, list);
    }
    for (const [eventId, chips] of byEvent) {
      if (chips.length > 1) {
        notes.push(
          `${chips.join(' and ')} both point at GW${eventId}, but only one chip may be played ` +
            'per gameweek. Play the higher-gain one and take the next-best week for the other.',
        );
      }
    }
  }

  if (!options.squad || options.squad.length !== rules.squad.size) {
    notes.push(
      'Chip values are estimated from fixture shape only until a squad is loaded. With your 15 ' +
        'in place each chip is valued in actual expected points.',
    );
  }

  const doubles = horizon.filter((shape) => shape.doubleClubs.length > 0);
  const blanks = horizon.filter((shape) => shape.blankClubs.length > 0);
  if (doubles.length > 0) {
    notes.push(
      `Double gameweeks ahead: ${doubles.map((d) => `GW${d.eventId} (${d.doubleClubs.length} clubs)`).join(', ')}.`,
    );
  }
  if (blanks.length > 0) {
    notes.push(
      `Blank gameweeks ahead: ${blanks.map((b) => `GW${b.eventId} (${b.blankClubs.length} clubs)`).join(', ')}.`,
    );
  }
  if (doubles.length === 0 && blanks.length === 0) {
    notes.push(
      `No doubles or blanks in the next ${horizon.length} gameweeks. Re-check after any fixture ` +
        'rearrangement - European progress and cup ties are what create them.',
    );
  }

  return { horizon, recommendations, notes };
}
