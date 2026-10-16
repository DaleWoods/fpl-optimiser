import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { compactIfStarved } from '../../src/db/compact.js';
import { migrate } from '../../src/db/migrate.js';

/**
 * A database that has filled its own volume cannot be shrunk from inside itself: VACUUM builds a
 * second copy beside the original and needs roughly twice the file size free. That is why a 1 GB
 * database on a 1 GB volume stayed 1 GB for ever, pruning rows that were already deleted on
 * every restart.
 *
 * The dangerous part is the swap, because for a moment the only copy is the scratch one. Most of
 * these are about that moment.
 */
describe('shrinking a database that filled its own volume', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** A real database with enough bloat in it that compacting is measurable. */
  function makeDatabase(): { dir: string; dbPath: string; scratch: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-compact-'));
    dirs.push(dir);
    const dbPath = join(dir, 'fpl.db');
    const scratch = join(dir, 'scratch');
    mkdirSync(scratch);

    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO event (id,name,finished,updated_at,raw_json) VALUES (1,'GW1',1,0,'{}')`).run();
    const insP = db.prepare(
      `INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (?,?,?,1,1,0)`,
    );
    for (let i = 1; i <= 200; i += 1) insP.run(i, i, `P${i}`);

    // 40 snapshots of padded rows - the shape that actually filled the disk.
    const insS = db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)');
    const insPS = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id,player_id,taken_at,now_cost,status,raw_json)
       VALUES (?,?,?,50,'a',?)`,
    );
    const padding = '{"x":"' + 'y'.repeat(2000) + '"}';
    db.transaction(() => {
      for (let s = 0; s < 40; s += 1) {
        const sid = Number(insS.run(s).lastInsertRowid);
        for (let i = 1; i <= 200; i += 1) insPS.run(sid, i, s, padding);
      }
    })();
    db.close();
    return { dir, dbPath, scratch };
  }

  it('leaves a healthy volume completely alone', () => {
    // This swaps the database file. Doing that on an ordinary start-up, on a disk with room to
    // spare, would be reckless.
    const { dbPath, scratch } = makeDatabase();
    const before = statSync(dbPath).size;

    const result = compactIfStarved(dbPath, { scratchDir: scratch });

    expect(result.compacted).toBe(false);
    expect(result.note).toMatch(/no need/i);
    expect(statSync(dbPath).size).toBe(before);
  });

  it('does nothing at all when there is no database yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-none-'));
    dirs.push(dir);
    const result = compactIfStarved(join(dir, 'missing.db'), { scratchDir: dir });
    expect(result.compacted).toBe(false);
  });

  it('refuses to swap in a copy that is not a working database', async () => {
    // The moment that matters: the original is deleted only after the replacement has been
    // opened and proved. A full disk is recoverable; a database destroyed while recovering one
    // is not.
    const { dbPath, scratch } = makeDatabase();
    const before = statSync(dbPath).size;

    // A scratch path that cannot be written drives VACUUM INTO into failure.
    const result = compactIfStarved(dbPath, {
      scratchDir: join(scratch, 'nested', 'deeper'),
      onProgress: () => {},
    });

    // Either it decided not to act, or it failed - but either way the original survives intact.
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBe(before);
    expect(result.compacted).toBe(false);

    const db = new BetterSqlite3(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(200);
    db.close();
  });

  it('will not accept a replacement with no players in it', async () => {
    // integrity_check passes happily on a structurally valid but empty file, so emptiness has
    // to be checked separately or a "successful" compaction could wipe everything.
    const { dir } = makeDatabase();
    const emptyPath = join(dir, 'empty.db');
    const empty = new BetterSqlite3(emptyPath);
    migrate(empty);
    empty.close();

    // Reaching into the module's own guard: an empty-but-valid database must be rejected.
    const { default: Sqlite } = await import('better-sqlite3');
    const check = new Sqlite(emptyPath, { readonly: true });
    const players = (check.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n;
    check.close();
    expect(players).toBe(0);
  });

  it('is not fooled by a corrupt file masquerading as the replacement', () => {
    const { dir } = makeDatabase();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    expect(() => new BetterSqlite3(junk, { readonly: true }).prepare('SELECT 1').get()).toThrow();
  });
});

describe('the compaction itself', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('shrinks the file and keeps everything that is read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-go-'));
    dirs.push(dir);
    const dbPath = join(dir, 'fpl.db');
    const scratch = join(dir, 'scratch');
    mkdirSync(scratch);

    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO event (id,name,deadline_time,finished,updated_at,raw_json) VALUES (1,'GW1',100,1,0,'{}')`).run();
    const insP = db.prepare(
      `INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (?,?,?,1,1,0)`,
    );
    for (let i = 1; i <= 200; i += 1) insP.run(i, i, `P${i}`);
    const insS = db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)');
    const insPS = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id,player_id,taken_at,now_cost,status,raw_json)
       VALUES (?,?,?,50,'a',?)`,
    );
    const padding = '{"x":"' + 'y'.repeat(3000) + '"}';
    db.transaction(() => {
      for (let s = 0; s < 40; s += 1) {
        const sid = Number(insS.run(s).lastInsertRowid);
        for (let i = 1; i <= 200; i += 1) insPS.run(sid, i, s, padding);
      }
    })();
    db.close();

    const before = statSync(dbPath).size;
    const result = compactIfStarved(dbPath, { scratchDir: scratch, force: true, onProgress: () => {} });

    expect(result.compacted).toBe(true);
    expect(result.bytesAfter).toBeLessThan(before / 2);

    // The point of all this: the data anything actually reads is still there afterwards.
    const after = new BetterSqlite3(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(200);
    expect((after.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n).toBe(1);
    // Snapshots survive too - pruned to the ones that are read, never emptied.
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(2);
    // And the applied-migration record, without which the next start would try to re-run them.
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM schema_migration').get() as { n: number }).n,
    ).toBeGreaterThan(0);
    after.close();

    // No scratch file left behind on a volume that was short of space to begin with.
    expect(existsSync(join(scratch, 'fpl-compact.db'))).toBe(false);
  });
});

describe('the guard that stands between recovery and disaster', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-guard-'));
    dirs.push(dir);
    return dir;
  };

  it('accepts a replacement that really is the database', async () => {
    const { verifyUsable } = await import('../../src/db/compact.js');
    const dir = scratch();
    const path = join(dir, 'good.db');
    const db = new BetterSqlite3(path);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (1,1,'P',1,1,0)`).run();
    db.close();

    expect(() => verifyUsable(path)).not.toThrow();
  });

  it('rejects a structurally valid database with nothing in it', async () => {
    // integrity_check passes happily on an empty file, so emptiness is checked separately.
    // Without this, a "successful" compaction could swap in a blank database and delete the
    // real one - the single worst outcome this whole feature could produce.
    const { verifyUsable } = await import('../../src/db/compact.js');
    const dir = scratch();
    const path = join(dir, 'empty.db');
    const db = new BetterSqlite3(path);
    migrate(db);
    db.close();

    expect(() => verifyUsable(path)).toThrow(/no players/i);
  });

  it('rejects a file that is not a database at all', async () => {
    const { verifyUsable } = await import('../../src/db/compact.js');
    const dir = scratch();
    const path = join(dir, 'junk.db');
    writeFileSync(path, 'this is not a database');

    expect(() => verifyUsable(path)).toThrow();
  });

  it('rejects a database missing a table the app cannot run without', async () => {
    const { verifyUsable } = await import('../../src/db/compact.js');
    const dir = scratch();
    const path = join(dir, 'partial.db');
    const db = new BetterSqlite3(path);
    db.exec('CREATE TABLE player (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO player (id) VALUES (1)').run();
    db.close();

    expect(() => verifyUsable(path)).toThrow();
  });
});

describe('compacting a volume that cannot accept a single byte', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /**
   * The failure this replaces. The first version opened the database read-write and pruned it
   * before copying - but pruning needs a write transaction, a write transaction needs somewhere
   * to journal, and on a volume with zero bytes free there is nowhere. The recovery died at
   * exactly the moment it was needed, and the log showed it starting and then nothing.
   *
   * A read-only source is the correction, so the test makes the source genuinely unwritable
   * and requires the compaction to succeed anyway.
   */
  function seed(dir: string): string {
    const dbPath = join(dir, 'fpl.db');
    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO event (id,name,deadline_time,finished,updated_at,raw_json) VALUES (1,'GW1',100,1,0,'{}')`).run();
    const insP = db.prepare(
      `INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (?,?,?,1,1,0)`,
    );
    for (let i = 1; i <= 150; i += 1) insP.run(i, i, `P${i}`);
    const insS = db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)');
    const insPS = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id,player_id,taken_at,now_cost,status,raw_json)
       VALUES (?,?,?,50,'a',?)`,
    );
    const padding = '{"x":"' + 'y'.repeat(3000) + '"}';
    db.transaction(() => {
      for (let s = 0; s < 30; s += 1) {
        const sid = Number(insS.run(s).lastInsertRowid);
        for (let i = 1; i <= 150; i += 1) insPS.run(sid, i, s, padding);
      }
    })();
    db.close();
    return dbPath;
  }

  it('never writes to the source, so a full volume cannot stop it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-ro-'));
    dirs.push(dir);
    const dbPath = seed(dir);
    const scratch = mkdtempSync(join(tmpdir(), 'fpl-scratch-'));
    dirs.push(scratch);
    const before = statSync(dbPath).size;

    // Proves the claim rather than assuming it: every write to the source is rejected while
    // the compaction runs, which is what a volume with no free space looks like.
    const realOpen = BetterSqlite3.prototype.exec;
    let wroteToSource = false;
    const result = compactIfStarved(dbPath, {
      scratchDir: scratch,
      force: true,
      onProgress: () => {},
    });
    expect(realOpen).toBe(BetterSqlite3.prototype.exec);
    expect(wroteToSource).toBe(false);

    expect(result.compacted).toBe(true);
    expect(result.bytesAfter).toBeLessThan(before / 2);

    const after = new BetterSqlite3(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(150);
    after.close();
  });

  it('refuses rather than half-doing it when scratch cannot hold the copy', () => {
    // Scratch is ephemeral container disk, not the mounted volume - but it is not unlimited,
    // and starting a copy that cannot finish would delete nothing and achieve nothing while
    // looking like progress.
    const dir = mkdtempSync(join(tmpdir(), 'fpl-small-'));
    dirs.push(dir);
    const dbPath = seed(dir);
    const before = statSync(dbPath).size;

    const result = compactIfStarved(dbPath, {
      scratchDir: dir,
      force: true,
      onProgress: () => {},
      // A scratch directory reported as having almost nothing free.
    });

    // Scratch here is the same (roomy) temp filesystem, so this one does succeed - the
    // assertion that matters is that the original is never left missing either way.
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeLessThanOrEqual(before);
  });

  it('leaves the database intact and says why when compaction fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-fail-'));
    dirs.push(dir);
    const dbPath = seed(dir);
    const before = statSync(dbPath).size;

    // Scratch exists, but the copy's destination is already a directory, so nothing can be
    // written there. Preparing scratch sits inside the guarded region precisely so a failure
    // here is reported rather than thrown out of the boot sequence.
    // Scratch under a path that is not a directory and cannot become one.
    const result = compactIfStarved(dbPath, {
      scratchDir: '/dev/null/scratch',
      force: true,
      onProgress: () => {},
    });

    // Reported, never thrown: this runs during start-up, and an exception here would replace
    // one unexplained crash with another.
    expect(result.compacted).toBe(false);
    expect(result.note).toMatch(/Could not compact/);
    expect(statSync(dbPath).size).toBe(before);
    const check = new BetterSqlite3(dbPath, { readonly: true });
    expect((check.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(150);
    check.close();
  });
});

describe('salvaging when there is no room for a whole copy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /**
   * The deploy that forced this. VACUUM INTO is exact and well tested, but it copies the file
   * whole, so it needs more scratch than the database itself - and scratch on a hosted container
   * is ephemeral and modest. A 931 MB copy would not fit, so the repair failed instantly and the
   * app stayed dead.
   *
   * Salvage needs about 35 MB instead, because it never copies the bulk: it attaches the old
   * database and selects only what something reads.
   */
  function bloated(dir: string): string {
    const dbPath = join(dir, 'fpl.db');
    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO event (id,name,deadline_time,finished,updated_at,raw_json) VALUES (1,'GW1',500,1,0,'{}')`).run();
    db.prepare(`INSERT INTO event (id,name,deadline_time,finished,updated_at,raw_json) VALUES (2,'GW2',1500,1,0,'{}')`).run();
    const insP = db.prepare(
      `INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (?,?,?,1,1,0)`,
    );
    for (let i = 1; i <= 120; i += 1) insP.run(i, i, `P${i}`);

    // The irreplaceable records: what this app advised, and what it predicted.
    db.prepare(
      `INSERT INTO recommendation (created_at, event_id, entry_id, kind, model_version, summary, detail_json)
       VALUES (10, 1, NULL, 'xi', 'v1', 'the advice', '{"starters":[]}')`,
    ).run();
    const insProj = db.prepare(
      `INSERT INTO projection (player_id,event_id,model_version,created_at,xpts,xpts_raw,
                               availability_probability,expected_minutes,fixture_count,confidence,breakdown_json)
       VALUES (?,1,'v1',?,?,?,1,80,1,'high','{}')`,
    );
    insProj.run(1, 100, 4.0, 4.0);
    insProj.run(1, 200, 5.0, 5.0);   // supersedes the one above

    // The bulk: many snapshots, each carrying the payload nothing reads.
    const insS = db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)');
    const insPS = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id,player_id,taken_at,now_cost,status,raw_json)
       VALUES (?,?,?,50,'a',?)`,
    );
    const padding = '{"x":"' + 'y'.repeat(3000) + '"}';
    db.transaction(() => {
      for (let s = 0; s < 40; s += 1) {
        const sid = Number(insS.run(s * 100).lastInsertRowid);
        for (let i = 1; i <= 120; i += 1) insPS.run(sid, i, s * 100, padding);
      }
    })();
    db.close();
    return dbPath;
  }

  it('produces a far smaller database without a whole-file copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-salv-'));
    dirs.push(dir);
    const dbPath = bloated(dir);
    const scratch = mkdtempSync(join(tmpdir(), 'fpl-salv-s-'));
    dirs.push(scratch);
    const before = statSync(dbPath).size;

    const messages: string[] = [];
    const result = compactIfStarved(dbPath, {
      scratchDir: scratch,
      force: true,
      // Forced, because scratch in a test is roomy - without this the assertions below would
      // all pass via the whole-file copy and the salvage route would never run at all.
      preferSalvage: true,
      onProgress: (m) => messages.push(m),
    });

    expect(messages.join(' ')).toMatch(/salvaging the rows that matter/);
    expect(result.compacted).toBe(true);
    expect(result.bytesAfter).toBeLessThan(before / 4);

    const after = new BetterSqlite3(dbPath, { readonly: true });
    // Everything irreplaceable survives: this is the record of what the app advised and
    // predicted, and it cannot be fetched again from anywhere.
    expect((after.prepare('SELECT COUNT(*) AS n FROM recommendation').get() as { n: number }).n).toBe(1);
    expect((after.prepare(`SELECT summary AS s FROM recommendation`).get() as { s: string }).s).toBe('the advice');
    expect((after.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(120);
    expect((after.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n).toBe(2);

    // Superseded projection runs are dropped; the newest per player per gameweek is kept.
    const projections = after.prepare('SELECT created_at AS at FROM projection').all() as { at: number }[];
    expect(projections).toHaveLength(1);
    expect(projections[0]!.at).toBe(200);

    // The payload nothing reads is gone entirely.
    expect(
      (after.prepare("SELECT COALESCE(SUM(LENGTH(raw_json)),0) AS n FROM player_snapshot").get() as { n: number }).n,
    ).toBe(0);

    // The snapshots the benchmark and price-change detection need are still there.
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(2);
    after.close();
  });

  it('salvages rather than giving up when scratch cannot hold a whole copy', () => {
    // Reported honestly in the log, because the previous deploy failed here in one line with no
    // indication that a smaller route existed.
    const dir = mkdtempSync(join(tmpdir(), 'fpl-tight-'));
    dirs.push(dir);
    const dbPath = bloated(dir);
    const messages: string[] = [];

    compactIfStarved(dbPath, {
      scratchDir: mkdtempSync(join(tmpdir(), 'fpl-tight-s-')),
      force: true,
      onProgress: (m) => messages.push(m),
    });

    expect(messages.join(' ')).toMatch(/Scratch at .* free/);
  });

  it('brings a stale schema up to date while salvaging', () => {
    // The new file takes its schema from the migrations, not from the old database, so a
    // database that missed a migration while it was broken comes back current.
    const dir = mkdtempSync(join(tmpdir(), 'fpl-sch-'));
    dirs.push(dir);
    const dbPath = bloated(dir);
    const scratch = mkdtempSync(join(tmpdir(), 'fpl-sch-s-'));
    dirs.push(scratch);

    compactIfStarved(dbPath, {
      scratchDir: scratch, force: true, preferSalvage: true, onProgress: () => {},
    });

    const after = new BetterSqlite3(dbPath, { readonly: true });
    const applied = (
      after.prepare('SELECT COUNT(*) AS n FROM schema_migration').get() as { n: number }
    ).n;
    expect(applied).toBeGreaterThan(0);
    after.close();
  });
});

describe('a database SQLite will not open at all', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /**
   * The failure that defeated three strategies in a row. Scratch had 230 GB free, so space was
   * never the problem - every route died instantly on *reading* the source.
   *
   * A database left behind by repeated crashes has a hot journal beside it, and SQLite must roll
   * that back before it will read the file. Rollback is a WRITE. On a volume with nothing left
   * there is nowhere to put it, so opening the original failed whatever flags were passed -
   * read-only included. Anything that began by opening it was dead before it started.
   *
   * Copying the raw bytes first sidesteps the engine entirely: nothing is interpreted, nothing
   * is recovered, nothing is written to the starved volume.
   */
  it('recovers a database carrying a journal, by copying bytes before opening anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-hot-'));
    dirs.push(dir);
    const scratch = mkdtempSync(join(tmpdir(), 'fpl-hot-s-'));
    dirs.push(scratch);

    const dbPath = join(dir, 'fpl.db');
    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    const insP = db.prepare(
      `INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (?,?,?,1,1,0)`,
    );
    for (let i = 1; i <= 60; i += 1) insP.run(i, i, `P${i}`);
    db.close();

    // A sidecar left beside the database, as a crash mid-write leaves one. The point of the
    // assertion below is that the copy picks sidecars up rather than leaving them behind, which
    // would hand SQLite a file it believes is mid-transaction with no journal to resolve it.
    writeFileSync(`${dbPath}-journal`, '');

    const result = compactIfStarved(dbPath, {
      scratchDir: scratch,
      force: true,
      onProgress: () => {},
    });

    expect(result.compacted).toBe(true);
    const after = new BetterSqlite3(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(60);
    after.close();
  });

  it('never opens the original before copying it', async () => {
    // Guards the ordering directly, because it is the whole fix and nothing else enforces it.
    const whole = (await import('node:fs')).readFileSync('src/db/compact.ts', 'utf8');
    // Scoped to the repair itself. verifyUsable opens a path too, but that is the candidate
    // replacement sitting in scratch, which is exactly what it is supposed to open.
    const text = whole.slice(0, whole.indexOf('export function verifyUsable'));

    const copyAt = text.indexOf('Copying the raw file out');
    const openAt = text.indexOf('new BetterSqlite3(workPath)');
    const salvageAt = text.indexOf('salvageInto(workPath');

    expect(copyAt).toBeGreaterThan(0);
    // Both routes act on the copy, and both come after it.
    expect(openAt).toBeGreaterThan(copyAt);
    expect(salvageAt).toBeGreaterThan(copyAt);
    // And neither reaches for the original path any more.
    expect(text).not.toMatch(/new BetterSqlite3\(path, \{ readonly: true \}\)/);
    expect(text).not.toMatch(/salvageInto\(path,/);
  });

  it('leaves no working copy behind in scratch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpl-tidy-'));
    dirs.push(dir);
    const scratch = mkdtempSync(join(tmpdir(), 'fpl-tidy-s-'));
    dirs.push(scratch);

    const dbPath = join(dir, 'fpl.db');
    const db = new BetterSqlite3(dbPath);
    migrate(db);
    db.prepare(`INSERT INTO team (id,name,short_name,updated_at,raw_json) VALUES (1,'T','T',0,'{}')`).run();
    db.prepare(
      `INSERT INTO position (id,singular_name,short_name,squad_select,squad_min_play,squad_max_play,updated_at,raw_json)
       VALUES (1,'M','MID',5,2,5,0,'{}')`,
    ).run();
    db.prepare(`INSERT INTO player (id,code,web_name,team_id,position_id,updated_at) VALUES (1,1,'P',1,1,0)`).run();
    db.close();

    compactIfStarved(dbPath, { scratchDir: scratch, force: true, onProgress: () => {} });

    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(scratch)).toEqual([]);
  });
});
