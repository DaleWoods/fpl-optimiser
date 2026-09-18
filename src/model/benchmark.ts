import type { Database } from 'better-sqlite3';

/**
 * Is this model better than not having one?
 *
 * Every number on the Accuracy page until now was self-referential: a typical miss of 1.31
 * points per player means nothing on its own, because nobody knows what a bad one would be.
 * Without something to beat, "the model is 1.31 out" and "the model is useless" are
 * indistinguishable, and four gameweeks of grading produced no answer to the only question that
 * matters - is any of this work adding value over the obvious alternative?
 *
 * So the same players, for the same gameweek, are scored three ways:
 *
 *  - **This model** - what the app projected before the deadline.
 *  - **FPL's own number** - `ep_next`, the expected-points figure the API publishes for free.
 *    This is the benchmark that matters most: it is what you would get by doing nothing at all,
 *    and any week the model loses to it is a week this app made things worse.
 *  - **Form** - the player's points per game so far. The "just pick whoever has been scoring"
 *    heuristic, which is exactly the reasoning this model is supposed to improve on.
 *
 * Both baselines are read from the last snapshot taken *before* that gameweek's deadline, so
 * they are genuinely what was knowable at the time rather than hindsight.
 */

export interface BenchmarkLine {
  /** 'model' | 'fpl' | 'form' */
  key: 'model' | 'fpl' | 'form';
  label: string;
  meanAbsoluteError: number;
  bias: number;
  /** How much lower this line's error is than the model's, as a fraction. Null for the model. */
  improvementOverModel: number | null;
}

export interface Benchmark {
  eventId: number;
  /** Players scored by all three at once - the only fair comparison. */
  players: number;
  lines: BenchmarkLine[];
  /** Null when there is nothing to compare against. */
  verdict: 'model-best' | 'model-tied' | 'model-beaten' | null;
  beatenBy: string[];
}

interface Row {
  predicted: number;
  actual: number;
  epNext: number | null;
  pointsPerGame: number | null;
}

/**
 * Score the model and both baselines over one graded gameweek.
 *
 * Players are included only when all three have something to say, so nobody wins by declining to
 * answer on the hard cases. A player the API never published an `ep_next` for is dropped from
 * every line, not scored as zero for one of them.
 */
export function benchmarkGameweek(db: Database, eventId: number): Benchmark | null {
  const rows = db
    .prepare(
      `SELECT pr.xpts AS predicted, a.points AS actual, ps.ep_next AS epNext,
              ps.points_per_game AS pointsPerGame
       FROM projection pr
       JOIN actual_points a ON a.player_id = pr.player_id AND a.event_id = pr.event_id
       JOIN event e ON e.id = pr.event_id
       -- The last thing the API said about this player before the deadline. Anything later
       -- would be hindsight, and would flatter the baselines rather than the model.
       JOIN player_snapshot ps ON ps.player_id = pr.player_id
        AND ps.taken_at = (
          SELECT MAX(taken_at) FROM player_snapshot
          WHERE player_id = pr.player_id
            AND (e.deadline_time IS NULL OR taken_at <= e.deadline_time)
        )
       WHERE pr.event_id = ?
         AND ps.ep_next IS NOT NULL
         AND ps.points_per_game IS NOT NULL
         AND pr.created_at = (
           SELECT MAX(created_at) FROM projection
           WHERE player_id = pr.player_id AND event_id = pr.event_id
         )`,
    )
    .all(eventId) as Row[];

  if (rows.length === 0) return null;

  const score = (
    key: BenchmarkLine['key'],
    label: string,
    pick: (row: Row) => number,
  ): BenchmarkLine => {
    let absolute = 0;
    let signed = 0;
    for (const row of rows) {
      const error = pick(row) - row.actual;
      absolute += Math.abs(error);
      signed += error;
    }
    return {
      key,
      label,
      meanAbsoluteError: round(absolute / rows.length),
      bias: round(signed / rows.length),
      improvementOverModel: null,
    };
  };

  const model = score('model', 'This model', (row) => row.predicted);
  const lines = [
    model,
    score('fpl', "FPL's own number", (row) => row.epNext ?? 0),
    score('form', 'Points per game so far', (row) => row.pointsPerGame ?? 0),
  ];

  for (const line of lines) {
    if (line.key === 'model') continue;
    // Positive means the model is better by that fraction; negative means it lost.
    line.improvementOverModel =
      line.meanAbsoluteError > 0
        ? round((line.meanAbsoluteError - model.meanAbsoluteError) / line.meanAbsoluteError)
        : null;
  }

  // A hair's difference over a few hundred players is not a win either way. 2% of the baseline's
  // own error is the line for calling it: below that the honest answer is that they are level.
  const tolerance = 0.02;
  const beatenBy = lines
    .filter(
      (line) =>
        line.key !== 'model' &&
        line.meanAbsoluteError < model.meanAbsoluteError * (1 - tolerance),
    )
    .map((line) => line.label);
  const clearlyBetter = lines.filter(
    (line) =>
      line.key !== 'model' && model.meanAbsoluteError < line.meanAbsoluteError * (1 - tolerance),
  );

  return {
    eventId,
    players: rows.length,
    lines,
    verdict:
      beatenBy.length > 0
        ? 'model-beaten'
        : clearlyBetter.length === lines.length - 1
          ? 'model-best'
          : 'model-tied',
    beatenBy,
  };
}

/** The same comparison pooled across every graded gameweek, which is the one worth acting on. */
export function benchmarkSeason(db: Database, eventIds: readonly number[]): Benchmark | null {
  const perEvent = eventIds
    .map((eventId) => benchmarkGameweek(db, eventId))
    .filter((entry): entry is Benchmark => entry !== null);
  if (perEvent.length === 0) return null;

  const players = perEvent.reduce((sum, entry) => sum + entry.players, 0);
  if (players === 0) return null;

  // Weighted by players scored, so a gameweek with more of them counts for more - the pooled
  // figure has to be the same number you would get from scoring every row at once.
  const pooled = perEvent[0]!.lines.map((_, index) => {
    const first = perEvent[0]!.lines[index]!;
    const weighted = (pick: (line: BenchmarkLine) => number): number =>
      round(
        perEvent.reduce((sum, entry) => sum + pick(entry.lines[index]!) * entry.players, 0) /
          players,
      );
    return {
      key: first.key,
      label: first.label,
      meanAbsoluteError: weighted((line) => line.meanAbsoluteError),
      bias: weighted((line) => line.bias),
      improvementOverModel: null as number | null,
    };
  });

  const model = pooled.find((line) => line.key === 'model')!;
  for (const line of pooled) {
    if (line.key === 'model') continue;
    line.improvementOverModel =
      line.meanAbsoluteError > 0
        ? round((line.meanAbsoluteError - model.meanAbsoluteError) / line.meanAbsoluteError)
        : null;
  }

  const tolerance = 0.02;
  const beatenBy = pooled
    .filter(
      (line) =>
        line.key !== 'model' && line.meanAbsoluteError < model.meanAbsoluteError * (1 - tolerance),
    )
    .map((line) => line.label);
  const clearlyBetter = pooled.filter(
    (line) =>
      line.key !== 'model' && model.meanAbsoluteError < line.meanAbsoluteError * (1 - tolerance),
  );

  return {
    eventId: 0,
    players,
    lines: pooled,
    verdict:
      beatenBy.length > 0
        ? 'model-beaten'
        : clearlyBetter.length === pooled.length - 1
          ? 'model-best'
          : 'model-tied',
    beatenBy,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
