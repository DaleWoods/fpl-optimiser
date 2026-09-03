import type { Database } from 'better-sqlite3';
import type { ModelWeights } from '../config/schema.js';
import { nowSeconds } from '../db/index.js';

/**
 * Correcting the model with its own measured error.
 *
 * The accuracy tables have always computed bias per position and nothing has ever read any of
 * it - the app graded itself every week and then projected the next week exactly as if it never
 * had. This is the missing half: a bounded per-position correction, derived from measured error,
 * applied to future projections, and shown on the page so it is never a silent thumb on the
 * scale.
 *
 * Deliberately small in scope. One multiplicative factor per position, shrunk hard by sample
 * size and clamped at both ends. Not per player - there is nowhere near enough sample per player
 * and it would amount to fitting noise - and not an automatic retune of the weights, which are
 * the model's structure and should change deliberately, with a version bump and a reason.
 */

export interface CalibrationFactor {
  position: string;
  /** Multiplier applied to xPts. 1.0 is no correction. */
  factor: number;
  /** Mean signed error behind it, matching accuracy.ts: positive means projections ran high. */
  observedBias: number;
  samplePlayers: number;
  gameweeks: number;
}

interface GradedRow {
  position: string;
  predicted: number;
  actual: number;
  eventId: number;
}

/**
 * Derive a per-position correction from the model's own graded error.
 *
 * The correction is a ratio of what happened to what was projected, not the raw bias in points.
 * A half-point lean means something very different for a goalkeeper projected at 3 than for a
 * captain projected at 9, and one additive correction would be wrong for both.
 *
 * It is measured against `xpts_uncalibrated` - the projection before any previous correction was
 * applied - and never against the corrected output. That distinction is the whole design. Measure
 * a working correction against its own corrected output and the ratio comes back at 1.0, so the
 * correction that was working gets thrown away, the error returns the following week, and the
 * model oscillates between corrected and uncorrected forever with no way to tell which state any
 * given week's advice was in.
 */
export function computeCalibration(db: Database, weights: ModelWeights): CalibrationFactor[] {
  const { calibration } = weights;

  const rows = db
    .prepare(
      `SELECT pos.short_name AS position,
              -- Rows written before calibration existed have no uncalibrated column, and had no
              -- correction applied, so their xpts is already the uncalibrated figure.
              COALESCE(pr.xpts_uncalibrated, pr.xpts) AS predicted,
              a.points AS actual, pr.event_id AS eventId
       FROM projection pr
       JOIN actual_points a ON a.player_id = pr.player_id AND a.event_id = pr.event_id
       JOIN player p ON p.id = pr.player_id
       JOIN position pos ON pos.id = p.position_id
       WHERE pr.model_version = ?
         -- One projection per player: the most recent run before the gameweek.
         AND pr.created_at = (
           SELECT MAX(created_at) FROM projection
           WHERE player_id = pr.player_id AND event_id = pr.event_id
         )`,
    )
    .all(weights.modelVersion) as GradedRow[];

  if (rows.length === 0) return [];

  const gameweeks = new Set(rows.map((row) => row.eventId)).size;
  if (gameweeks < calibration.minGameweeks) return [];

  const byPosition = new Map<string, GradedRow[]>();
  for (const row of rows) {
    const list = byPosition.get(row.position) ?? [];
    list.push(row);
    byPosition.set(row.position, list);
  }

  const factors: CalibrationFactor[] = [];
  for (const [position, subset] of [...byPosition].sort(([a], [b]) => a.localeCompare(b))) {
    const sumPredicted = subset.reduce((total, row) => total + row.predicted, 0);
    const sumActual = subset.reduce((total, row) => total + row.actual, 0);

    // A position can genuinely project at zero early in a season (no fixtures loaded, everyone
    // unavailable). There is no ratio to take, and emitting 0 or Infinity would be worse than
    // saying nothing.
    if (sumPredicted <= 0) continue;

    const raw = sumActual / sumPredicted;

    // Shrunk toward no correction at all by sample size, for the same reason every other rate in
    // this model is shrunk: a thin sample of a noisy quantity is not evidence.
    const n = subset.length;
    const weight = n / (n + calibration.priorWeightPlayers);
    const shrunk = 1 + (raw - 1) * weight;

    const factor = Math.min(calibration.maxFactor, Math.max(calibration.minFactor, shrunk));
    const bias =
      subset.reduce((total, row) => total + (row.predicted - row.actual), 0) / subset.length;

    factors.push({
      position,
      factor: Math.round(factor * 10000) / 10000,
      observedBias: Math.round(bias * 1000) / 1000,
      samplePlayers: n,
      gameweeks,
    });
  }

  return factors;
}

/** Persist the factors for one model version, replacing whatever was there for it. */
export function saveCalibration(
  db: Database,
  modelVersion: string,
  factors: readonly CalibrationFactor[],
): void {
  const at = nowSeconds();
  const insert = db.prepare(
    `INSERT INTO calibration_factor (model_version, position, factor, observed_bias,
                                     sample_players, gameweeks, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (model_version, position) DO UPDATE SET
       factor = excluded.factor,
       observed_bias = excluded.observed_bias,
       sample_players = excluded.sample_players,
       gameweeks = excluded.gameweeks,
       computed_at = excluded.computed_at`,
  );

  const write = db.transaction(() => {
    for (const f of factors) {
      insert.run(
        modelVersion,
        f.position,
        f.factor,
        f.observedBias,
        f.samplePlayers,
        f.gameweeks,
        at,
      );
    }
  });
  write();
}

/**
 * Read back the corrections for one model version, and only that version.
 *
 * There is deliberately no fallback to the most recent version available. A factor measured
 * against an older model describes mistakes that model made, and this one may not make them;
 * carrying it over would be correcting something that no longer exists. Bumping modelVersion
 * therefore resets the learning, which is the intended behaviour - a scoring change invalidates
 * what was learned about the previous scoring.
 */
export function loadCalibration(db: Database, modelVersion: string): Map<string, CalibrationFactor> {
  const rows = db
    .prepare(
      `SELECT position, factor, observed_bias AS observedBias,
              sample_players AS samplePlayers, gameweeks
       FROM calibration_factor WHERE model_version = ?`,
    )
    .all(modelVersion) as CalibrationFactor[];

  return new Map(rows.map((row) => [row.position, row]));
}
