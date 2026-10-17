import type { Database } from 'better-sqlite3';
import { ApiError, type FplApi } from '../api/client.js';
import type { Rules } from '../config/schema.js';
import { deriveFreeTransfers, type GameweekTransferRecord } from '../domain/freeTransfers.js';
import { nowSeconds, toSqliteBool } from '../db/index.js';
import { recordGameweekResult } from '../model/accuracy.js';
import { withIngestRun } from './run.js';

export interface EntryIngestResult {
  managerStateId: number;
  rowsWritten: number;
  fromCache: boolean;
  fetchedAt: number;
  /** The gameweek the loaded picks belong to, or null when no squad exists yet. */
  picksEvent: number | null;
  picksLoaded: boolean;
  freeTransfers: number | null;
  freeTransfersSource: 'api' | 'derived' | 'manual' | 'unknown';
  notes: string[];
}

/**
 * Load the manager's own state: bank, team value, chips, free transfers and current squad.
 *
 * Two things the public API simply does not provide, and which are therefore recorded with an
 * explicit source rather than guessed:
 *
 *  - **Free transfers.** Only the authenticated my-team endpoint states them. We derive the
 *    count from transfer history under the rollover rules and mark it 'derived'.
 *  - **Purchase and selling prices.** Not exposed publicly at all. Left null with
 *    price_source 'unknown' until supplied; the transfer engine must then decline to reason
 *    about budget rather than invent one.
 *
 * Before the season's first deadline there is no squad to load. The picks endpoint 404s, which
 * is expected rather than a fault: manager state is still recorded, picksLoaded is false, and a
 * note explains why.
 */
export async function ingestEntry(
  db: Database,
  api: FplApi,
  teamId: number,
  rules: Rules,
): Promise<EntryIngestResult> {
  return withIngestRun(db, 'entry', async () => {
    const notes: string[] = [];
    const at = nowSeconds();

    const entryResult = await api.entry(teamId);
    const entry = entryResult.data;

    // History drives both chip usage and the free-transfer derivation.
    let transferHistory: GameweekTransferRecord[] = [];
    let chipsUsed: { name: string; event: number | null }[] = [];
    const chipUsage = new Map<number, string>();

    try {
      const historyResult = await api.entryHistory(teamId);
      chipsUsed = historyResult.data.chips.map((chip) => ({
        name: chip.name,
        event: chip.event,
      }));
      for (const chip of chipsUsed) {
        if (chip.event !== null) chipUsage.set(chip.event, chip.name);
      }
      transferHistory = historyResult.data.current.map((row) => ({
        event: row.event,
        transfersMade: row.event_transfers ?? 0,
        transfersCost: row.event_transfers_cost ?? 0,
        chip: chipUsage.get(row.event) ?? null,
      }));

      // What you actually scored each gameweek, so the Accuracy page can put its own advice
      // next to the real outcome. This was previously recorded only when an entry-history file
      // was uploaded by hand, so for anyone relying on the automatic refresh - the normal case -
      // the "You scored" column stayed permanently blank and the model's advice could never be
      // compared against what really happened.
      for (const row of historyResult.data.current) {
        recordGameweekResult(db, teamId, row.event, {
          actualPoints: row.points,
          benchPoints: row.points_on_bench,
          transfersMade: row.event_transfers,
          transferCost: row.event_transfers_cost,
          chip: chipUsage.get(row.event) ?? null,
        });
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.notFound) {
        notes.push(
          'No entry history yet - this looks like a brand new season, so chips are all ' +
            'available and no transfers have been made.',
        );
      } else {
        throw cause;
      }
    }

    const derivation = deriveFreeTransfers(transferHistory, rules, { chipUsage });
    notes.push(...derivation.caveats);

    // Which gameweek's picks should we load? The entry's current_event, when there is one.
    const picksEvent = entry.current_event ?? null;
    let picks: { element: number; position: number; multiplier: number; isCaptain: boolean; isVice: boolean }[] =
      [];
    let picksLoaded = false;
    let bank = entry.last_deadline_bank;
    let teamValue = entry.last_deadline_value;
    let activeChip: string | null = null;

    if (picksEvent === null) {
      notes.push(
        'No gameweek has started yet, so there is no squad to load. Set up your 15 before the ' +
          'first deadline, or supply it manually, and the optimiser can work with it.',
      );
    } else {
      try {
        const picksResult = await api.entryPicks(teamId, picksEvent);
        picks = picksResult.data.picks.map((pick) => ({
          element: pick.element,
          position: pick.position,
          multiplier: pick.multiplier,
          isCaptain: pick.is_captain,
          isVice: pick.is_vice_captain,
        }));
        picksLoaded = true;
        activeChip = picksResult.data.active_chip ?? null;
        if (picksResult.data.entry_history) {
          bank = picksResult.data.entry_history.bank ?? bank;
          teamValue = picksResult.data.entry_history.value ?? teamValue;
        }
      } catch (cause) {
        if (cause instanceof ApiError && cause.notFound) {
          notes.push(
            `No squad recorded for gameweek ${picksEvent} yet. That is normal before the ` +
              'deadline for a manager who has not made their picks.',
          );
        } else {
          throw cause;
        }
      }
    }

    const knownPlayers = new Set(
      (db.prepare('SELECT id FROM player').all() as { id: number }[]).map((row) => row.id),
    );
    const unknownPicks = picks.filter((pick) => !knownPlayers.has(pick.element));
    if (unknownPicks.length > 0) {
      notes.push(
        `${unknownPicks.length} squad player(s) are not in the local database. Run a bootstrap ` +
          'ingestion first so every pick can be resolved.',
      );
    }
    const storablePicks = picks.filter((pick) => knownPlayers.has(pick.element));

    const insertState = db.prepare(`
      INSERT INTO manager_state (
        entry_id, captured_at, event_id, bank, team_value, total_points, overall_rank,
        free_transfers, free_transfers_source, chips_available_json, chips_used_json, raw_json
      ) VALUES (
        @entry_id, @captured_at, @event_id, @bank, @team_value, @total_points, @overall_rank,
        @free_transfers, @free_transfers_source, @chips_available_json, @chips_used_json, @raw_json
      )
    `);

    const insertPick = db.prepare(`
      INSERT INTO squad_pick (manager_state_id, player_id, slot, multiplier, is_captain,
                              is_vice_captain, purchase_price, selling_price, price_source)
      VALUES (@manager_state_id, @player_id, @slot, @multiplier, @is_captain,
              @is_vice_captain, NULL, NULL, 'unknown')
    `);

    const chipsAvailable = rules.chips.available.filter(
      (chip) => !chipsUsed.some((used) => used.name === chip),
    );

    const write = db.transaction((): number => {
      const info = insertState.run({
        entry_id: teamId,
        captured_at: at,
        event_id: picksEvent,
        bank,
        team_value: teamValue,
        total_points: entry.summary_overall_points,
        overall_rank: entry.summary_overall_rank,
        free_transfers: derivation.freeTransfers,
        free_transfers_source: 'derived',
        chips_available_json: JSON.stringify(chipsAvailable),
        chips_used_json: JSON.stringify(chipsUsed),
        raw_json: JSON.stringify({
          entry,
          activeChip,
          freeTransferWorkings: derivation.workings,
        }),
      });
      const managerStateId = Number(info.lastInsertRowid);

      for (const pick of storablePicks) {
        insertPick.run({
          manager_state_id: managerStateId,
          player_id: pick.element,
          slot: pick.position,
          multiplier: pick.multiplier,
          is_captain: toSqliteBool(pick.isCaptain),
          is_vice_captain: toSqliteBool(pick.isVice),
        });
      }

      return managerStateId;
    });

    const managerStateId = write();

    notes.push(
      'Purchase and selling prices are not available from the public API, so transfer budget ' +
        'is unknown until they are supplied.',
    );

    return {
      managerStateId,
      rowsWritten: 1 + storablePicks.length,
      fromCache: entryResult.fromCache,
      fetchedAt: entryResult.fetchedAt,
      picksEvent,
      picksLoaded,
      freeTransfers: derivation.freeTransfers,
      freeTransfersSource: 'derived' as const,
      notes,
    };
  });
}

export interface HistoricPicksResult {
  /** Gameweeks whose picks were fetched and stored by this run. */
  backfilled: number[];
  /** Gameweeks already on record, so nothing was fetched for them. */
  alreadyHeld: number[];
  notes: string[];
}

/**
 * Fetch and store the squad held in every past gameweek, not just the current one.
 *
 * The backtest can only replay a week it knows the squad for, and the only squad ever recorded
 * was the one showing at the time of an ingest. That capped the usable sample at the weeks
 * somebody happened to be running this app, which is a hard floor on how much can ever be
 * proved about the model - with five gameweeks the smallest edge detectable at all is larger
 * than any edge worth arguing about.
 *
 * The data was there the whole time. A manager's picks become public the moment a gameweek
 * starts, and stay public, so every completed week of the season can be fetched on demand.
 * This walks them and stores the ones not already held.
 *
 * Each backfilled week is written as its own manager_state row carrying only what the picks
 * endpoint actually knows: the squad, the armband, the bank and team value at that deadline.
 * Chips, free transfers and overall rank are left as they are rather than back-dated from
 * today's figures, which would be lookahead dressed up as history.
 */
export async function backfillHistoricPicks(
  db: Database,
  api: FplApi,
  teamId: number,
  options: { throughEvent: number },
): Promise<HistoricPicksResult> {
  const backfilled: number[] = [];
  const alreadyHeld: number[] = [];
  const notes: string[] = [];

  const held = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT ms.event_id AS eventId
           FROM manager_state ms
           JOIN squad_pick sp ON sp.manager_state_id = ms.id
           WHERE ms.entry_id = ? AND ms.event_id IS NOT NULL`,
        )
        .all(teamId) as { eventId: number }[]
    ).map((row) => row.eventId),
  );

  const knownPlayers = new Set(
    (db.prepare('SELECT id FROM player').all() as { id: number }[]).map((row) => row.id),
  );
  if (knownPlayers.size === 0) {
    notes.push('No players loaded yet, so past squads cannot be resolved. Refresh the data first.');
    return { backfilled, alreadyHeld, notes };
  }

  const insertState = db.prepare(`
    INSERT INTO manager_state (
      entry_id, captured_at, event_id, bank, team_value, total_points, overall_rank,
      free_transfers, free_transfers_source, chips_available_json, chips_used_json, raw_json
    ) VALUES (
      @entry_id, @captured_at, @event_id, @bank, @team_value, NULL, NULL,
      NULL, 'unknown', '[]', '[]', @raw_json
    )
  `);
  const insertPick = db.prepare(`
    INSERT INTO squad_pick (manager_state_id, player_id, slot, multiplier, is_captain,
                            is_vice_captain, purchase_price, selling_price, price_source)
    VALUES (@manager_state_id, @player_id, @slot, @multiplier, @is_captain,
            @is_vice_captain, NULL, NULL, 'unknown')
  `);

  for (let eventId = 1; eventId <= options.throughEvent; eventId += 1) {
    if (held.has(eventId)) {
      alreadyHeld.push(eventId);
      continue;
    }

    let picks;
    try {
      picks = (await api.entryPicks(teamId, eventId)).data;
    } catch (cause) {
      // A 404 means that gameweek has not started, or this entry did not exist for it. Both
      // are ordinary facts about the season rather than faults, so the walk simply carries on.
      if (cause instanceof ApiError && cause.notFound) continue;
      throw cause;
    }

    const storable = picks.picks.filter((pick) => knownPlayers.has(pick.element));
    if (storable.length === 0) continue;

    const write = db.transaction(() => {
      const info = insertState.run({
        entry_id: teamId,
        captured_at: nowSeconds(),
        event_id: eventId,
        bank: picks.entry_history?.bank ?? null,
        team_value: picks.entry_history?.value ?? null,
        raw_json: JSON.stringify({ backfilled: true, activeChip: picks.active_chip ?? null }),
      });
      const managerStateId = Number(info.lastInsertRowid);
      for (const pick of storable) {
        insertPick.run({
          manager_state_id: managerStateId,
          player_id: pick.element,
          slot: pick.position,
          multiplier: pick.multiplier,
          is_captain: toSqliteBool(pick.is_captain),
          is_vice_captain: toSqliteBool(pick.is_vice_captain),
        });
      }
    });
    write();
    backfilled.push(eventId);
  }

  if (backfilled.length > 0) {
    notes.push(
      `Recovered the squad you held in gameweek${backfilled.length === 1 ? '' : 's'} ` +
        `${backfilled.join(', ')} from the public picks endpoint, so those weeks can be replayed.`,
    );
  }

  return { backfilled, alreadyHeld, notes };
}
