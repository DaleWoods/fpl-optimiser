import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubFplApi } from '../../src/api/replayClient.js';
import { loadRules } from '../../src/config/load.js';
import { nowSeconds, openTestDatabase } from '../../src/db/index.js';
import { ingestBootstrap } from '../../src/ingest/index.js';
import { isDiskSpaceFailure, pruneHistory, spaceReport } from '../../src/db/maintenance.js';
import { benchmarkGameweek } from '../../src/model/benchmark.js';
import { fakeBootstrap, fakeEvent } from '../support/fakeApi.js';

const rules = loadRules();

describe('keeping the database off its own disk', () => {
  let db: Database;

  beforeEach(async () => {
    db = openTestDatabase();
    await ingestBootstrap(
      db,
      new StubFplApi({
        bootstrap: fakeBootstrap({
          events: [1, 2, 3].map((id) => fakeEvent(id, { finished: true })),
        }),
      }),
      rules,
    );
    db.prepare('DELETE FROM player_snapshot').run();
    db.prepare('DELETE FROM snapshot').run();
    // Three deadlines, an hour apart, well after any snapshot this test writes by accident.
    for (const [id, deadline] of [[1, 1_000_000], [2, 2_000_000], [3, 3_000_000]] as const) {
      db.prepare('UPDATE event SET deadline_time = ? WHERE id = ?').run(deadline, id);
    }
  });

  /** A snapshot at a given time, carrying every player, as a real ingest would. */
  function snapshotAt(takenAt: number): number {
    const id = db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)').run(takenAt)
      .lastInsertRowid as number;
    const insert = db.prepare(
      `INSERT INTO player_snapshot (snapshot_id, player_id, taken_at, now_cost, status,
                                    ep_next, points_per_game, raw_json)
       VALUES (?, ?, ?, 50, 'a', 4.4, 4.1, ?)`,
    );
    const players = db.prepare('SELECT id FROM player').all() as { id: number }[];
    const write = db.transaction(() => {
      for (const p of players) insert.run(id, p.id, takenAt, '{"padding":"' + 'x'.repeat(400) + '"}');
    });
    write();
    return id;
  }

  it('keeps the last snapshot before every deadline, which the benchmark depends on', () => {
    // The trap this guards. A naive "delete anything old" frees plenty of disk and silently
    // destroys the baseline the Accuracy benchmark compares against - and nothing would fail
    // loudly, the comparison would just quietly stop having an answer.
    const earlier = snapshotAt(1_999_000);        // before GW2's deadline, but superseded
    const lastBeforeGw2 = snapshotAt(1_999_500);  // the one the benchmark would read
    const lastBeforeGw3 = snapshotAt(2_999_000);
    for (let i = 0; i < 10; i += 1) snapshotAt(3_100_000 + i);

    pruneHistory(db, { keepSnapshots: 2 });

    const surviving = (db.prepare('SELECT id FROM snapshot').all() as { id: number }[]).map((r) => r.id);
    expect(surviving).toContain(lastBeforeGw2);
    expect(surviving).toContain(lastBeforeGw3);
    // And only the one that would actually be read: keeping every pre-deadline snapshot would
    // keep almost all of them, which is no retention policy at all.
    expect(surviving).not.toContain(earlier);
  });

  it('leaves the benchmark able to score a gameweek after pruning', () => {
    // End to end rather than by inspection: the only claim that matters is that the comparison
    // still produces a number afterwards.
    snapshotAt(1_999_000);
    for (let i = 0; i < 20; i += 1) snapshotAt(2_500_000 + i);

    const insertProjection = db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               availability_probability, expected_minutes, fixture_count,
                               confidence, breakdown_json)
       VALUES (?, 2, 'test', ?, 4, 4, 1, 80, 1, 'high', '{}')`,
    );
    const insertActual = db.prepare(
      `INSERT INTO actual_points (player_id, event_id, points, minutes, source, recorded_at)
       VALUES (?, 2, 5, 90, 'test', ?)`,
    );
    for (const p of db.prepare('SELECT id FROM player LIMIT 10').all() as { id: number }[]) {
      insertProjection.run(p.id, nowSeconds());
      insertActual.run(p.id, nowSeconds());
    }

    expect(benchmarkGameweek(db, 2)).not.toBeNull();
    pruneHistory(db, { keepSnapshots: 2 });
    expect(benchmarkGameweek(db, 2)).not.toBeNull();
  });

  it('never leaves fewer than two snapshots, so change detection still has something to compare', () => {
    for (let i = 0; i < 6; i += 1) snapshotAt(3_100_000 + i);
    // Asking for one is asking to break price-change detection, so the floor holds regardless.
    pruneHistory(db, { keepSnapshots: 1 });
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    expect(remaining).toBeGreaterThanOrEqual(2);
  });

  it('deletes the player rows with the snapshot, not just the header', () => {
    // Deleting only the snapshot row would leave the bulk of the data behind and free nothing,
    // while the report happily claimed success.
    for (let i = 0; i < 6; i += 1) snapshotAt(3_100_000 + i);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM player_snapshot').get() as { n: number }).n;

    pruneHistory(db, { keepSnapshots: 2 });

    const after = (db.prepare('SELECT COUNT(*) AS n FROM player_snapshot').get() as { n: number }).n;
    expect(after).toBeLessThan(before);
    const orphans = (
      db
        .prepare('SELECT COUNT(*) AS n FROM player_snapshot WHERE snapshot_id NOT IN (SELECT id FROM snapshot)')
        .get() as { n: number }
    ).n;
    expect(orphans).toBe(0);
  });

  it('keeps only the newest projection run per player per gameweek', () => {
    const insert = db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               availability_probability, expected_minutes, fixture_count,
                               confidence, breakdown_json)
       VALUES (1, 1, 'test', ?, ?, ?, 1, 80, 1, 'high', '{}')`,
    );
    insert.run(100, 4.0, 4.0);
    insert.run(200, 5.0, 5.0);
    insert.run(300, 6.0, 6.0);

    const result = pruneHistory(db);

    expect(result.projectionsDeleted).toBe(2);
    const left = db.prepare('SELECT created_at AS at, xpts FROM projection').all() as { at: number; xpts: number }[];
    expect(left).toHaveLength(1);
    // The newest survives - the one grading and calibration would have used anyway.
    expect(left[0]!.at).toBe(300);
  });

  it('keeps a superseded run that belongs to a different scoring version', () => {
    // Those are not duplicates: a version bump means they describe a different model, and the
    // Accuracy page counts them separately to explain why calibration has not started.
    const insert = db.prepare(
      `INSERT INTO projection (player_id, event_id, model_version, created_at, xpts, xpts_raw,
                               availability_probability, expected_minutes, fixture_count,
                               confidence, breakdown_json)
       VALUES (1, 1, ?, ?, 4, 4, 1, 80, 1, 'high', '{}')`,
    );
    insert.run('v1', 100);
    insert.run('v2', 200);

    pruneHistory(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM projection').get() as { n: number }).n).toBe(2);
  });

  it('reports which tables the space actually went into', () => {
    for (let i = 0; i < 3; i += 1) snapshotAt(3_100_000 + i);
    const report = spaceReport(db);

    expect(report.databaseBytes).toBeGreaterThan(0);
    const snapshots = report.tables.find((t) => t.table === 'player_snapshot')!;
    expect(snapshots.rows).toBeGreaterThan(0);
    // Counted from the stored text, because row counts alone hide which table is the problem.
    expect(snapshots.approximateBytes).toBeGreaterThan(snapshots.rows * 100);
  });

  it('recognises a full disk as a full disk, whatever wording SQLite used', () => {
    // "disk I/O error" reads like failing hardware and sends you looking in the wrong place.
    for (const message of [
      'disk I/O error',
      'database or disk is full',
      'SQLITE_IOERR: disk I/O error',
      'ENOSPC: no space left on device, write',
    ]) {
      expect(isDiskSpaceFailure(new Error(message))).toBe(true);
    }
    expect(isDiskSpaceFailure(new Error('no such table: player'))).toBe(false);
  });
});

describe('recovering a disk that is already full', () => {
  it('clears the HTTP cache before touching the database', async () => {
    // The ordering is the point, not tidiness. On a genuinely full disk SQLite cannot delete a
    // row either - a DELETE has to write its journal first - so a recovery that starts with the
    // database can fail with the same error it was called to clear. Unlinking plain files needs
    // no free space at all.
    const { mkdtempSync, writeFileSync, readdirSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { clearHttpCache } = await import('../../src/db/maintenance.js');

    const dir = mkdtempSync(join(tmpdir(), 'fpl-cache-'));
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ body: 'x'.repeat(5000) }));
    writeFileSync(join(dir, 'bbb.json'), JSON.stringify({ body: 'y'.repeat(5000) }));
    // Not ours, and not a cache entry - it must survive.
    writeFileSync(join(dir, 'keep.txt'), 'important');

    const result = clearHttpCache(dir);

    expect(result.filesDeleted).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(9000);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
    expect(existsSync(dir)).toBe(true);
  });

  it('says nothing is there rather than failing when the cache has never been written', async () => {
    const { clearHttpCache } = await import('../../src/db/maintenance.js');
    expect(clearHttpCache('/nonexistent/path/that/was/never/created')).toEqual({
      filesDeleted: 0,
      bytesFreed: 0,
    });
  });

  it('leaves the cache alone on the automatic prune after a refresh', async () => {
    // That one runs every few hours and is not a recovery; throwing away a warm cache every
    // time would make every refresh slower and hammer the FPL API for no reason.
    const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'fpl-cache-'));
    writeFileSync(join(dir, 'aaa.json'), '{}');

    const db = openTestDatabase();
    const result = pruneHistory(db);

    expect(result.cacheFilesDeleted).toBe(0);
    expect(readdirSync(dir)).toEqual(['aaa.json']);
  });
});
