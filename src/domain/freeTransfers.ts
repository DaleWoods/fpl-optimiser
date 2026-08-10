import type { Rules } from '../config/schema.js';

export interface GameweekTransferRecord {
  event: number;
  /** Transfers made in that gameweek (API: event_transfers). */
  transfersMade: number;
  /** Points deducted for them (API: event_transfers_cost). Used only as a cross-check. */
  transfersCost: number;
  /** The chip active that gameweek, if any. */
  chip?: string | null;
}

export interface FreeTransferDerivation {
  /** Free transfers available for the *next* gameweek. */
  freeTransfers: number;
  /** How the number was arrived at, in plain English, one line per gameweek considered. */
  workings: string[];
  /** True when the derivation is trustworthy end to end. */
  confident: boolean;
  caveats: string[];
}

/**
 * Derive how many free transfers are available.
 *
 * The public API does not expose this - only the authenticated my-team endpoint does - so it has
 * to be reconstructed from transfer history under the rollover rules. Because it is derived, the
 * workings are returned alongside the number, and any reason for doubt is surfaced rather than
 * hidden: advice that says "take a hit" should be auditable back to the count it assumed.
 *
 * Rules applied (all from config, per spec Section 7):
 *  - one free transfer per gameweek
 *  - unused transfers roll over, capped at maxBanked
 *  - transfers beyond the free allowance cost points but never push the balance below zero
 *  - banked transfers are kept when a Wildcard or Free Hit is played
 */
export function deriveFreeTransfers(
  history: readonly GameweekTransferRecord[],
  rules: Rules,
  options: { chipUsage?: ReadonlyMap<number, string> } = {},
): FreeTransferDerivation {
  const { freePerGameweek, maxBanked, keepBankedOnWildcard, keepBankedOnFreeHit } = rules.transfers;
  const workings: string[] = [];
  const caveats: string[] = [];

  if (history.length === 0) {
    workings.push(
      `No completed gameweeks yet, so the squad is still unlimited-transfer territory before ` +
        `the first deadline; ${freePerGameweek} free transfer applies from the gameweek after it.`,
    );
    return {
      freeTransfers: freePerGameweek,
      workings,
      confident: true,
      caveats: rules.transfers.unlimitedBeforeFirstDeadline
        ? ['Before the first deadline of the season, transfers are unlimited.']
        : [],
    };
  }

  const ordered = [...history].sort((a, b) => a.event - b.event);

  // The first gameweek of the season grants the first free transfer for the gameweek after it;
  // transfers made before the very first deadline are unlimited and do not consume anything.
  let banked = freePerGameweek;

  for (const record of ordered) {
    const chip = record.chip ?? options.chipUsage?.get(record.event) ?? null;
    const isWildcard = chip === 'wildcard';
    const isFreeHit = chip === 'freehit';
    const chipKeepsBank = (isWildcard && keepBankedOnWildcard) || (isFreeHit && keepBankedOnFreeHit);

    if (chipKeepsBank) {
      const kept = banked;
      banked = Math.min(maxBanked, banked + freePerGameweek);
      workings.push(
        `GW${record.event}: ${chip} played - ${record.transfersMade} transfer(s) made for free, ` +
          `${kept} banked transfer(s) kept, +${freePerGameweek} for the next gameweek = ${banked}.`,
      );
      continue;
    }

    const used = Math.min(record.transfersMade, banked);
    const overBudget = Math.max(0, record.transfersMade - banked);
    const afterUse = Math.max(0, banked - record.transfersMade);
    const next = Math.min(maxBanked, afterUse + freePerGameweek);

    const hitNote =
      overBudget > 0
        ? ` (${overBudget} beyond the free allowance, costing ${overBudget * rules.transfers.hitCost} points)`
        : '';
    workings.push(
      `GW${record.event}: ${banked} available, ${record.transfersMade} made${hitNote}, ` +
        `${afterUse} left, +${freePerGameweek} = ${next}${next === maxBanked ? ' (capped)' : ''}.`,
    );

    // Cross-check the derivation against what the API says the hits actually cost. A mismatch
    // means our count has drifted from reality, which the user needs to know about.
    const expectedCost = overBudget * rules.transfers.hitCost;
    if (record.transfersCost !== expectedCost) {
      caveats.push(
        `GW${record.event}: derived a hit of ${expectedCost} points but the API reports ` +
          `${record.transfersCost}. The free-transfer count may be off by ` +
          `${Math.abs(record.transfersCost - expectedCost) / rules.transfers.hitCost}.`,
      );
    }

    void used;
    banked = next;
  }

  return {
    freeTransfers: banked,
    workings,
    confident: caveats.length === 0,
    caveats,
  };
}
