import { describe, expect, it } from 'vitest';
import { applyIntel, loadIntel, normaliseName, type Intel } from '../../src/model/intel.js';
import { player } from '../support/players.js';

const intel = loadIntel();

function baseIntel(overrides: Partial<Intel> = {}): Intel {
  return {
    compiledAt: '2026-08-10',
    season: '2026/27',
    staleAfterGameweek: 4,
    sources: ['https://example.com/source'],
    weights: { eliteConsensusWeight: 1, availabilityOverridesEnabled: true },
    eliteConsensus: [],
    availabilityFlags: [],
    contextNotes: [],
    ...overrides,
  } as Intel;
}

describe('the shipped intel file', () => {
  it('loads and is dated', () => {
    expect(intel).not.toBeNull();
    expect(intel!.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(intel!.season).toBe('2026/27');
  });

  it('cites a source for every claim it makes', () => {
    expect(intel!.sources.length).toBeGreaterThan(0);
    for (const source of intel!.sources) expect(source).toMatch(/^https?:\/\//);
  });

  it('gives a note explaining every entry', () => {
    for (const pick of intel!.eliteConsensus) expect(pick.note.length).toBeGreaterThan(10);
    for (const flag of intel!.availabilityFlags) expect(flag.note.length).toBeGreaterThan(10);
  });

  it('stops applying once the season has real data', () => {
    expect(intel!.staleAfterGameweek).toBeLessThanOrEqual(6);
  });
});

describe('name matching', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normaliseName('João Pedro')).toBe(normaliseName('joao pedro'));
    expect(normaliseName('Kinský')).toBe(normaliseName('Kinsky'));
    expect(normaliseName("O'Riley")).toBe(normaliseName('ORiley'));
  });
});

describe('applying intel', () => {
  const haaland = player({ playerId: 1, name: 'Haaland', position: 'FWD', xPts: 6 });
  const other = player({ playerId: 2, name: 'Someone', position: 'MID', xPts: 5 });
  const withClub = (p: ReturnType<typeof player>, club: string) => ({ ...p, clubShort: club });

  it('nudges a player elite managers agree on', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI'), other],
      baseIntel({
        eliteConsensus: [
          { webName: 'Haaland', club: 'MCI', consensus: 1, note: 'Owned by every elite manager' },
        ],
      }),
      1,
    );

    const adjusted = result.players.find((p) => p.playerId === 1)!;
    expect(adjusted.xPts).toBeGreaterThan(haaland.xPts);
    expect(adjusted.reasons.join(' ')).toMatch(/Elite-manager consensus 100%/);
    expect(result.players.find((p) => p.playerId === 2)!.xPts).toBe(other.xPts);
  });

  it('can only make a player less available, never more', () => {
    // The API says injured. A curated note claiming otherwise must not resurrect them.
    const injured = withClub(
      player({ playerId: 3, name: 'Crocked', position: 'DEF', status: 'i' }),
      'ARS',
    );
    const result = applyIntel(
      [injured],
      baseIntel({
        availabilityFlags: [
          { webName: 'Crocked', club: 'ARS', state: 'available', probability: 1, note: 'Reportedly fit again' },
        ],
      }),
      1,
    );
    expect(result.players[0]!.availability.excluded).toBe(true);
    expect(result.players[0]!.availability.probability).toBe(0);
  });

  it('downgrades a player the API still thinks is fine', () => {
    const fit = withClub(player({ playerId: 4, name: 'Saliba', position: 'DEF', xPts: 5 }), 'ARS');
    const result = applyIntel(
      [fit],
      baseIntel({
        availabilityFlags: [
          { webName: 'Saliba', club: 'ARS', state: 'injured', probability: 0, note: 'Reported as a long-term absence' },
        ],
      }),
      1,
    );
    expect(result.players[0]!.availability.excluded).toBe(true);
    expect(result.players[0]!.xPts).toBe(0);
  });

  it('reports entries that match nobody instead of ignoring them', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI')],
      baseIntel({
        availabilityFlags: [
          { webName: 'Nobody At All', club: 'XYZ', state: 'injured', probability: 0, note: 'A player who does not exist' },
        ],
      }),
      1,
    );
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toMatch(/Nobody At All/);
  });

  it('stops applying once the season has its own data', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI')],
      baseIntel({
        staleAfterGameweek: 4,
        eliteConsensus: [{ webName: 'Haaland', club: 'MCI', consensus: 1, note: 'Template pick' }],
      }),
      9,
    );
    expect(result.applied).toHaveLength(0);
    expect(result.players[0]!.xPts).toBe(haaland.xPts);
    expect(result.skippedReason).toMatch(/not applied after gameweek 4/);
  });

  it('can be switched off entirely by setting the weight to zero', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI')],
      baseIntel({
        weights: { eliteConsensusWeight: 0, availabilityOverridesEnabled: true },
        eliteConsensus: [{ webName: 'Haaland', club: 'MCI', consensus: 1, note: 'Template pick' }],
      }),
      1,
    );
    expect(result.players[0]!.xPts).toBe(haaland.xPts);
  });

  it('does nothing at all when there is no intel file', () => {
    const result = applyIntel([haaland, other], null, 1);
    expect(result.players).toEqual([haaland, other]);
    expect(result.applied).toHaveLength(0);
  });

  it('records the adjustment in the breakdown so it is visible, not hidden', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI')],
      baseIntel({
        eliteConsensus: [{ webName: 'Haaland', club: 'MCI', consensus: 0.5, note: 'Widely owned' }],
      }),
      1,
    );
    expect(result.players[0]!.breakdown.curatedIntel).toBeCloseTo(0.5, 5);
  });

  it('withholds a note whose researched price no longer matches the live price', () => {
    // The cheapest available check that a curated claim still describes reality. A price that
    // has moved several notches means the note is stale; a wildly different one means it
    // matched the wrong player.
    const priced = { ...withClub(haaland, 'MCI'), price: 90 };
    const result = applyIntel(
      [priced],
      baseIntel({
        eliteConsensus: [
          { webName: 'Haaland', club: 'MCI', expectedPrice: 155, consensus: 1, note: 'Template pick' },
        ],
      }),
      1,
    );

    expect(result.priceMismatches).toHaveLength(1);
    expect(result.priceMismatches[0]).toMatchObject({ expected: 155, actual: 90 });
    expect(result.players[0]!.xPts).toBe(priced.xPts);
    expect(result.applied).toHaveLength(0);
  });

  it('tolerates a small price drift, which is just normal in-season movement', () => {
    const priced = { ...withClub(haaland, 'MCI'), price: 153 };
    const result = applyIntel(
      [priced],
      baseIntel({
        eliteConsensus: [
          { webName: 'Haaland', club: 'MCI', expectedPrice: 155, consensus: 1, note: 'Template pick' },
        ],
      }),
      1,
    );
    expect(result.priceMismatches).toHaveLength(0);
    expect(result.players[0]!.xPts).toBeGreaterThan(priced.xPts);
  });

  it('still applies a note that gives no researched price', () => {
    const result = applyIntel(
      [withClub(haaland, 'MCI')],
      baseIntel({
        eliteConsensus: [{ webName: 'Haaland', club: 'MCI', consensus: 1, note: 'Template pick' }],
      }),
      1,
    );
    expect(result.priceMismatches).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
  });

  it('never mutates the players it was given', () => {
    const original = withClub(haaland, 'MCI');
    const before = original.xPts;
    applyIntel(
      [original],
      baseIntel({
        eliteConsensus: [{ webName: 'Haaland', club: 'MCI', consensus: 1, note: 'Template pick' }],
      }),
      1,
    );
    expect(original.xPts).toBe(before);
  });
});
