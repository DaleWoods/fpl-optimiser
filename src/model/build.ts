import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import { classifyAvailability } from '../domain/availability.js';
import type { ProjectedPlayer } from '../domain/types.js';
import { recentFixturesByPlayer, sumRecent, type RecentFixtureRow } from './recentForm.js';
import { computeLeagueTable } from './table.js';
import { projectPlayer, type FixtureContext, type PlayerModelInput } from './xpts.js';

interface PlayerRow {
  playerId: number;
  name: string;
  teamId: number;
  clubShort: string;
  position: string;
  price: number;
  status: string | null;
  chanceNext: number | null;
  news: string | null;
  ownership: number | null;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  bonus: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  defensiveContribution: number | null;
  epNext: number | null;
  transfersInEvent: number | null;
  transfersOutEvent: number | null;
}

interface TeamRow {
  id: number;
  shortName: string;
  attackHome: number | null;
  attackAway: number | null;
  defenceHome: number | null;
  defenceAway: number | null;
}

interface SeasonHistoryRow {
  playerId: number;
  seasonName: string;
  totalPoints: number | null;
  minutes: number | null;
  starts: number | null;
  goals: number | null;
  assists: number | null;
  saves: number | null;
  bonus: number | null;
  expectedGoals: number | null;
  expectedAssists: number | null;
  defensiveContribution: number | null;
}

interface FixtureRow {
  id: number;
  eventId: number | null;
  teamH: number;
  teamA: number;
  difficultyH: number | null;
  difficultyA: number | null;
  kickoffTime: number | null;
}

/**
 * Which clubs have a fixture this gameweek that follows their previous fixture (any earlier
 * gameweek) by fewer than restDaysThreshold days - most often a European tie sandwiched in
 * between two league gameweeks, since that is the only reason a top-flight club's own league
 * fixtures get shuffled this tight. Computed purely from imported fixture kickoff times: the FPL
 * API carries no European fixtures at all, so a short gap between two Premier League ones is the
 * only signal available.
 */
function clubsWithShortRest(
  db: Database,
  thisWeek: readonly FixtureRow[],
  restDaysThreshold: number,
): Set<number> {
  const allKickoffs = db
    .prepare(
      `SELECT team_h AS teamH, team_a AS teamA, kickoff_time AS kickoffTime
       FROM fixture WHERE kickoff_time IS NOT NULL ORDER BY kickoff_time ASC`,
    )
    .all() as { teamH: number; teamA: number; kickoffTime: number }[];

  const byTeam = new Map<number, number[]>();
  for (const row of allKickoffs) {
    for (const teamId of [row.teamH, row.teamA]) {
      const list = byTeam.get(teamId) ?? [];
      list.push(row.kickoffTime);
      byTeam.set(teamId, list);
    }
  }

  // Largest timestamp strictly before `before`, in an ascending-sorted array.
  const previousKickoff = (sorted: number[], before: number): number | null => {
    let lo = 0;
    let hi = sorted.length - 1;
    let result: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < before) {
        result = sorted[mid]!;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  };

  const restDaysSeconds = restDaysThreshold * 24 * 3600;
  const shortRest = new Set<number>();
  for (const fixture of thisWeek) {
    if (fixture.kickoffTime === null) continue;
    for (const teamId of [fixture.teamH, fixture.teamA]) {
      const previous = previousKickoff(byTeam.get(teamId) ?? [], fixture.kickoffTime);
      if (previous !== null && fixture.kickoffTime - previous < restDaysSeconds) {
        shortRest.add(teamId);
      }
    }
  }
  return shortRest;
}

/** Per-90 rate, or null when there are not enough minutes to say anything. */
function per90(total: number | null, minutes: number | null): number | null {
  if (total === null || minutes === null || minutes <= 0) return null;
  return (total / minutes) * 90;
}

/**
 * Blend a thin per-90 rate toward a prior rate, weighted by how many minutes sit behind each.
 *
 * Standard Bayesian shrinkage: (observed * minutes + prior * priorWeightMinutes) / (both). One
 * goal in 90 minutes is not a repeatable scoring threat, it is one good afternoon, and for a
 * rare high-variance event like a goal one match is nowhere near enough evidence either way.
 *
 * What matters just as much is *what it shrinks toward*. Shrinking toward zero says "with no
 * evidence, we assume you score nothing" - fine for a defender, badly wrong for an elite
 * forward, and it was making the model project a whole XI at 19.7 points against an actual 75.
 * The right anchor is the player's own rate from last season: Haaland's early games then update
 * a strong prior and stay strong, while a defender's one lucky goal updates a near-zero prior
 * and stays near zero. Same mechanism, correct in both directions. priorRate falls back to 0
 * for a player with no last-season history at all, where "assume nothing" genuinely is the
 * honest starting point.
 */
function shrinkRate(
  rate: number | null,
  minutes: number | null,
  priorWeightMinutes: number,
  priorRate: number | null = 0,
): number | null {
  if (rate === null) return null;
  const mins = minutes ?? 0;
  const anchor = priorRate ?? 0;
  return (rate * mins + anchor * priorWeightMinutes) / (mins + priorWeightMinutes);
}

/**
 * Flag players trending toward a price rise or fall, purely as an informational note - never an
 * xPts adjustment, never a gate on selection. FPL's real price-change algorithm is unpublished,
 * so this ranks every player by net transfers this gameweek (in minus out) and flags the topN at
 * each end, but only when net transfers clear netTransfersFloor - otherwise a quiet gameweek's
 * top 20 is really just noise, not a genuine signal.
 */
function classifyPriceTrends(
  players: readonly { playerId: number; transfersInEvent: number | null; transfersOutEvent: number | null }[],
  weights: ModelWeights,
): Map<number, 'rising' | 'falling'> {
  const trends = new Map<number, 'rising' | 'falling'>();

  const withNet = players
    .filter((player) => player.transfersInEvent !== null && player.transfersOutEvent !== null)
    .map((player) => ({
      playerId: player.playerId,
      net: player.transfersInEvent! - player.transfersOutEvent!,
    }));

  const rising = [...withNet]
    .filter((player) => player.net >= weights.priceTrend.netTransfersFloor)
    .sort((a, b) => b.net - a.net)
    .slice(0, weights.priceTrend.topN);
  const falling = [...withNet]
    .filter((player) => -player.net >= weights.priceTrend.netTransfersFloor)
    .sort((a, b) => a.net - b.net)
    .slice(0, weights.priceTrend.topN);

  for (const player of rising) trends.set(player.playerId, 'rising');
  for (const player of falling) trends.set(player.playerId, 'falling');

  return trends;
}

/**
 * Turn stored data into projections for a gameweek.
 *
 * Reads the most recent snapshot for every player, the fixtures for the gameweek, and the club
 * strength ratings, then runs each player through the model.
 */
export function buildProjections(
  db: Database,
  eventId: number,
  rules: Rules,
  weights: ModelWeights,
): ProjectedPlayer[] {
  const snapshot = db
    .prepare('SELECT id FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT 1')
    .get() as { id: number } | undefined;

  if (!snapshot) return [];

  const players = db
    .prepare(
      `SELECT p.id AS playerId, p.web_name AS name, p.team_id AS teamId,
              t.short_name AS clubShort, pos.short_name AS position,
              ps.now_cost AS price, ps.status, ps.chance_of_playing_next_round AS chanceNext,
              ps.news, ps.selected_by_percent AS ownership, ps.minutes, ps.starts,
              ps.goals_scored AS goals, ps.assists, ps.saves, ps.bonus,
              ps.expected_goals AS expectedGoals, ps.expected_assists AS expectedAssists,
              ps.defensive_contribution AS defensiveContribution, ps.ep_next AS epNext,
              ps.transfers_in_event AS transfersInEvent, ps.transfers_out_event AS transfersOutEvent
       FROM player_snapshot ps
       JOIN player p ON p.id = ps.player_id
       JOIN team t ON t.id = p.team_id
       JOIN position pos ON pos.id = p.position_id
       WHERE ps.snapshot_id = ?`,
    )
    .all(snapshot.id) as PlayerRow[];

  const teams = new Map(
    (
      db
        .prepare(
          `SELECT id, short_name AS shortName, strength_attack_home AS attackHome,
                  strength_attack_away AS attackAway, strength_defence_home AS defenceHome,
                  strength_defence_away AS defenceAway
           FROM team`,
        )
        .all() as TeamRow[]
    ).map((team) => [team.id, team]),
  );

  const fixtures = db
    .prepare(
      `SELECT id, event_id AS eventId, team_h AS teamH, team_a AS teamA,
              team_h_difficulty AS difficultyH, team_a_difficulty AS difficultyA,
              kickoff_time AS kickoffTime
       FROM fixture WHERE event_id = ?`,
    )
    .all(eventId) as FixtureRow[];

  const shortRestClubs = clubsWithShortRest(db, fixtures, weights.minutes.rotationRiskRestDaysThreshold);

  // Current league form, blended into club strength. Computed from imported fixture results,
  // so it needs no separate upload and updates the moment results land. Bounded so a hot start
  // nudges rather than dominates the API's own strength ratings.
  const strengthAdjust = new Map<number, number>();
  if (weights.teamStrength.tableWeight > 0) {
    const table = computeLeagueTable(db);
    const played = table.filter((row) => row.played > 0);
    if (played.length > 0) {
      const averagePpg =
        played.reduce((sum, row) => sum + row.ppg, 0) / played.length || 1;
      for (const row of played) {
        const factor = (row.ppg > 0 ? row.ppg / averagePpg : 0.5) ** weights.teamStrength.tableWeight;
        strengthAdjust.set(row.teamId, Math.min(1.3, Math.max(0.7, factor)));
      }
    }
  }
  const adjustFor = (teamId: number): number => strengthAdjust.get(teamId) ?? 1;

  // Every club's fixtures this gameweek: none is a blank, two is a double.
  const fixturesByTeam = new Map<number, FixtureContext[]>();
  for (const fixture of fixtures) {
    const home = teams.get(fixture.teamH);
    const away = teams.get(fixture.teamA);
    if (!home || !away) continue;

    const fallback = weights.teamStrength.fallbackStrength;

    push(fixturesByTeam, fixture.teamH, {
      teamAttack: (home.attackHome ?? fallback) * adjustFor(fixture.teamH),
      teamDefence: (home.defenceHome ?? fallback) * adjustFor(fixture.teamH),
      opponentAttack: (away.attackAway ?? fallback) * adjustFor(fixture.teamA),
      opponentDefence: (away.defenceAway ?? fallback) * adjustFor(fixture.teamA),
      isHome: true,
      opponentShort: away.shortName,
      difficulty: fixture.difficultyH,
    });

    push(fixturesByTeam, fixture.teamA, {
      teamAttack: (away.attackAway ?? fallback) * adjustFor(fixture.teamA),
      teamDefence: (away.defenceAway ?? fallback) * adjustFor(fixture.teamA),
      opponentAttack: (home.attackHome ?? fallback) * adjustFor(fixture.teamH),
      opponentDefence: (home.defenceHome ?? fallback) * adjustFor(fixture.teamH),
      isHome: false,
      opponentShort: home.shortName,
      difficulty: fixture.difficultyA,
    });
  }

  // How many matches each club has already played, as the denominator for start rate.
  const playedByTeam = new Map<number, number>();
  for (const row of db
    .prepare(
      `SELECT team_h AS h, team_a AS a FROM fixture WHERE finished = 1`,
    )
    .all() as { h: number; a: number }[]) {
    playedByTeam.set(row.h, (playedByTeam.get(row.h) ?? 0) + 1);
    playedByTeam.set(row.a, (playedByTeam.get(row.a) ?? 0) + 1);
  }

  // Last completed season per player, for opening-gameweek projections when this season has
  // no minutes yet. Sorted so the most recent season wins.
  const lastSeason = new Map<number, SeasonHistoryRow>();
  for (const row of db
    .prepare(
      `SELECT player_id AS playerId, season_name AS seasonName, total_points AS totalPoints,
              minutes, starts, goals_scored AS goals, assists, saves, bonus,
              expected_goals AS expectedGoals, expected_assists AS expectedAssists,
              defensive_contribution AS defensiveContribution
       FROM player_season_history ORDER BY season_name ASC`,
    )
    .all() as SeasonHistoryRow[]) {
    lastSeason.set(row.playerId, row);
  }

  // Recent gameweeks (this season only), for the recency-weighted blend below - one shared
  // fetch, sliced per purpose since minutes and attacking rates each have their own window size.
  const recentWindowSize = Math.max(weights.minutes.recentMatches, weights.attacking.recentMatches);
  const recentFixtures = recentFixturesByPlayer(db, recentWindowSize);

  const priceTrends = classifyPriceTrends(players, weights);

  const projected: ProjectedPlayer[] = [];

  for (const row of players) {
    const availability = classifyAvailability(
      {
        status: row.status,
        chanceOfPlayingNextRound: row.chanceNext,
        news: row.news,
      },
      weights,
    );

    // This season's minutes decide which evidence to use. With none *and* the season not yet
    // underway, last season's rates are the best real signal there is. But once this player's
    // club has actually played and he still has zero minutes, that zero is not an absence of
    // evidence any more - it is evidence, and usually strong evidence he is not first-choice.
    // Falling back to last season's rate here was the bug behind a nailed-on-bench player (or a
    // summer signing behind an established starter) getting picked on the strength of a start
    // rate that no longer applies: it kept re-consulting a stale prior instead of ever letting
    // this season's zero starts speak for themselves.
    const seasonUnderway = (playedByTeam.get(row.teamId) ?? 0) > 0;
    const previous =
      (row.minutes ?? 0) > 0 || seasonUnderway ? undefined : lastSeason.get(row.playerId);
    const usingPrevious = previous !== undefined && (previous.minutes ?? 0) > 0;

    const source = usingPrevious ? previous : row;
    const sourceMinutes = usingPrevious ? previous.minutes : row.minutes;

    // Previous-season rates are shrunk by their sample size: a per-90 from 90 minutes keeps
    // under a tenth of its face value, a full season keeps most of it. This is what stops a
    // player with one lucky cameo outscoring genuine starters. Applied to every category, not
    // just goals - defcon is a stable volume stat, but that only means it converges faster
    // toward its true rate, not that a one-game sample of it deserves any less caution early on.
    const priorMins = weights.attacking.priorWeightMinutes;

    // What this season's thin rates shrink *toward*: the player's own last-season per-90, not
    // zero. build.ts deliberately stops *replacing* this season's rates with last season's once
    // the season is under way (see above) - that stays true. Anchoring is a different job: it is
    // the baseline this season's evidence updates away from, and last season is by far the best
    // player-specific estimate of it. Undefined for anyone with no last-season history, which
    // shrinkRate reads as zero - honest for a genuinely unknown player.
    const anchor = lastSeason.get(row.playerId);
    const anchorMinutes = anchor?.minutes ?? 0;
    const anchorRate = (total: number | null): number | null =>
      anchor === undefined || anchorMinutes <= 0 ? null : per90(total, anchorMinutes);

    // Recent form, blended in on top of the season-long rate - but only while using this
    // season's own evidence (falling back to last season already has its own shrinkage, and
    // "recent form" would not mean anything there anyway). The blend weight scales down when
    // the recent window itself is thin - a single substitute cameo must not swing a rate as
    // hard as several real starts would, the same shrinkage principle used for last season's
    // rate above, just applied to this season's own recent window instead of a whole season.
    const recentAll = usingPrevious ? [] : (recentFixtures.get(row.playerId) ?? []);
    const recentAttackingWindow = recentAll.slice(0, weights.attacking.recentMatches);
    const recentAttackingMinutes = sumRecent(recentAttackingWindow, (r) => r.minutes);

    const rate = (
      total: number | null,
      recentField: (r: RecentFixtureRow) => number | null,
      recentWeight: number,
      priorWeightMinutesOverride: number = priorMins,
      anchorTotal?: number | null,
    ): number | null => {
      if (usingPrevious) {
        // Already *using* last season's rate - there is nothing separate to anchor it to.
        return shrinkRate(per90(total, sourceMinutes), sourceMinutes, priorWeightMinutesOverride);
      }
      const priorRate = anchorTotal === undefined ? 0 : anchorRate(anchorTotal);
      // Same shrinkage as the previous-season branch above, and for the same reason: a
      // this-season rate from one big early game is exactly as thin a sample as a one-cameo
      // rate from last season, and deserves exactly as little confidence. Without this, a
      // defender's single standout defensive-contribution haul in gameweek 1 was trusted at
      // full face value from gameweek 2 onward - the "stops a lucky cameo outscoring genuine
      // starters" protection the comment above promises, but that this branch never actually
      // delivered for the season everyone actually cares about.
      const seasonRate = shrinkRate(
        per90(total, sourceMinutes),
        sourceMinutes,
        priorWeightMinutesOverride,
        priorRate,
      );
      if (recentAttackingMinutes <= 0) return seasonRate;
      const recentTotal = sumRecent(recentAttackingWindow, recentField);
      const recentRate = (recentTotal / recentAttackingMinutes) * 90;
      const confidence = Math.min(
        1,
        recentAttackingMinutes / (weights.attacking.recentMatches * weights.minutes.expectedMinutesIfStarting),
      );
      const effectiveWeight = recentWeight * confidence;
      return seasonRate === null
        ? recentRate
        : effectiveWeight * recentRate + (1 - effectiveWeight) * seasonRate;
    };

    // Goal involvement (goals and assists, and the xG/xA that anchor them) gets extra caution
    // for a goalkeeper or defender specifically: shrinking toward zero with one shared prior
    // weight cannot be right for both a striker (whose true rate is genuinely often close to
    // that prior) and a defender (whose true rate is close to zero) at the same time. One goal
    // from a defender in an early match is far more surprising, and far weaker evidence of a
    // real repeatable threat, than the same goal from a forward - a real bug (a defender's one
    // gameweek 1 goal comfortably outranked Haaland's whole season-to-date output for gameweek
    // 2's captaincy) that raising the shared prior weight alone was not enough to fully close.
    // Applies only to goal involvement, not to defensive contribution, saves or bonus - those
    // already have their own position-appropriate treatment (DefCon's threshold is set per
    // position in rules.json) and are not the rare, high-variance events goals and assists are.
    const isLowGoalThreatPosition = row.position === 'GKP' || row.position === 'DEF';
    const goalInvolvementPriorMins = isLowGoalThreatPosition
      ? weights.attacking.lowThreatPriorWeightMinutes
      : priorMins;

    // Same idea for the minutes model: blend the recent start RATE with the season-long one,
    // then feed it back as an effective starts count over the same season-long sample size, so
    // the existing Bayesian shrinkage toward the prior (in projectMinutes) still sees the true
    // volume of evidence - only the numerator reflects recent form more than a flat season
    // average would.
    const seasonStarts = usingPrevious ? (previous.starts ?? 0) : (row.starts ?? 0);
    const seasonMatches = usingPrevious
      ? Math.round((previous.minutes ?? 0) / 90)
      : (playedByTeam.get(row.teamId) ?? 0);

    let effectiveStarts = seasonStarts;
    if (!usingPrevious && seasonMatches > 0) {
      const recentMinutesWindow = recentAll.slice(0, weights.minutes.recentMatches);
      if (recentMinutesWindow.length > 0) {
        const recentStartRate =
          sumRecent(recentMinutesWindow, (r) => r.starts) / recentMinutesWindow.length;
        const seasonStartRate = seasonStarts / seasonMatches;
        const confidence = Math.min(1, recentMinutesWindow.length / weights.minutes.recentMatches);
        const effectiveWeight = weights.minutes.recentWeight * confidence;
        const blendedStartRate =
          effectiveWeight * recentStartRate + (1 - effectiveWeight) * seasonStartRate;
        effectiveStarts = blendedStartRate * seasonMatches;
      }
    }

    const input: PlayerModelInput = {
      playerId: row.playerId,
      name: row.name,
      position: row.position,
      availability,
      ownership: row.ownership,
      minutesPlayed: row.minutes ?? 0,
      matchesAvailable: seasonMatches,
      starts: effectiveStarts,
      xgPer90: rate(source.expectedGoals, (r) => r.expectedGoals, weights.attacking.recentWeight, goalInvolvementPriorMins, anchor?.expectedGoals),
      xaPer90: rate(source.expectedAssists, (r) => r.expectedAssists, weights.attacking.recentWeight, goalInvolvementPriorMins, anchor?.expectedAssists),
      goalsPer90: rate(source.goals, (r) => r.goals, weights.attacking.recentWeight, goalInvolvementPriorMins, anchor?.goals),
      assistsPer90: rate(source.assists, (r) => r.assists, weights.attacking.recentWeight, goalInvolvementPriorMins, anchor?.assists),
      savesPer90: rate(source.saves, (r) => r.saves, weights.saves.recentWeight, priorMins, anchor?.saves),
      defconPer90: rate(source.defensiveContribution, (r) => r.defensiveContribution, weights.defensiveContribution.recentWeight, priorMins, anchor?.defensiveContribution),
      bonusPer90: rate(source.bonus, (r) => r.bonus, weights.bonus.recentWeight, priorMins, anchor?.bonus),
      fixtures: fixturesByTeam.get(row.teamId) ?? [],
      usingPreviousSeason: usingPrevious,
      previousSeasonName: usingPrevious ? previous.seasonName : null,
      previousSeasonPoints: usingPrevious ? previous.totalPoints : null,
      previousSeasonMinutes: usingPrevious ? previous.minutes : null,
      shortRestFixture: shortRestClubs.has(row.teamId),
      fallbackExpectedPoints: row.epNext,
    };

    const projection = projectPlayer(input, weights, rules);

    const priceTrend = priceTrends.get(row.playerId);
    const reasons =
      priceTrend === 'rising'
        ? [
            ...projection.reasons,
            'Heavily transferred in this gameweek - among the most net transfers in, so price ' +
              'may be close to a rise (not a guarantee - FPL does not publish the real algorithm).',
          ]
        : priceTrend === 'falling'
          ? [
              ...projection.reasons,
              'Heavily transferred out this gameweek - among the most net transfers out, so ' +
                'price may be close to a fall (not a guarantee - FPL does not publish the real algorithm).',
            ]
          : projection.reasons;

    projected.push({
      playerId: row.playerId,
      name: row.name,
      clubId: row.teamId,
      clubShort: row.clubShort,
      position: row.position,
      price: row.price,
      availability,
      xPts: projection.xPts,
      xPtsRaw: projection.xPtsRaw,
      breakdown: projection.breakdown,
      expectedMinutes: projection.expectedMinutes,
      confidence: projection.confidence,
      reasons,
      fixtures: input.fixtures.map((fixture) => ({
        opponentShort: fixture.opponentShort,
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
      })),
    });
  }

  return projected;
}

/** Store projections so past advice can be reviewed against what actually happened. */
export function saveProjections(
  db: Database,
  projections: readonly ProjectedPlayer[],
  eventId: number,
  modelVersion: string,
): void {
  const createdAt = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO projection (
       player_id, event_id, model_version, created_at, xpts, xpts_raw,
       availability_probability, expected_minutes, fixture_count, confidence, breakdown_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const write = db.transaction(() => {
    for (const projection of projections) {
      insert.run(
        projection.playerId,
        eventId,
        modelVersion,
        createdAt,
        projection.xPts,
        projection.xPtsRaw,
        projection.availability.probability,
        projection.expectedMinutes,
        1,
        projection.confidence,
        JSON.stringify(projection.breakdown),
      );
    }
  });

  write();
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
