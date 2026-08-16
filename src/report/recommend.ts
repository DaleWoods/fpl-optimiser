import type { Database } from 'better-sqlite3';
import type { ModelWeights, Rules } from '../config/schema.js';
import type { ProjectedPlayer, StartingEleven } from '../domain/types.js';
import { latestEliteOwnership } from '../ingest/elite.js';
import { buildProjections, saveProjections } from '../model/build.js';
import { applyIntel, loadIntel, type Intel } from '../model/intel.js';
import { saveRecommendation } from '../model/accuracy.js';
import { GlpkSolver } from '../optimise/glpkSolver.js';
import type { Solver } from '../optimise/solver.js';
import { selectBestEleven, selectBestSquad } from '../optimise/squad.js';

export interface TransferOption {
  out: ProjectedPlayer;
  in: ProjectedPlayer;
  /** Change in expected points for the gameweek, after any hit. */
  netGain: number;
  gainBeforeHit: number;
  hitCost: number;
  reason: string;
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
function loadOwnedSquad(
  db: Database,
  teamId: number,
  projections: readonly ProjectedPlayer[],
): { squad: ProjectedPlayer[]; bank: number | null } | null {
  const state = db
    .prepare(
      `SELECT id, bank FROM manager_state WHERE entry_id = ? ORDER BY captured_at DESC LIMIT 1`,
    )
    .get(teamId) as { id: number; bank: number | null } | undefined;

  if (!state) return null;

  const picks = db
    .prepare('SELECT player_id AS playerId FROM squad_pick WHERE manager_state_id = ? ORDER BY slot')
    .all(state.id) as { playerId: number }[];

  if (picks.length === 0) return null;

  const byId = new Map(projections.map((player) => [player.playerId, player]));
  const squad = picks
    .map((pick) => byId.get(pick.playerId))
    .filter((player): player is ProjectedPlayer => player !== undefined);

  return squad.length === picks.length ? { squad, bank: state.bank } : null;
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
 * Each candidate swap is evaluated by re-solving the starting XI for the resulting squad, so
 * the gain reflects what would actually be fielded rather than a naive comparison of the two
 * players' projections - bringing in a good player who would sit on the bench is worth nothing.
 */
async function findTransfers(
  squad: readonly ProjectedPlayer[],
  pool: readonly ProjectedPlayer[],
  rules: Rules,
  weights: ModelWeights,
  solver: Solver,
  options: { bank: number; freeTransfers: number; candidatesPerPosition: number },
): Promise<TransferOption[]> {
  const baseline = await selectBestEleven(squad, rules, weights, solver);
  const ownedIds = new Set(squad.map((player) => player.playerId));

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
    byPosition.set(
      position,
      list.sort((a, b) => b.xPts - a.xPts).slice(0, options.candidatesPerPosition),
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
        eleven = await selectBestEleven(candidateSquad, rules, weights, solver);
      } catch {
        continue; // The swap leaves no legal XI.
      }

      const gainBeforeHit = eleven.expectedPoints - baseline.expectedPoints;
      const netGain = gainBeforeHit - hitCost;

      if (netGain <= 0) continue;

      results.push({
        out,
        in: incoming,
        netGain: Math.round(netGain * 100) / 100,
        gainBeforeHit: Math.round(gainBeforeHit * 100) / 100,
        hitCost,
        reason:
          `${incoming.name} (${incoming.clubShort}, £${(incoming.price / 10).toFixed(1)}m) projects ` +
          `${incoming.xPts.toFixed(2)} against ${out.name}'s ${out.xPts.toFixed(2)}` +
          (hitCost > 0 ? `, and is worth it even after a -${hitCost} hit` : '') +
          `. ${out.availability.excluded ? `${out.name} cannot play: ${out.availability.reason}. ` : ''}` +
          `Net gain ${netGain >= 0 ? '+' : ''}${netGain.toFixed(2)} points this gameweek.`,
      });
    }
  }

  return results.sort((a, b) => b.netGain - a.netGain).slice(0, 5);
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
  const notes: string[] = [];

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
  };

  if (elite.size === 0) {
    notes.push(
      'No elite-manager ownership sampled yet. Squads only become public once a gameweek has ' +
        'started, so before the first deadline this relies on the curated notes instead.',
    );
  }

  const owned = options.teamId ? loadOwnedSquad(db, options.teamId, projections) : null;

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
      notes,
      playersConsidered: projections.length,
      lowConfidence,
      evidence,
    };
  }

  const eleven = await selectBestEleven(owned.squad, rules, weights, solver);

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

  const transfers = await findTransfers(owned.squad, projections, rules, weights, solver, {
    bank,
    freeTransfers,
    candidatesPerPosition: options.transferCandidates ?? 12,
  });

  if (transfers.length === 0) {
    notes.push('No single transfer improves the projected score enough to be worth making.');
  }

  const totalCost = owned.squad.reduce((sum, player) => sum + player.price, 0);

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
    notes,
    playersConsidered: projections.length,
    lowConfidence,
    evidence,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
