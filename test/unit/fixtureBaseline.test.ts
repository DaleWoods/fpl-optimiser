import { describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadModelWeights, loadRules } from '../../src/config/load.js';
import { openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap, ingestFixtures } from '../../src/ingest/index.js';
import { buildProjections } from '../../src/model/build.js';
import { fakeBootstrap, fakeEvent, fakeFixture } from '../support/fakeApi.js';

const rules = loadRules();
const weights = loadModelWeights();

/**
 * Favourable COMPARED TO WHAT.
 *
 * A player's expected goals per 90 were earned while playing for his club. Scaling them by his
 * club's expected goals divided by the LEAGUE average then credits him for his club a second
 * time - so a strong club's attacker is lifted and a weak club's is cut, on top of rates that
 * already said exactly that. Measured on this model's own constants, facing a league-average
 * opponent at home, the scale is 1.29 for a strong club and 0.96 for a weak one: an 18% spread
 * that has nothing to do with the fixture in front of them.
 *
 * Dividing by the club's own typical output instead leaves the scalar measuring the opponent
 * and the venue, which is all it was ever for.
 */
describe('what a fixture is measured against', () => {
  /** Two clubs of very different strength, each facing an identical average opponent. */
  async function seed() {
    const db = openTestDatabase();
    const teams = [
      { id: 1, name: 'Strong', short_name: 'STR', attack: 1350, defence: 1150 },
      { id: 2, name: 'Weak', short_name: 'WEA', attack: 1000, defence: 1150 },
      { id: 3, name: 'Average A', short_name: 'AVA', attack: 1150, defence: 1150 },
      { id: 4, name: 'Average B', short_name: 'AVB', attack: 1150, defence: 1150 },
    ];
    // Identical players, so only their clubs differ. Identical records too - which is the
    // point: in the real world the strong club's player would have the better record, and
    // that record is precisely what must not be credited twice.
    const players = [1, 2].map((team) => ({
      id: team, web_name: `P${team}`, team, element_type: 4, now_cost: 70,
      minutes: 900, starts: 10, goals_scored: 8, assists: 2,
      expected_goals: 8, expected_assists: 2, bonus: 10, selected_by_percent: 10,
    }));

    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams, players: players as never,
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-14T17:30:00Z' })],
        }),
      }),
      rules,
    );
    // Both at home, both against an identical average club.
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 3), fakeFixture(2, 1, 2, 4)] }),
    );
    return db;
  }

  const withBaseline = (baseline: 'league' | 'club') => ({
    ...weights,
    attacking: { ...weights.attacking, fixtureBaseline: baseline },
  });

  it('stops counting club strength twice', async () => {
    const db = await seed();
    const league = buildProjections(db, 1, rules, withBaseline('league'));
    const club = buildProjections(db, 1, rules, withBaseline('club'));

    const gap = (list: typeof league) =>
      list.find((p) => p.playerId === 1)!.xPts / list.find((p) => p.playerId === 2)!.xPts;

    // Same record, same opponent strength, same venue - so the only thing separating these two
    // players is which club they play for, and their own rates already say that.
    // Measured: 1.150 against the league average, 0.998 against the club's own baseline. A
    // 15% phantom advantage to the strong club's attacker, on top of a record that already
    // reflects playing there.
    expect(gap(league)).toBeGreaterThan(1.1);
    expect(gap(club)).toBeGreaterThan(0.95);
    expect(gap(league)).toBeGreaterThan(gap(club));
    // And the remaining gap is small rather than absent: the clubs' defences differ in what
    // they concede, which legitimately changes a clean sheet and the conceding penalty.
    expect(gap(club)).toBeLessThan(1.1);
  });

  it('leaves the fixture itself still doing the work', async () => {
    // The scalar must not be neutered - a hard fixture has to read as a hard fixture. Under
    // the club baseline the same player facing a strong defence still projects lower than
    // facing a weak one.
    const db = openTestDatabase();
    const teams = [
      { id: 1, name: 'Club', short_name: 'CLB', attack: 1150, defence: 1150 },
      { id: 2, name: 'Club2', short_name: 'CL2', attack: 1150, defence: 1150 },
      { id: 3, name: 'Brick wall', short_name: 'WAL', attack: 1150, defence: 1400 },
      { id: 4, name: 'Sieve', short_name: 'SIE', attack: 1150, defence: 950 },
    ];
    const players = [1, 2].map((team) => ({
      id: team, web_name: `P${team}`, team, element_type: 4, now_cost: 70,
      minutes: 900, starts: 10, goals_scored: 8, assists: 2,
      expected_goals: 8, expected_assists: 2, bonus: 10, selected_by_percent: 10,
    }));
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          teams, players: players as never,
          events: [fakeEvent(1, { is_next: true, deadline_time: '2099-08-14T17:30:00Z' })],
        }),
      }),
      rules,
    );
    await ingestFixtures(
      db,
      new StubFplApi({ fixtures: [fakeFixture(1, 1, 1, 3), fakeFixture(2, 1, 2, 4)] }),
    );

    const club = buildProjections(db, 1, rules, withBaseline('club'));
    expect(club.find((p) => p.playerId === 1)!.xPts).toBeLessThan(
      club.find((p) => p.playerId === 2)!.xPts,
    );
  });

  it('is off by default, so the shipped numbers are unchanged', async () => {
    const db = await seed();
    const shipped = buildProjections(db, 1, rules, weights);
    const league = buildProjections(db, 1, rules, withBaseline('league'));
    for (const player of shipped) {
      expect(player.xPts).toBeCloseTo(league.find((p) => p.playerId === player.playerId)!.xPts, 10);
    }
  });
});
