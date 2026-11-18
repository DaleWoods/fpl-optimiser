import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { buildProjections } from './build.js';
import {
  calibrationFromRows,
  computeCalibration,
  type CalibrationFactor,
  type GradedRow,
} from './calibration.js';

/**
 * Learning the correction by replaying the season, not by waiting for it.
 *
 * The correction used to be learned only from projections stored at the time, under the exact
 * model version that made them. That had a cost nobody chose: every change to the scoring threw
 * the learning away and the model then ran uncorrected for three gameweeks. It made every fix a
 * trade against the correction - and the correction is worth several points a week - so real
 * faults were left in place, or shipped switched off, to avoid paying it.
 *
 * None of that is necessary. The model can be asked what it WOULD have projected for any past
 * gameweek, from only what was knowable before that deadline: the last snapshot taken before
 * it, and match history up to it. That is the same replay the backtest already relies on, with
 * the same no-lookahead guarantees. So the correction is now measured by replaying every past
 * gameweek under the current model. A model changed this morning is corrected this afternoon,
 * from the whole season rather than from the last three weeks.
 *
 * Two rules keep it honest:
 *
 *  - **It replays without any correction applied.** The correction has to be measured against
 *    the raw model, or a working correction looks unnecessary and removes itself.
 *  - **It can be asked for the correction as it stood before a gameweek.** A replay of
 *    gameweek 5 may only be corrected by what gameweeks 1-4 taught - otherwise the backtest is
 *    scoring a model that had already seen the answer.
 *
 * Only gameweeks with a real snapshot behind them are used. A week rebuilt from match history
 * is blind to injuries and ownership (see BuildOptions.reconstructFromHistory), so its error is
 * partly the reconstruction's, and teaching the live model to correct for that would be
 * correcting for something it does not suffer from.
 */

interface ReplayWeek {
  eventId: number;
  snapshotId: number;
  results: number;
}

/** Finished gameweeks that have both results and a snapshot from before their deadline. */
function replayableWeeks(db: Database, beforeEventId?: number): ReplayWeek[] {
  return db
    .prepare(
      `SELECT e.id AS eventId,
              (SELECT s.id FROM snapshot s
               WHERE e.deadline_time IS NOT NULL AND s.taken_at <= e.deadline_time
               ORDER BY s.taken_at DESC, s.id DESC LIMIT 1) AS snapshotId,
              (SELECT COUNT(*) FROM actual_points a WHERE a.event_id = e.id) AS results
       FROM event e
       WHERE e.finished = 1 AND (@before IS NULL OR e.id < @before)
       ORDER BY e.id`,
    )
    .all({ before: beforeEventId ?? null })
    .filter(
      (row): row is ReplayWeek =>
        (row as ReplayWeek).snapshotId !== null && (row as ReplayWeek).results > 0,
    ) as ReplayWeek[];
}

/**
 * One replayed gameweek's graded rows, remembered for as long as the process lives.
 *
 * A replay re-derives every projection in the gameweek, and the same weeks are asked for again
 * and again - once per page, once per backtest week, a dozen times per ablation. The answer
 * cannot change unless the weights, the snapshot or the results do, and all three are in the
 * key.
 */
const memo = new WeakMap<Database, Map<string, GradedRow[]>>();

function weightsKey(weights: ModelWeights): string {
  // The correction's own settings are left out: they decide how rows are turned into a factor,
  // not what the raw model projects, so changing them must not discard the replays.
  const { calibration: _calibration, ...scoring } = weights;
  return JSON.stringify(scoring);
}

function replayWeek(db: Database, rules: Rules, weights: ModelWeights, week: ReplayWeek): GradedRow[] {
  let perDb = memo.get(db);
  if (!perDb) {
    perDb = new Map();
    memo.set(db, perDb);
  }
  const key = `${week.eventId}|${week.snapshotId}|${week.results}|${weightsKey(weights)}`;
  const cached = perDb.get(key);
  if (cached) return cached;

  const actual = new Map(
    (
      db
        .prepare('SELECT player_id AS playerId, points FROM actual_points WHERE event_id = ?')
        .all(week.eventId) as { playerId: number; points: number }[]
    ).map((row) => [row.playerId, row.points]),
  );

  const rows: GradedRow[] = [];
  for (const player of buildProjections(db, week.eventId, rules, weights, {
    asOfSnapshotId: week.snapshotId,
    asOfEventId: week.eventId,
    calibrationFactors: null,
  })) {
    const points = actual.get(player.playerId);
    if (points === undefined) continue;
    rows.push({
      position: player.position,
      predicted: player.xPts,
      actual: points,
      eventId: week.eventId,
    });
  }

  perDb.set(key, rows);
  return rows;
}

/**
 * The correction the current model has earned, from every replayable gameweek - or, given
 * `beforeEventId`, from only the gameweeks before that one.
 *
 * Falls back to projections stored at the time when too few gameweeks can be replayed - a
 * database whose snapshots were pruned or never taken still has those, and they are a real
 * measurement of this model version even if a narrower one.
 */
export function computeReplayCalibration(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  beforeEventId?: number,
): CalibrationFactor[] {
  if (!weights.calibration.enabled) return [];

  const weeks = replayableWeeks(db, beforeEventId);
  if (weeks.length >= weights.calibration.minGameweeks) {
    const rows = weeks.flatMap((week) => replayWeek(db, rules, weights, week));
    const factors = calibrationFromRows(rows, weights);
    if (factors.length > 0) return factors;
  }

  // Stored projections know nothing about a cutoff, so they can only stand in for the live
  // question, never for "as it stood before gameweek N".
  return beforeEventId === undefined ? computeCalibration(db, weights) : [];
}

/** The same, as the map buildProjections takes. */
export function replayCalibrationFactors(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  beforeEventId?: number,
): Map<string, CalibrationFactor> {
  return new Map(
    computeReplayCalibration(db, rules, weights, beforeEventId).map((factor) => [
      factor.position,
      factor,
    ]),
  );
}

/** How many gameweeks the correction can currently be learned from, and how many it needs. */
export function replayProgress(
  db: Database,
  weights: ModelWeights,
): { replayable: number; needed: number } {
  return { replayable: replayableWeeks(db).length, needed: weights.calibration.minGameweeks };
}
