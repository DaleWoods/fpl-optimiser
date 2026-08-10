import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR, ConfigError, stripComments } from '../config/load.js';
import type { Availability } from '../domain/availability.js';
import type { ProjectedPlayer } from '../domain/types.js';

/**
 * Hand-curated pre-season intelligence: what informed people are saying, written down where it
 * can be reviewed.
 *
 * The app has no way to read the web - it can only call the FPL API - so anything from
 * journalism or community consensus must be brought in deliberately and dated. Keeping it in
 * config rather than code means it is reviewable, diffable, and switchable off.
 *
 * Two hard limits on what this file is allowed to do:
 *  - It can only make a player LESS available, never more. If the API says a player is injured,
 *    no note here can override that.
 *  - Its expected-points adjustment is a nudge applied after the model, never a gate. It cannot
 *    put an illegal or unavailable player into a squad, because the rules engine runs afterwards.
 */

const flagSchema = z.looseObject({
  webName: z.string().min(1),
  club: z.string().min(1),
  state: z.enum(['available', 'doubtful', 'injured', 'suspended', 'unavailable']),
  probability: z.number().min(0).max(1),
  note: z.string(),
});

const consensusSchema = z.looseObject({
  webName: z.string().min(1),
  club: z.string().min(1),
  position: z.string().optional(),
  expectedPrice: z.number().int().positive().optional(),
  consensus: z.number().min(0).max(1),
  note: z.string(),
});

export const intelSchema = z.looseObject({
  compiledAt: z.string(),
  season: z.string(),
  staleAfterGameweek: z.number().int().positive(),
  sources: z.array(z.string()),
  weights: z.looseObject({
    eliteConsensusWeight: z.number().min(0),
    availabilityOverridesEnabled: z.boolean(),
  }),
  eliteConsensus: z.array(consensusSchema),
  availabilityFlags: z.array(flagSchema),
  contextNotes: z.array(z.string()),
});

export type Intel = z.infer<typeof intelSchema>;

export function loadIntel(dir: string = CONFIG_DIR): Intel | null {
  const path = resolve(dir, 'intel.json');
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }

  const parsed = intelSchema.safeParse(stripComments(raw));
  if (!parsed.success) {
    throw new ConfigError(
      `${path} failed validation:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

/** Normalise a name for matching: case and accents vary between sources. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim();
}

export interface IntelApplication {
  players: ProjectedPlayer[];
  /** Entries that matched no player. Reported rather than silently dropped. */
  unmatched: string[];
  applied: { playerId: number; name: string; kind: 'consensus' | 'availability'; note: string }[];
  /**
   * Entries whose researched price disagrees with the live price. Either the note is out of
   * date, or it matched the wrong player. Both are reasons to distrust it.
   */
  priceMismatches: {
    name: string;
    expected: number;
    actual: number;
  }[];
  skippedReason: string | null;
}

/**
 * How far a researched price may drift from the live price before the note is suspect,
 * in tenths of a million. Prices move by 0.1m at a time in-season, so anything beyond a few
 * notches means the curated entry is stale or matched to the wrong player.
 */
export const PRICE_TOLERANCE = 5;

/**
 * Apply the curated intel to a set of projections.
 *
 * Returns a new list; nothing is mutated. Unmatched entries are surfaced so a rename in the
 * FPL data cannot quietly turn an injury flag into a no-op.
 */
export function applyIntel(
  players: readonly ProjectedPlayer[],
  intel: Intel | null,
  eventId: number,
): IntelApplication {
  if (!intel) {
    return {
      players: [...players],
      unmatched: [],
      applied: [],
      priceMismatches: [],
      skippedReason: null,
    };
  }

  if (eventId > intel.staleAfterGameweek) {
    return {
      players: [...players],
      unmatched: [],
      applied: [],
      priceMismatches: [],
      skippedReason:
        `Curated pre-season notes are not applied after gameweek ${intel.staleAfterGameweek} - ` +
        'by then the API has real data for this season and that is a better guide.',
    };
  }

  const byKey = new Map<string, ProjectedPlayer[]>();
  for (const player of players) {
    const key = `${normaliseName(player.name)}|${player.clubShort.toLowerCase()}`;
    const list = byKey.get(key) ?? [];
    list.push(player);
    byKey.set(key, list);
  }

  const find = (webName: string, club: string): ProjectedPlayer | undefined => {
    const exact = byKey.get(`${normaliseName(webName)}|${club.toLowerCase()}`);
    if (exact?.length === 1) return exact[0];
    // Fall back to a unique name match across all clubs, in case a player moved.
    const matches = players.filter((p) => normaliseName(p.name) === normaliseName(webName));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const adjustments = new Map<number, { xPts: number; availability?: Availability; reasons: string[] }>();
  const unmatched: string[] = [];
  const applied: IntelApplication['applied'] = [];
  const priceMismatches: IntelApplication['priceMismatches'] = [];

  if (intel.weights.availabilityOverridesEnabled) {
    for (const flag of intel.availabilityFlags) {
      const player = find(flag.webName, flag.club);
      if (!player) {
        unmatched.push(`${flag.webName} (${flag.club}) - availability flag`);
        continue;
      }
      // Only ever downgrade. The API stays the authority on who is fit.
      if (flag.probability >= player.availability.probability) continue;

      const entry = adjustments.get(player.playerId) ?? { xPts: 0, reasons: [] };
      entry.availability = {
        state: flag.state,
        probability: flag.probability,
        reason: `${flag.note} (curated ${intel.compiledAt})`,
        excluded: flag.probability <= 0,
      };
      entry.reasons.push(`Availability reduced from curated notes: ${flag.note}`);
      adjustments.set(player.playerId, entry);
      applied.push({ playerId: player.playerId, name: player.name, kind: 'availability', note: flag.note });
    }
  }

  if (intel.weights.eliteConsensusWeight > 0) {
    for (const pick of intel.eliteConsensus) {
      const player = find(pick.webName, pick.club);
      if (!player) {
        unmatched.push(`${pick.webName} (${pick.club}) - elite consensus`);
        continue;
      }
      // Cross-check the researched price against the live one. This is the cheapest available
      // test that a curated note still describes reality: a price that has moved several
      // notches means the note is stale, and a wildly different price means it matched the
      // wrong player entirely. Either way the adjustment is withheld rather than trusted.
      if (pick.expectedPrice !== undefined && Math.abs(pick.expectedPrice - player.price) > PRICE_TOLERANCE) {
        priceMismatches.push({
          name: `${pick.webName} (${pick.club})`,
          expected: pick.expectedPrice,
          actual: player.price,
        });
        continue;
      }

      const bonus = intel.weights.eliteConsensusWeight * pick.consensus;
      const entry = adjustments.get(player.playerId) ?? { xPts: 0, reasons: [] };
      entry.xPts += bonus;
      entry.reasons.push(
        `Elite-manager consensus ${Math.round(pick.consensus * 100)}% (+${bonus.toFixed(2)} xPts): ${pick.note}`,
      );
      adjustments.set(player.playerId, entry);
      applied.push({ playerId: player.playerId, name: player.name, kind: 'consensus', note: pick.note });
    }
  }

  const adjusted = players.map((player) => {
    const change = adjustments.get(player.playerId);
    if (!change) return player;

    const availability = change.availability ?? player.availability;
    // Re-weight from the raw projection so the availability change is applied cleanly rather
    // than compounded on top of the previous weighting.
    const raw = player.xPtsRaw + change.xPts;
    const xPts = availability.excluded ? 0 : raw * availability.probability;

    return {
      ...player,
      availability,
      xPtsRaw: round(raw),
      xPts: round(Math.max(0, xPts)),
      breakdown: { ...player.breakdown, curatedIntel: round(change.xPts) },
      reasons: [...player.reasons, ...change.reasons],
    };
  });

  return { players: adjusted, unmatched, applied, priceMismatches, skippedReason: null };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
