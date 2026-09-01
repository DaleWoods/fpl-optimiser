import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import type { ProjectedPlayer, StartingEleven } from '../domain/types.js';
import { latestEliteOwnership } from '../ingest/elite.js';
import { buildProjections, saveProjections } from '../model/build.js';
import {
  benchBoostPull,
  bestBenchBoostGameweek,
  computeHorizon,
  horizonFor,
  type Horizon,
} from '../model/horizon.js';
import { applyIntel, loadIntel, type Intel } from '../model/intel.js';
import {
  previousRecommendationDetail,
  saveRecommendation,
  type StoredRecommendationDetail,
} from '../model/accuracy.js';
import { GlpkSolver } from '../optimise/glpkSolver.js';
import type { Solver } from '../optimise/solver.js';
import { selectBestEleven, selectBestSquad, selectBestTransferPlan } from '../optimise/squad.js';

export interface TransferOption {
  out: ProjectedPlayer;
  in: ProjectedPlayer;
  /** Change in expected points, after any hit - this gameweek's swing plus the horizon below. */
  netGain: number;
  /** This gameweek's own swing from re-solving the XI, before the hit and before the horizon. */
  gainBeforeHit: number;
  /** The discounted value of the run of fixtures after this gameweek, in's minus out's. Can be
   *  negative - a player who is great this week and mediocre after is worth less than the raw
   *  weekly swing alone suggests. */
  horizonGain: number;
  hitCost: number;
  reason: string;
  /** True when `out` is a dead squad slot (see weights.transfers.priorityFixXPtsThreshold) -
   *  surfaced regardless of how it ranks by raw point swing against flashier options. */
  priority: boolean;
}

/**
 * A bounded, upward-only nudge toward captaining someone whose horizon backs up this week's
 * number, rather than a player who is merely spiking. Never applied to a player missing from
 * the horizon or with nothing projected this week - there is nothing to be consistent about.
 */
function captainConsistencyBonusFor(
  playerIds: Iterable<number>,
  horizon: Horizon,
  weights: ModelWeights,
): Map<number, number> {
  const bonus = new Map<number, number>();
  if (horizon.gameweeks.length <= 1) return bonus;

  for (const playerId of playerIds) {
    const h = horizonFor(horizon, playerId);
    if (h.currentXPts <= 0) continue;
    const average = h.horizonXPts / horizon.totalWeight;
    const consistency = Math.min(1, average / h.currentXPts);
    const value = round(weights.horizon.captainConsistencyWeight * consistency);
    if (value > 0) bonus.set(playerId, value);
  }
  return bonus;
}

/**
 * Purely informational context on a transfer target's timing - never a recommendation to wait,
 * never a scoring change. Compares this gameweek's own projection against the target's own
 * average across the rest of the horizon: when the two are far apart, their value is
 * concentrated in particular weeks rather than spread evenly, which is worth knowing before
 * deciding whether to make the move now or wait. Deliberately does not try to answer that
 * question itself - whether to buy ahead of a fixture swing or wait for it to start depends on
 * price-rise risk and what else needs fixing this week, neither of which this weighs.
 */
export function transferTimingNoteFor(
  target: ProjectedPlayer,
  horizon: Horizon,
  weights: ModelWeights,
): string | null {
  if (horizon.gameweeks.length <= 1) return null;

  const h = horizonFor(horizon, target.playerId);
  const futureWeight = horizon.totalWeight - horizon.gameweeks[0]!.weight;
  if (futureWeight <= 0 || h.futureXPts <= 0) return null;

  const futureAverage = h.futureXPts / futureWeight;
  if (futureAverage <= 0) return null;

  const ratio = h.currentXPts / futureAverage;

  if (ratio <= weights.transfers.timingNoteRatio) {
    return (
      `${target.name}'s projection this gameweek (${h.currentXPts.toFixed(2)}) is well below ` +
      `their own average across the rest of the horizon (${futureAverage.toFixed(2)}) - their ` +
      `value here is concentrated in the weeks ahead, not this one. Worth knowing before ` +
      `deciding whether to make this transfer now or wait for their fixtures to turn.`
    );
  }
  if (ratio >= 1 / weights.transfers.timingNoteRatio) {
    return (
      `${target.name}'s projection this gameweek (${h.currentXPts.toFixed(2)}) is well above ` +
      `their own average across the rest of the horizon (${futureAverage.toFixed(2)}) - most of ` +
      `their near-term value is concentrated in this one week. Worth knowing if you were ` +
      `considering delaying this transfer.`
    );
  }
  return null;
}

interface NamedPlayer {
  playerId: number;
  name: string;
}

export interface RecommendationDiff {
  previousEventId: number;
  previousEventName: string | null;
  captain: { from: NamedPlayer; to: NamedPlayer } | null;
  viceCaptain: { from: NamedPlayer; to: NamedPlayer } | null;
  /** Squad members who moved bench -> XI or XI -> bench, with no transfer involved. */
  movedIntoXi: NamedPlayer[];
  movedToBench: NamedPlayer[];
  /** Same bench membership, different order - changes the auto-sub priority. */
  benchOrderChanged: boolean;
  /** True if anything at all differs (including transfers, tracked separately on the result). */
  anyChange: boolean;
}

/**
 * What changed since the last recommendation, one gameweek back - captain, vice-captain, and
 * any squad member who swapped bench <-> XI without being transferred.
 *
 * Transfers (a squad member replaced entirely) are already reported separately by
 * findTransfers()/selectBestSquad() and are folded in here only to decide anyChange and to keep
 * a transferred-out player from also being reported as merely "benched", and a transferred-in
 * player from being reported as merely "promoted".
 */
export function diffAgainstPrevious(
  current: {
    starters: NamedPlayer[];
    bench: NamedPlayer[];
    captainId: number;
    viceCaptainId: number;
  },
  transferredOutIds: ReadonlySet<number>,
  transferredInIds: ReadonlySet<number>,
  previous: StoredRecommendationDetail | null,
): RecommendationDiff | null {
  if (!previous) return null;

  const findName = (pool: NamedPlayer[], playerId: number | null): NamedPlayer | null =>
    playerId === null ? null : (pool.find((p) => p.playerId === playerId) ?? null);

  const prevPool = [...previous.starters, ...previous.bench];
  const currPool = [...current.starters, ...current.bench];
  const prevStarterIds = new Set(previous.starters.map((p) => p.playerId));
  const currStarterIds = new Set(current.starters.map((p) => p.playerId));

  const movedToBench = previous.starters.filter(
    (p) => !currStarterIds.has(p.playerId) && !transferredOutIds.has(p.playerId),
  );
  const movedIntoXi = current.starters.filter(
    (p) => !prevStarterIds.has(p.playerId) && !transferredInIds.has(p.playerId),
  );

  const prevCaptain = findName(prevPool, previous.captainId);
  const currCaptain = findName(currPool, current.captainId);
  const captain =
    previous.captainId !== current.captainId && prevCaptain && currCaptain
      ? { from: prevCaptain, to: currCaptain }
      : null;

  const prevVice = findName(prevPool, previous.viceCaptainId);
  const currVice = findName(currPool, current.viceCaptainId);
  const viceCaptain =
    previous.viceCaptainId !== current.viceCaptainId && prevVice && currVice
      ? { from: prevVice, to: currVice }
      : null;

  const benchOrderChanged =
    previous.bench.map((p) => p.playerId).join(',') !== current.bench.map((p) => p.playerId).join(',');

  return {
    previousEventId: previous.eventId,
    previousEventName: previous.eventName,
    captain,
    viceCaptain,
    movedIntoXi,
    movedToBench,
    benchOrderChanged,
    anyChange:
      captain !== null ||
      viceCaptain !== null ||
      movedIntoXi.length > 0 ||
      movedToBench.length > 0 ||
      benchOrderChanged ||
      transferredOutIds.size > 0,
  };
}

export interface TransferPlanSummary {
  playersOut: ProjectedPlayer[];
  playersIn: ProjectedPlayer[];
  hitsTaken: number;
  hitCost: number;
  /** This gameweek's swing from the current XI, after the hit - the same basis as a single
   *  TransferOption's netGain, so the two are directly comparable. */
  netGain: number;
  eleven: StartingEleven;
  totalCost: number;
  bankRemaining: number;
}

/**
 * Every priority fix applied at once, as one team you could actually field.
 *
 * The single-transfer cards each answer "what is the best use of one transfer?", costed as
 * though nothing else changed. That is the right question when you have one free transfer and
 * one problem. It is the wrong question when the squad has three dead slots: reading three
 * independent cards and doing all three leaves you guessing at what the resulting team looks
 * like and what the hits actually cost you.
 *
 * This applies them together, in sequence - each swap sees the bank and club counts the
 * previous one left behind, which is what really happens when you make several transfers -
 * and states the hit cost in full.
 */
export interface PriorityFixPlan {
  moves: { out: ProjectedPlayer; in: ProjectedPlayer }[];
  /** Dead slots left unfixed because nothing legal and affordable was available. */
  unresolved: ProjectedPlayer[];
  freeTransfers: number;
  /** Transfers beyond the free ones, and what they cost in points. */
  hitsTaken: number;
  hitCost: number;
  /** The XI as it stands now, and the XI after every fix - the honest before and after. */
  elevenBefore: StartingEleven;
  eleven: StartingEleven;
  /** This gameweek's swing before the hit is deducted. */
  gainBeforeHit: number;
  /** The discounted value of the run of fixtures after this gameweek, in's minus out's. */
  horizonGain: number;
  /** gainBeforeHit + horizonGain - hitCost. Negative means the hits are not worth paying. */
  netGain: number;
  totalCost: number;
  bankRemaining: number;
}

export interface Recommendation {
  mode: 'build-squad' | 'existing-squad';
  eventId: number;
  eventName: string | null;
  deadlineIso: string | null;
  modelVersion: string;
  generatedAt: number;

  squad: ProjectedPlayer[];
  eleven: StartingEleven;
  totalCost: number;
  bankRemaining: number;

  transfers: TransferOption[];
  /**
   * A whole-squad rebuild considered together, when it beats the best single transfer -
   * genuinely different players may only be affordable by changing more than one at once. Null
   * whenever the best plan found is the same as (or worse than) just picking the top single
   * option above, so this only ever appears when it adds something.
   */
  transferPlan: TransferPlanSummary | null;
  /**
   * The team you get by acting on every priority fix, with the hit cost stated. Null when the
   * squad has no dead slots, or when none of them has an affordable fix.
   */
  priorityFixPlan: PriorityFixPlan | null;
  /** What changed since the last recommendation, one gameweek back - null the first time. */
  previousComparison: RecommendationDiff | null;
  notes: string[];
  playersConsidered: number;
  lowConfidence: boolean;

  /** Where the evidence behind these projections came from. */
  evidence: {
    intelCompiledAt: string | null;
    intelSources: string[];
    intelApplied: number;
    intelUnmatched: string[];
    intelPriceMismatches: number;
    contextNotes: string[];
    eliteSampleSize: number;
    usingPreviousSeason: number;
    /** How many gameweeks transfers and captaincy were actually judged over. */
    horizonGameweeks: number;
  };
}

export interface RecommendOptions {
  eventId?: number;
  teamId?: number | null;
  /** Force building a squad from scratch even if one is loaded. */
  fromScratch?: boolean;
  budget?: number;
  solver?: Solver;
  /** How many candidates per position to consider for transfers. Keeps the search quick. */
  transferCandidates?: number;
  /** Curated intel. Pass null to ignore it entirely. Defaults to config/intel.json. */
  intel?: Intel | null;
  /** Surfaced verbatim in the returned notes, ahead of anything recommend() derives itself. */
  extraNotes?: string[];
}

interface EventRow {
  id: number;
  name: string | null;
  deadlineIso: string | null;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Hard requirements block generation; soft ones are informative signals. */
  required: boolean;
  detail: string;
}

export interface Readiness {
  checks: ReadinessCheck[];
  ready: boolean;
  missing: string[];
}

/**
 * Whether enough data exists to generate a team worth acting on.
 *
 * Generation is refused until this season's players, the fixtures for the target gameweek and
 * last season's history are all in - a projection built on a subset quietly degrades instead of
 * failing, which is worse. The curated-news and elite-picks signals are reported too, but as
 * soft checks: elite squads are structurally unavailable before the first gameweek starts, so
 * requiring them would make pre-season generation impossible.
 */
export function checkReadiness(db: Database): Readiness {
  const event = resolveTargetEvent(db);

  const playerCount = (db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n;
  const snapshotCount = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
  const fixtureCount = event
    ? (db.prepare('SELECT COUNT(*) AS n FROM fixture WHERE event_id = ?').get(event.id) as { n: number }).n
    : 0;
  const lastSeasonCount = (
    db.prepare('SELECT COUNT(*) AS n FROM player_season_history').get() as { n: number }
  ).n;

  const intel = loadIntel();
  const elite = latestEliteOwnership(db);

  const checks: ReadinessCheck[] = [
    {
      id: 'this-season',
      label: "This season's player data",
      ok: playerCount > 0 && snapshotCount > 0,
      required: true,
      detail:
        playerCount > 0
          ? `${playerCount} players imported`
          : 'Not imported yet - the Import Data tab explains where to get it',
    },
    {
      id: 'fixtures',
      label: `Fixtures for ${event?.name ?? 'the next gameweek'}`,
      ok: fixtureCount > 0,
      required: true,
      detail:
        fixtureCount > 0
          ? `${fixtureCount} fixture(s) for ${event?.name ?? 'the target gameweek'}`
          : 'No fixtures imported for the target gameweek',
    },
    {
      id: 'last-season',
      label: "Last season's stats",
      ok: lastSeasonCount > 0,
      required: true,
      detail:
        lastSeasonCount > 0
          ? `${lastSeasonCount} players with last-season history`
          : 'Not imported yet - without it, early-season projections rank on noise',
    },
    {
      id: 'news',
      label: 'Player and team news (curated notes)',
      ok: intel !== null,
      required: false,
      detail: intel
        ? `Curated notes compiled ${intel.compiledAt}: injury flags and elite-manager consensus from published FPL coverage`
        : 'No curated notes file present',
    },
    {
      id: 'elite',
      label: 'What top-ranked managers own',
      ok: elite.size > 0,
      required: false,
      detail:
        elite.size > 0
          ? `Sampled ownership for ${elite.size} players from top-ranked squads`
          : 'Squads are private until a gameweek has been played - until then the curated notes carry the elite-consensus signal',
    },
  ];

  const missing = checks.filter((check) => check.required && !check.ok).map((check) => check.label);
  return { checks, ready: missing.length === 0, missing };
}

/** The gameweek to advise on: the next one with a deadline still in the future. */
export function resolveTargetEvent(db: Database, eventId?: number): EventRow | null {
  if (eventId !== undefined) {
    return (
      (db
        .prepare('SELECT id, name, deadline_time_iso AS deadlineIso FROM event WHERE id = ?')
        .get(eventId) as EventRow | undefined) ?? null
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    (db
      .prepare(
        `SELECT id, name, deadline_time_iso AS deadlineIso FROM event
         WHERE deadline_time IS NOT NULL AND deadline_time > ?
         ORDER BY deadline_time ASC LIMIT 1`,
      )
      .get(now) as EventRow | undefined) ??
    (db
      .prepare(
        `SELECT id, name, deadline_time_iso AS deadlineIso FROM event
         ORDER BY id ASC LIMIT 1`,
      )
      .get() as EventRow | undefined) ??
    null
  );
}

/** The 15 currently owned, as projected players, or null when no squad is loaded. */
/**
 * A squad member whose pick could not be resolved against this gameweek's projections - the
 * player_snapshot they came from does not have an entry for that id, most likely because they
 * dropped out of a later bootstrap-static import. Reported so the caller can explain what
 * happened; the squad slot itself is filled by a zero-projected placeholder (see
 * `placeholderForUnresolvedPick`) rather than simply vanishing, so squad size and position
 * composition - which every downstream rules check assumes is exactly rules.squad.size - stay
 * correct, and the normal transfer machinery naturally flags the placeholder for replacement.
 */
export interface UnresolvedPick {
  playerId: number;
  name: string | null;
}

/**
 * Stand in for a squad member whose id is not in this gameweek's projections. Identity (name,
 * club, position) comes from the `player` table, which keeps every id ever seen even after a
 * later bootstrap-static import drops them; price falls back to their last known player_snapshot
 * price so the budget maths stays realistic. Marked excluded (like any unavailable player, e.g.
 * the existing "dead squad slot" case) so it can never be selected into the XI, but still counts
 * toward squad size and position composition like any other bench player.
 */
function placeholderForUnresolvedPick(db: Database, playerId: number): ProjectedPlayer | null {
  const identity = db
    .prepare(
      `SELECT p.web_name AS name, p.team_id AS clubId, t.short_name AS clubShort,
              pos.short_name AS position
       FROM player p
       JOIN team t ON t.id = p.team_id
       JOIN position pos ON pos.id = p.position_id
       WHERE p.id = ?`,
    )
    .get(playerId) as
    | { name: string; clubId: number; clubShort: string; position: string }
    | undefined;

  if (!identity) return null;

  const lastKnown = db
    .prepare(
      `SELECT now_cost AS price FROM player_snapshot WHERE player_id = ? ORDER BY snapshot_id DESC LIMIT 1`,
    )
    .get(playerId) as { price: number } | undefined;

  return {
    playerId,
    name: identity.name,
    clubId: identity.clubId,
    clubShort: identity.clubShort,
    position: identity.position,
    price: lastKnown?.price ?? 0,
    availability: {
      state: 'unavailable',
      probability: 0,
      reason: 'Not in the most recently imported player data',
      excluded: true,
    },
    xPts: 0,
    xPtsRaw: 0,
    breakdown: {},
    expectedMinutes: 0,
    confidence: 'low',
    reasons: [
      'Missing from the most recently imported player data, so nothing can be projected for ' +
        "them - re-import this season's player data to refresh this.",
    ],
    fixtures: [],
  };
}

function loadOwnedSquad(
  db: Database,
  teamId: number,
  projections: readonly ProjectedPlayer[],
): {
  squad: ProjectedPlayer[];
  bank: number | null;
  unresolved: UnresolvedPick[];
  asOfEventId: number | null;
} | null {
  // The latest manager_state row with at least one squad_pick - not just the latest row full
  // stop. ingestEntry() writes a manager_state snapshot on every refresh even when that
  // gameweek's picks are not retrievable yet (the API 404s right around a deadline, or briefly
  // lags behind entry.current_event flipping over), and that snapshot carries zero squad_pick
  // rows. Picking the latest row unconditionally would let that empty snapshot shadow a
  // perfectly good previous one and make a real, just-loaded squad vanish the moment the next
  // background refresh runs into that gap - exactly the "whole new team" bug this already broke
  // once. asOfEventId then correctly reports the last gameweek actually loaded, and the
  // known-stale note below explains why.
  const state = db
    .prepare(
      `SELECT ms.id, ms.bank, ms.event_id AS eventId FROM manager_state ms
       WHERE ms.entry_id = ? AND EXISTS (SELECT 1 FROM squad_pick sp WHERE sp.manager_state_id = ms.id)
       ORDER BY ms.captured_at DESC LIMIT 1`,
    )
    .get(teamId) as { id: number; bank: number | null; eventId: number | null } | undefined;

  if (!state) return null;

  const picks = db
    .prepare('SELECT player_id AS playerId FROM squad_pick WHERE manager_state_id = ? ORDER BY slot')
    .all(state.id) as { playerId: number }[];

  if (picks.length === 0) return null;

  const byId = new Map(projections.map((player) => [player.playerId, player]));
  const squad: ProjectedPlayer[] = [];
  const unresolved: UnresolvedPick[] = [];
  for (const pick of picks) {
    const player = byId.get(pick.playerId);
    if (player) {
      squad.push(player);
      continue;
    }
    // A handful of unresolved picks (a player who dropped out of the latest bootstrap-static
    // import) must not throw away the rest of a real, just-imported squad and silently fall
    // back to building a brand new team from scratch - that is far more surprising than a
    // squad with one placeholder slot and a clear note explaining what is missing.
    const placeholder = placeholderForUnresolvedPick(db, pick.playerId);
    if (placeholder) squad.push(placeholder);
    unresolved.push({ playerId: pick.playerId, name: placeholder?.name ?? null });
  }

  // Only genuinely nothing resolving at all - not even an id the `player` table has ever heard
  // of - counts as "no squad loaded".
  if (squad.length === 0) return null;

  return { squad, bank: state.bank, unresolved, asOfEventId: state.eventId };
}

/**
 * The squad plus chip history, for the chip advisor. Exported so chip advice and squad advice
 * always work from exactly the same view of the team.
 */
export function loadSquadForChips(
  db: Database,
  teamId: number | null | undefined,
  rules: Rules,
  weights: ModelWeights,
  eventId: number,
): { squad: ProjectedPlayer[] | undefined; chipsUsed: { name: string; event: number | null }[] } {
  if (!teamId) return { squad: undefined, chipsUsed: [] };

  const projections = buildProjections(db, eventId, rules, weights);
  const owned = loadOwnedSquad(db, teamId, projections);

  const state = db
    .prepare(
      'SELECT chips_used_json AS used FROM manager_state WHERE entry_id = ? ORDER BY captured_at DESC LIMIT 1',
    )
    .get(teamId) as { used: string | null } | undefined;

  let chipsUsed: { name: string; event: number | null }[] = [];
  if (state?.used) {
    try {
      chipsUsed = JSON.parse(state.used) as { name: string; event: number | null }[];
    } catch {
      chipsUsed = [];
    }
  }

  return { squad: owned?.squad, chipsUsed };
}

/**
 * Find the best single transfers.
 *
 * These are ranked ALTERNATIVES for a single transfer slot, not a bundle to make all at once -
 * each one is costed as if it were the only transfer made this gameweek. Making several of them
 * together would need that many free transfers (or hits on top), and several may even target
 * the same replacement, which is exactly why they cannot all be done together. The caller is
 * responsible for making that unambiguous to whoever reads the list.
 *
 * Each candidate swap is evaluated by re-solving the starting XI for the resulting squad, so
 * the gain reflects what would actually be fielded rather than a naive comparison of the two
 * players' projections - bringing in a good player who would sit on the bench is worth nothing.
 *
 * A dead squad slot (see weights.transfers.priorityFixXPtsThreshold) is guaranteed its best fix
 * in the result even when the raw point swing of fixing it ranks below a flashier upgrade
 * elsewhere - a squad member contributing nothing is worse than any single point total says, and
 * burying that fix under five better-ranked but non-urgent options would be actively misleading.
 */
async function findTransfers(
  squad: readonly ProjectedPlayer[],
  pool: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: {
    bank: number;
    freeTransfers: number;
    candidatesPerPosition: number;
    horizon: Horizon;
    captainConsistencyBonus: Map<number, number>;
  },
): Promise<{ options: TransferOption[]; unresolvedPriority: ProjectedPlayer[] }> {
  const selectionOptions = { captainConsistencyBonus: options.captainConsistencyBonus };
  const baseline = await selectBestEleven(squad, rules, weights, solver, selectionOptions);
  const ownedIds = new Set(squad.map((player) => player.playerId));
  const future = (playerId: number) => horizonFor(options.horizon, playerId).futureXPts;

  // Club counts, so a swap cannot break the three-per-club rule.
  const clubCounts = new Map<number, number>();
  for (const player of squad) clubCounts.set(player.clubId, (clubCounts.get(player.clubId) ?? 0) + 1);

  const byPosition = new Map<string, ProjectedPlayer[]>();
  for (const player of pool) {
    if (ownedIds.has(player.playerId) || player.availability.excluded) continue;
    const list = byPosition.get(player.position) ?? [];
    list.push(player);
    byPosition.set(player.position, list);
  }
  for (const [position, list] of byPosition) {
    // Ranked on this week's projection plus the discounted run of fixtures after it, so a
    // candidate having an average week ahead of three good ones is not pruned before it is
    // even considered.
    byPosition.set(
      position,
      list
        .sort((a, b) => b.xPts + future(b.playerId) - (a.xPts + future(a.playerId)))
        .slice(0, options.candidatesPerPosition),
    );
  }

  const results: TransferOption[] = [];
  const hitCost = options.freeTransfers >= 1 ? 0 : rules.transfers.hitCost;

  for (const out of squad) {
    const candidates = byPosition.get(out.position) ?? [];
    // Selling price is unknown from the public API, so current price is used as a proxy.
    const budgetForReplacement = options.bank + out.price;

    for (const incoming of candidates) {
      if (incoming.price > budgetForReplacement) continue;

      const clubCount = clubCounts.get(incoming.clubId) ?? 0;
      const adjusted = incoming.clubId === out.clubId ? clubCount - 1 : clubCount;
      if (adjusted >= rules.squad.maxPerClub) continue;

      const candidateSquad = squad.map((player) =>
        player.playerId === out.playerId ? incoming : player,
      );

      let eleven: StartingEleven;
      try {
        eleven = await selectBestEleven(candidateSquad, rules, weights, solver, selectionOptions);
      } catch {
        continue; // The swap leaves no legal XI.
      }

      // This week's precise swing from re-solving the whole XI, plus the discounted value of
      // the run of fixtures after it - a one-time hit only pays for itself once, but a good
      // transfer keeps paying off for as long as the player is held.
      const gainBeforeHit = eleven.expectedPoints - baseline.expectedPoints;
      const horizonGain = future(incoming.playerId) - future(out.playerId);
      const netGain = gainBeforeHit + horizonGain - hitCost;

      if (netGain <= 0) continue;

      const horizonNote =
        Math.abs(horizonGain) >= 0.1
          ? horizonGain > 0
            ? ` The run of fixtures after this gameweek adds a further +${horizonGain.toFixed(2)}.`
            : ` The run of fixtures after this gameweek trims ${Math.abs(horizonGain).toFixed(2)} off that, but it still holds up.`
          : '';

      const priority = out.xPts < weights.transfers.priorityFixXPtsThreshold;

      results.push({
        out,
        in: incoming,
        netGain: Math.round(netGain * 100) / 100,
        gainBeforeHit: Math.round(gainBeforeHit * 100) / 100,
        horizonGain: Math.round(horizonGain * 100) / 100,
        hitCost,
        priority,
        reason:
          (priority ? `${out.name} is barely projected to feature at all - ` : '') +
          `${incoming.name} (${incoming.clubShort}, £${(incoming.price / 10).toFixed(1)}m) projects ` +
          `${incoming.xPts.toFixed(2)} against ${out.name}'s ${out.xPts.toFixed(2)} this gameweek` +
          (hitCost > 0 ? `, and is worth it even after a -${hitCost} hit` : '') +
          `. ${out.availability.excluded ? `${out.name} cannot play: ${out.availability.reason}. ` : ''}` +
          `Net gain ${netGain >= 0 ? '+' : ''}${netGain.toFixed(2)} points.${horizonNote}`,
      });
    }
  }

  const sorted = results.sort((a, b) => b.netGain - a.netGain);

  // Every dead squad slot's single best fix, one per player, regardless of rank.
  const priorityOptions = new Map<number, TransferOption>();
  for (const option of sorted) {
    if (option.priority && !priorityOptions.has(option.out.playerId)) {
      priorityOptions.set(option.out.playerId, option);
    }
  }

  const rest = sorted.filter((option) => !priorityOptions.has(option.out.playerId));
  const shown = [...priorityOptions.values(), ...rest]
    .slice(0, Math.max(5, priorityOptions.size))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || b.netGain - a.netGain);

  // A dead slot with no affordable single-transfer fix at all - budget alone can rule every
  // candidate out (a keeper already at the price floor has nowhere cheaper to go). Reported so
  // the gap is an explicit, explained note rather than a silent omission.
  const unresolvedPriority = squad.filter(
    (player) =>
      player.xPts < weights.transfers.priorityFixXPtsThreshold && !priorityOptions.has(player.playerId),
  );

  return { options: shown, unresolvedPriority };
}

/**
 * Apply every priority fix to the squad at once and report the team that results.
 *
 * Sequential, not independent: each swap is chosen against the bank and club counts left by the
 * previous one. Doing otherwise would let two fixes each spend the same pound, or each be the
 * third player from the same club, and produce a "team" that cannot legally be entered.
 *
 * Replacements are ranked on this gameweek plus the discounted run of fixtures after it, the
 * same basis as the single-transfer cards, so a fix is not chosen for one good week alone.
 * The worst dead slot goes first, on the grounds that if the money runs out it should run out
 * on the least broken slot rather than the most.
 *
 * The hit cost is charged against the whole plan at the end, never against an individual swap:
 * with two free transfers, three fixes cost one hit, and which of the three you call "the paid
 * one" is meaningless.
 */
async function buildPriorityFixPlan(
  squad: readonly ProjectedPlayer[],
  pool: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: {
    bank: number;
    freeTransfers: number;
    candidatesPerPosition: number;
    horizon: Horizon;
    captainConsistencyBonus: Map<number, number>;
    elevenBefore: StartingEleven;
  },
): Promise<PriorityFixPlan | null> {
  const threshold = weights.transfers.priorityFixXPtsThreshold;
  const deadSlots = squad
    .filter((player) => player.xPts < threshold)
    .sort((a, b) => a.xPts - b.xPts);
  if (deadSlots.length === 0) return null;

  const selectionOptions = { captainConsistencyBonus: options.captainConsistencyBonus };
  const future = (playerId: number) => horizonFor(options.horizon, playerId).futureXPts;

  let current: ProjectedPlayer[] = [...squad];
  let bank = options.bank;
  const owned = new Set(squad.map((player) => player.playerId));
  const clubCounts = new Map<number, number>();
  for (const player of squad) clubCounts.set(player.clubId, (clubCounts.get(player.clubId) ?? 0) + 1);

  const moves: { out: ProjectedPlayer; in: ProjectedPlayer }[] = [];
  const unresolved: ProjectedPlayer[] = [];

  for (const out of deadSlots) {
    const budget = bank + out.price;
    const candidates = pool
      .filter(
        (player) =>
          player.position === out.position &&
          !owned.has(player.playerId) &&
          !player.availability.excluded &&
          player.price <= budget &&
          player.xPts >= threshold,
      )
      .sort((a, b) => b.xPts + future(b.playerId) - (a.xPts + future(a.playerId)))
      .slice(0, options.candidatesPerPosition);

    let chosen: ProjectedPlayer | null = null;
    for (const incoming of candidates) {
      const held = clubCounts.get(incoming.clubId) ?? 0;
      const adjusted = incoming.clubId === out.clubId ? held - 1 : held;
      if (adjusted >= rules.squad.maxPerClub) continue;
      chosen = incoming;
      break;
    }

    if (chosen === null) {
      unresolved.push(out);
      continue;
    }

    current = current.map((player) => (player.playerId === out.playerId ? chosen! : player));
    bank = bank + out.price - chosen.price;
    owned.delete(out.playerId);
    owned.add(chosen.playerId);
    clubCounts.set(out.clubId, (clubCounts.get(out.clubId) ?? 1) - 1);
    clubCounts.set(chosen.clubId, (clubCounts.get(chosen.clubId) ?? 0) + 1);
    moves.push({ out, in: chosen });
  }

  if (moves.length === 0) return null;

  let eleven: StartingEleven;
  try {
    eleven = await selectBestEleven(current, rules, weights, solver, selectionOptions);
  } catch {
    // The fixed squad has no legal XI. Better to say nothing than to show an unfieldable team.
    return null;
  }

  const hitsTaken = Math.max(0, moves.length - options.freeTransfers);
  const hitCost = hitsTaken * rules.transfers.hitCost;
  const gainBeforeHit =
    Math.round((eleven.expectedPoints - options.elevenBefore.expectedPoints) * 100) / 100;
  const horizonGain =
    Math.round(
      moves.reduce((sum, move) => sum + future(move.in.playerId) - future(move.out.playerId), 0) *
        100,
    ) / 100;

  return {
    moves,
    unresolved,
    freeTransfers: options.freeTransfers,
    hitsTaken,
    hitCost,
    elevenBefore: options.elevenBefore,
    eleven,
    gainBeforeHit,
    horizonGain,
    netGain: Math.round((gainBeforeHit + horizonGain - hitCost) * 100) / 100,
    totalCost: current.reduce((sum, player) => sum + player.price, 0),
    bankRemaining: bank,
  };
}

/**
 * Produce a full recommendation for a gameweek.
 *
 * With a squad loaded, this optimises the XI and suggests transfers. Without one - which is the
 * normal state before a season's first deadline - it builds the best legal 15 from scratch,
 * which is the season-start and wildcard problem.
 */
export async function recommend(
  db: Database,
  rules: Rules,
  weights: ModelWeights,
  options: RecommendOptions = {},
): Promise<Recommendation> {
  const solver = options.solver ?? new GlpkSolver();
  const notes: string[] = [...(options.extraNotes ?? [])];

  const event = resolveTargetEvent(db, options.eventId);
  if (!event) {
    throw new Error(
      'No gameweeks are stored yet. Run `fpl ingest` first so the fixture list and deadlines are known.',
    );
  }

  const rawProjections = buildProjections(db, event.id, rules, weights);
  if (rawProjections.length === 0) {
    throw new Error(
      'No player data stored yet. Run `fpl ingest` before asking for a recommendation.',
    );
  }

  // Curated pre-season notes, then what elite managers actually own. Both are evidence the
  // FPL API cannot give us; both are applied transparently and recorded in the output.
  const intel = options.intel === undefined ? loadIntel() : options.intel;
  const intelResult = applyIntel(rawProjections, intel, event.id);
  if (intelResult.skippedReason) notes.push(intelResult.skippedReason);
  if (intelResult.priceMismatches.length > 0) {
    notes.push(
      `${intelResult.priceMismatches.length} curated note(s) were withheld because the ` +
        'researched price no longer matches the live price - the note is stale, or it matched ' +
        'the wrong player: ' +
        intelResult.priceMismatches
          .map(
            (m) =>
              `${m.name} researched at £${(m.expected / 10).toFixed(1)}m, live £${(m.actual / 10).toFixed(1)}m`,
          )
          .join('; '),
    );
  }
  if (intelResult.unmatched.length > 0) {
    notes.push(
      `${intelResult.unmatched.length} curated note(s) matched no player and were ignored: ` +
        `${intelResult.unmatched.slice(0, 5).join('; ')}` +
        (intelResult.unmatched.length > 5 ? ' ...' : ''),
    );
  }

  // What top-ranked managers actually own, once their squads are public. Real evidence of
  // "what good players are doing", so it moves the projection itself - not just a footnote -
  // bounded and one-directional: elite ownership is a vote of confidence, but the absence of
  // it this early (before a gameweek starts) is not evidence against a player.
  const elite = latestEliteOwnership(db);
  const projections = intelResult.players.map((player) => {
    const owned = elite.get(player.playerId);
    if (!owned) return player;

    const captainShare = owned.managers > 0 ? owned.captainedBy / owned.managers : 0;
    const adjustment = Math.min(
      weights.eliteOwnership.maxAdjustment,
      owned.ownership * weights.eliteOwnership.weight + captainShare * weights.eliteOwnership.captainWeight,
    );

    const raw = player.xPtsRaw + adjustment;
    const xPts = player.availability.excluded ? 0 : raw * player.availability.probability;

    return {
      ...player,
      xPtsRaw: round(raw),
      xPts: round(Math.max(0, xPts)),
      breakdown: { ...player.breakdown, eliteOwnership: round(adjustment) },
      reasons: [
        ...player.reasons,
        `Owned by ${Math.round(owned.ownership * 100)}% of the top ${owned.managers} managers` +
          (owned.captainedBy > 0 ? `, captained by ${owned.captainedBy} of them` : '') +
          ` (+${adjustment.toFixed(2)} xPts).`,
      ],
    };
  });

  saveProjections(db, projections, event.id, weights.modelVersion);

  // A run of upcoming gameweeks, not just this one: a transfer keeps paying off for as long as
  // it is held, and a captain is more trustworthy when this week is not a one-off spike. Both
  // get a bounded lens across the horizon on top of the primary, single-gameweek projection.
  const horizon = computeHorizon(db, rules, weights, event.id, weights.horizon.length);
  const captainConsistencyBonus = captainConsistencyBonusFor(
    projections.map((player) => player.playerId),
    horizon,
    weights,
  );
  // Building a squad from scratch is a multi-week commitment - who you end up owning should
  // reflect the run of fixtures ahead, not just this gameweek. An existing squad's transfers
  // already get this via findTransfers; this is the same idea applied to the initial 15.
  const futureValueBonus = new Map(
    projections.map((player) => [player.playerId, horizonFor(horizon, player.playerId).futureXPts]),
  );
  // A squad with no regard for an approaching double gameweek would neglect its bench right up
  // until the week it would be worth boosting - so a fresh squad build relaxes the bench
  // discount slightly when one sits within the horizon.
  const benchBoostRelief = benchBoostPull(horizon, weights);
  const benchBoostGameweek = bestBenchBoostGameweek(horizon);
  if (benchBoostGameweek) {
    notes.push(
      `${benchBoostGameweek.name ?? `Gameweek ${benchBoostGameweek.eventId}`} has ` +
        `${benchBoostGameweek.doubleClubCount} club(s) playing twice - a Bench Boost candidate. ` +
        "A from-scratch squad build keeps a slightly stronger bench with that in mind; it doesn't " +
        'change transfer or captaincy suggestions for an existing squad.',
    );
  }
  const horizonWithFixtures = horizon.gameweeks.filter((gw) => gw.fixtureCount > 0).length;
  if (horizonWithFixtures < weights.horizon.length) {
    notes.push(
      `Only ${horizonWithFixtures} gameweek(s) ahead have fixtures imported, so transfers and ` +
        `captaincy are judged over that instead of the usual ${weights.horizon.length}. The ` +
        "FPL fixtures file normally carries the whole season, so re-importing it - it's a " +
        'single request - usually fills this in.',
    );
  }

  const withFixtures = projections.filter((player) => player.xPts > 0);
  if (withFixtures.length === 0) {
    notes.push(
      `No club has a fixture in ${event.name ?? `gameweek ${event.id}`}, so every projection is zero.`,
    );
  }

  const lowConfidence =
    projections.filter((player) => player.confidence === 'low').length > projections.length / 2;
  if (lowConfidence) {
    notes.push(
      'Most projections are low confidence because the season has little or no match history ' +
        "yet. Early-gameweek advice leans on the FPL API's own expected-points figures and " +
        'fixture difficulty rather than form.',
    );
  }

  const evidence = {
    intelCompiledAt: intel?.compiledAt ?? null,
    intelSources: intel?.sources ?? [],
    intelApplied: intelResult.applied.length,
    intelUnmatched: intelResult.unmatched,
    intelPriceMismatches: intelResult.priceMismatches.length,
    contextNotes: intel && !intelResult.skippedReason ? intel.contextNotes : [],
    eliteSampleSize: elite.size,
    usingPreviousSeason: projections.filter((p) =>
      p.reasons.some((r) => r.includes('Rates are from')),
    ).length,
    horizonGameweeks: horizon.gameweeks.length,
  };

  if (elite.size === 0) {
    notes.push(
      'No elite-manager ownership sampled yet. Squads only become public once a gameweek has ' +
        'started, so before the first deadline this relies on the curated notes instead.',
    );
  }

  const owned = options.teamId ? loadOwnedSquad(db, options.teamId, projections) : null;

  if (owned && owned.asOfEventId !== null && owned.asOfEventId < event.id) {
    notes.push(
      `Your squad shown here is as of Gameweek ${owned.asOfEventId} - your last completed ` +
        `gameweek, not Gameweek ${event.id}. FPL keeps squads private until a gameweek's own ` +
        "deadline passes, even from this app's own automatic pull, so if you've made transfers " +
        `for the upcoming gameweek since then, they will not show here until ` +
        `${event.deadlineIso ? `the ${event.deadlineIso} deadline` : "that gameweek's deadline"} ` +
        'passes - that is a genuine FPL platform restriction, not a bug in this app.',
    );
  }

  if (owned && owned.unresolved.length > 0) {
    const names = owned.unresolved.map((pick) => pick.name ?? `player #${pick.playerId}`);
    notes.push(
      `${names.length === 1 ? '1 player' : `${names.length} players`} from your imported squad ` +
        `(${names.join(', ')}) could not be matched to this gameweek's data - they are kept as a ` +
        `zero-projected placeholder below so the rest of your real squad is still used, rather ` +
        'than building a fresh team from scratch, and should show up as a priority transfer to ' +
        "fix. Re-import this season's player data, then your squad, to clear this.",
    );
  }

  if (!owned || options.fromScratch) {
    if (!owned && options.teamId) {
      notes.push(
        'No squad is loaded, so this is the best legal 15 built from scratch within the budget. ' +
          'Before a season\'s first deadline the FPL API does not expose your picks, so there is ' +
          'nothing to load yet.',
      );
    }

    const selection = await selectBestSquad(projections, rules, weights, solver, {
      budget: options.budget,
      captainConsistencyBonus,
      futureValueBonus,
      benchBoostPull: benchBoostRelief,
    });

    saveRecommendation(db, {
      eventId: event.id,
      entryId: options.teamId ?? null,
      kind: 'squad',
      modelVersion: weights.modelVersion,
      summary:
        `Built a squad from scratch: ${selection.eleven.formation}, ` +
        `${selection.eleven.expectedPoints.toFixed(1)} projected points`,
      detail: {
        starters: selection.eleven.starters.map((p) => ({ playerId: p.playerId, name: p.name, xPts: p.xPts })),
        bench: selection.eleven.bench.map((p) => ({ playerId: p.playerId, name: p.name, xPts: p.xPts })),
        captainId: selection.eleven.captain.playerId,
        viceCaptainId: selection.eleven.viceCaptain.playerId,
        squad: selection.squad.map((p) => ({ playerId: p.playerId, position: p.position })),
        formation: selection.eleven.formation,
      },
      dataTakenAt: null,
    });

    return {
      mode: 'build-squad',
      eventId: event.id,
      eventName: event.name,
      deadlineIso: event.deadlineIso,
      modelVersion: weights.modelVersion,
      generatedAt: Math.floor(Date.now() / 1000),
      squad: selection.squad,
      eleven: selection.eleven,
      totalCost: selection.totalCost,
      bankRemaining: selection.bankRemaining,
      transfers: [],
      // No existing squad to rebuild from, or diff against, or an earlier recommendation to
      // compare with.
      transferPlan: null,
      priorityFixPlan: null,
      previousComparison: null,
      notes,
      playersConsidered: projections.length,
      lowConfidence,
      evidence,
    };
  }

  const eleven = await selectBestEleven(owned.squad, rules, weights, solver, {
    captainConsistencyBonus,
  });

  const bank = owned.bank ?? 0;
  if (owned.bank === null) {
    notes.push('Bank balance is unknown, so transfer suggestions assume nothing spare is available.');
  }
  notes.push(
    'Selling prices are not published by the FPL API, so transfer affordability uses current ' +
      'price as a proxy. Check the real selling price on the FPL site before acting.',
  );

  const freeTransfers =
    (db
      .prepare(
        'SELECT free_transfers AS ft FROM manager_state WHERE entry_id = ? ORDER BY captured_at DESC LIMIT 1',
      )
      .get(options.teamId!) as { ft: number | null } | undefined)?.ft ?? 1;

  const { options: transfers, unresolvedPriority } = await findTransfers(
    owned.squad,
    projections,
    rules,
    weights,
    solver,
    {
      bank,
      freeTransfers,
      candidatesPerPosition: options.transferCandidates ?? 12,
      horizon,
      captainConsistencyBonus,
    },
  );

  if (transfers.length === 0) {
    notes.push('No single transfer improves the projected score enough to be worth making.');
  }
  if (transfers.some((t) => t.priority)) {
    notes.push(
      `Below is a ranked list of alternative transfers, costed as if each were the only one ` +
        `made - not a bundle to do all at once. Make at most ${freeTransfers} for free` +
        (freeTransfers < 5 ? `; anything beyond that costs ${rules.transfers.hitCost} points each` : '') +
        `. Options marked as fixing a squad member barely projected to feature are shown ` +
        `regardless of rank, because leaving that slot empty is worse than any point total says.`,
    );
  }
  for (const player of unresolvedPriority) {
    notes.push(
      `${player.name} is projected at only ${player.xPts.toFixed(2)} points this gameweek, but no ` +
        `single transfer within your budget (£${(bank / 10).toFixed(1)}m spare) fixes it - the ` +
        'replacements that would are all priced above what selling just this one player affords. ' +
        'Freeing up funds by downgrading elsewhere first, or accepting a hit, may be the only way.',
    );
  }

  // Purely informational timing context on the top non-priority transfer - never a
  // recommendation to wait, never a scoring change. A priority fix (a dead squad slot) never
  // gets this note: there is no case for delaying a genuinely urgent fix.
  const topNonPriority = transfers.find((transfer) => !transfer.priority);
  if (topNonPriority) {
    const timingNote = transferTimingNoteFor(topNonPriority.in, horizon, weights);
    if (timingNote) notes.push(timingNote);
  }

  const totalCost = owned.squad.reduce((sum, player) => sum + player.price, 0);

  // Every priority fix applied together, as one fieldable team with its hit cost stated. The
  // single-transfer cards above answer "what is the best use of one transfer?"; this answers
  // "what does my team look like if I fix everything that is broken, and what does that cost?",
  // which is a different question and not one you can answer by reading three cards at once.
  const priorityFixPlan = await buildPriorityFixPlan(owned.squad, projections, rules, weights, solver, {
    bank,
    freeTransfers,
    candidatesPerPosition: options.transferCandidates ?? 12,
    horizon,
    captainConsistencyBonus,
    elevenBefore: eleven,
  });

  if (priorityFixPlan) {
    notes.push(
      `Fixing all ${priorityFixPlan.moves.length} dead squad slot(s) at once needs ` +
        `${priorityFixPlan.moves.length} transfer(s) against ${freeTransfers} free, so it costs ` +
        `${priorityFixPlan.hitCost} points in hits and nets ` +
        `${priorityFixPlan.netGain >= 0 ? '+' : ''}${priorityFixPlan.netGain.toFixed(2)} after that. ` +
        (priorityFixPlan.netGain < 0
          ? 'That is negative: the hits cost more than the fixes gain over the horizon, so ' +
            'spreading them across several gameweeks is the better play. The team is shown so ' +
            'you can see exactly what you would be paying for.'
          : 'See "Your team with every priority fix" below.'),
    );
  }

  // A whole-squad rebuild, considered together rather than one swap at a time - the only way
  // to find a player who is only affordable by trimming two or three others to fund them.
  // "Selling price" is the same current-price proxy used everywhere else in this app.
  let transferPlan: TransferPlanSummary | null = null;
  try {
    const plan = await selectBestTransferPlan(projections, owned.squad, rules, weights, solver, {
      totalBudget: totalCost + bank,
      freeTransfers,
      hitCost: rules.transfers.hitCost,
      captainConsistencyBonus,
      futureValueBonus,
      benchBoostPull: benchBoostRelief,
    });

    const netGain =
      Math.round((plan.eleven.expectedPoints - eleven.expectedPoints - plan.hitCost) * 100) / 100;
    const bestSingleNetGain = transfers[0]?.netGain ?? 0;

    // Surfaced only when it involves more than one change AND genuinely beats the best single
    // option above - otherwise it is either the same advice already shown, or worse.
    if (plan.transfersOut.length > 1 && netGain > bestSingleNetGain) {
      transferPlan = {
        playersOut: plan.transfersOut,
        playersIn: plan.transfersIn,
        hitsTaken: plan.hitsTaken,
        hitCost: plan.hitCost,
        netGain,
        eleven: plan.eleven,
        totalCost: plan.totalCost,
        bankRemaining: plan.bankRemaining,
      };
      notes.push(
        `A ${plan.transfersOut.length}-player squad rebuild nets +${netGain.toFixed(2)} points ` +
          `after ${plan.hitsTaken > 0 ? `a -${plan.hitCost} hit` : 'no hit'} - more than any ` +
          `single transfer above manages alone, because ${plan.transfersIn.map((p) => p.name).join(', ')} ` +
          `${plan.transfersIn.length > 1 ? 'are' : 'is'} only affordable by changing more than one ` +
          `player at once. See "Squad rebuild worth considering" below.`,
      );
    }
  } catch (cause) {
    notes.push(
      `Could not evaluate a multi-transfer squad rebuild (${(cause as Error).message}) - the ` +
        'single-transfer options above still stand on their own.',
    );
  }

  const previousComparison = diffAgainstPrevious(
    {
      starters: eleven.starters.map((p) => ({ playerId: p.playerId, name: p.name })),
      bench: eleven.bench.map((p) => ({ playerId: p.playerId, name: p.name })),
      captainId: eleven.captain.playerId,
      viceCaptainId: eleven.viceCaptain.playerId,
    },
    new Set(transfers.map((t) => t.out.playerId)),
    new Set(transfers.map((t) => t.in.playerId)),
    previousRecommendationDetail(db, event.id, options.teamId ?? null),
  );

  saveRecommendation(db, {
    eventId: event.id,
    entryId: options.teamId ?? null,
    kind: 'xi',
    modelVersion: weights.modelVersion,
    summary:
      `${eleven.formation}, ${eleven.expectedPoints.toFixed(1)} projected points, ` +
      `captain ${eleven.captain.name}` +
      (transfers.length > 0 ? `, ${transfers.length} transfer(s) suggested` : ''),
    detail: {
      starters: eleven.starters.map((p) => ({ playerId: p.playerId, name: p.name, xPts: p.xPts })),
      bench: eleven.bench.map((p) => ({ playerId: p.playerId, name: p.name, xPts: p.xPts })),
      captainId: eleven.captain.playerId,
      viceCaptainId: eleven.viceCaptain.playerId,
      squad: owned.squad.map((p) => ({ playerId: p.playerId, position: p.position })),
      formation: eleven.formation,
      transfers: transfers.map((t) => ({ out: t.out.name, in: t.in.name, netGain: t.netGain })),
    },
    dataTakenAt: null,
  });

  return {
    mode: 'existing-squad',
    eventId: event.id,
    eventName: event.name,
    deadlineIso: event.deadlineIso,
    modelVersion: weights.modelVersion,
    generatedAt: Math.floor(Date.now() / 1000),
    squad: owned.squad,
    eleven,
    totalCost,
    bankRemaining: bank,
    transfers,
    transferPlan,
    priorityFixPlan,
    previousComparison,
    notes,
    playersConsidered: projections.length,
    lowConfidence,
    evidence,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
