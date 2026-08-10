import { describe, expect, it } from 'vitest';
import {
  fromSqliteBool,
  isoToUnix,
  nowSeconds,
  openTestDatabase,
  toSqliteBool,
} from '../../src/db/index.js';
import { appliedMigrations, loadMigrations, migrate } from '../../src/db/migrate.js';

function tableNames(db: ReturnType<typeof openTestDatabase>): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('migrations', () => {
  it('ships at least one migration and names them in applied order', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.name).toMatch(/^0001_/);
    const names = migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });

  it('creates the full schema on a fresh database', () => {
    const db = openTestDatabase();
    const tables = tableNames(db);
    for (const expected of [
      'change_log',
      'event',
      'fixture',
      'ingest_run',
      'manager_state',
      'player',
      'player_fixture_history',
      'player_snapshot',
      'position',
      'projection',
      'recommendation',
      'schema_migration',
      'snapshot',
      'squad_pick',
      'team',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('is idempotent - running again applies nothing', () => {
    const db = openTestDatabase();
    const before = appliedMigrations(db).map((m) => m.name);
    expect(migrate(db)).toEqual([]);
    expect(appliedMigrations(db).map((m) => m.name)).toEqual(before);
    db.close();
  });

  it('records every shipped migration as applied', () => {
    const db = openTestDatabase();
    expect(appliedMigrations(db).map((m) => m.name)).toEqual(loadMigrations().map((m) => m.name));
    db.close();
  });
});

describe('schema integrity', () => {
  it('enforces foreign keys, so a pick cannot reference an unknown player', () => {
    const db = openTestDatabase();
    db.prepare(
      'INSERT INTO manager_state (entry_id, captured_at) VALUES (?, ?)',
    ).run(1234567, nowSeconds());
    const stateId = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

    expect(() =>
      db
        .prepare('INSERT INTO squad_pick (manager_state_id, player_id, slot) VALUES (?, ?, ?)')
        .run(stateId.id, 999999, 1),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('cascades squad picks when a manager state is deleted', () => {
    const db = openTestDatabase();
    const at = nowSeconds();
    db.prepare('INSERT INTO position (id, short_name, singular_name, updated_at, raw_json) VALUES (?,?,?,?,?)')
      .run(1, 'GKP', 'Goalkeeper', at, '{}');
    db.prepare('INSERT INTO team (id, name, short_name, updated_at, raw_json) VALUES (?,?,?,?,?)')
      .run(1, 'Test FC', 'TST', at, '{}');
    db.prepare(
      'INSERT INTO player (id, web_name, team_id, position_id, updated_at) VALUES (?,?,?,?,?)',
    ).run(1, 'Keeper', 1, 1, at);
    db.prepare('INSERT INTO manager_state (entry_id, captured_at) VALUES (?, ?)').run(1, at);
    const { id: stateId } = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    db.prepare('INSERT INTO squad_pick (manager_state_id, player_id, slot) VALUES (?,?,?)').run(
      stateId,
      1,
      1,
    );

    db.prepare('DELETE FROM manager_state WHERE id = ?').run(stateId);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM squad_pick').get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it('keeps one snapshot row per player per snapshot', () => {
    const db = openTestDatabase();
    const at = nowSeconds();
    db.prepare('INSERT INTO position (id, short_name, singular_name, updated_at, raw_json) VALUES (?,?,?,?,?)')
      .run(1, 'GKP', 'Goalkeeper', at, '{}');
    db.prepare('INSERT INTO team (id, name, short_name, updated_at, raw_json) VALUES (?,?,?,?,?)')
      .run(1, 'Test FC', 'TST', at, '{}');
    db.prepare('INSERT INTO player (id, web_name, team_id, position_id, updated_at) VALUES (?,?,?,?,?)')
      .run(1, 'Keeper', 1, 1, at);
    db.prepare('INSERT INTO snapshot (taken_at) VALUES (?)').run(at);
    const { id: snapshotId } = db.prepare('SELECT last_insert_rowid() AS id').get() as {
      id: number;
    };

    const insert = db.prepare(
      'INSERT INTO player_snapshot (snapshot_id, player_id, taken_at, now_cost, status, raw_json) VALUES (?,?,?,?,?,?)',
    );
    insert.run(snapshotId, 1, at, 45, 'a', '{}');
    expect(() => insert.run(snapshotId, 1, at, 45, 'a', '{}')).toThrow(/UNIQUE|PRIMARY KEY/i);
    db.close();
  });
});

describe('time and boolean helpers', () => {
  it('converts API ISO timestamps to unix seconds', () => {
    expect(isoToUnix('2026-08-21T17:30:00Z')).toBe(1787333400);
  });

  it('returns null rather than NaN for missing or malformed timestamps', () => {
    expect(isoToUnix(null)).toBeNull();
    expect(isoToUnix(undefined)).toBeNull();
    expect(isoToUnix('')).toBeNull();
    expect(isoToUnix('not a date')).toBeNull();
  });

  it('round-trips booleans through SQLite integers', () => {
    expect(toSqliteBool(true)).toBe(1);
    expect(toSqliteBool(false)).toBe(0);
    expect(toSqliteBool(null)).toBe(0);
    expect(toSqliteBool(undefined)).toBe(0);
    expect(fromSqliteBool(1)).toBe(true);
    expect(fromSqliteBool(0)).toBe(false);
    expect(fromSqliteBool(null)).toBe(false);
  });
});
