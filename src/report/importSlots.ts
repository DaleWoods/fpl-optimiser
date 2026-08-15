import type { Database } from 'better-sqlite3';
import type { PayloadKind } from '../ingest/import.js';
import { lastSuccessfulRun } from '../ingest/run.js';
import { nowSeconds } from '../db/index.js';
import { formatDuration } from './state.js';
import type { ImportSlot } from './views.js';

/**
 * The import screen's slots.
 *
 * Splitting the upload into named slots does two useful things: it makes the *cadence* obvious
 * (last season is a one-off, this season is weekly), and it lets each slot refuse a file that
 * is not what it asked for, instead of quietly importing the wrong thing.
 */

export interface SlotDefinition {
  id: string;
  title: string;
  cadence: string;
  cadenceTone: 'once' | 'weekly' | 'occasional';
  what: string;
  source: string | null;
  sourceLabel: string | null;
  accepts: PayloadKind[];
  acceptAttr: string;
  /** ingest_run sources that count as "this slot was last filled at...". */
  runSources: string[];
}

const FPL = 'https://fantasy.premierleague.com/api';

export const IMPORT_SLOTS: SlotDefinition[] = [
  {
    id: 'this-season',
    title: "This season's player data",
    cadence: 'Every week',
    cadenceTone: 'weekly',
    what:
      'Every player, price, position, club, injury status and season-to-date stat. This is the ' +
      'file the whole model runs on, and prices and form move constantly - import it before ' +
      'each deadline. Each import also stores a snapshot, so price and injury changes get ' +
      'detected from your second upload onward.',
    source: `${FPL}/bootstrap-static/`,
    sourceLabel: 'bootstrap-static',
    accepts: ['bootstrap'],
    acceptAttr: '.json',
    runSources: ['import:bootstrap-static', 'bootstrap-static'],
  },
  {
    id: 'fixtures',
    title: 'Fixtures',
    cadence: 'When games move',
    cadenceTone: 'occasional',
    what:
      'Every fixture with its difficulty rating. Re-import whenever games are rearranged - ' +
      'European progress and cup ties are what create the double and blank gameweeks that ' +
      'decide chip timing, and the chip advice changes as soon as this does.',
    source: `${FPL}/fixtures/`,
    sourceLabel: 'fixtures',
    accepts: ['fixtures'],
    acceptAttr: '.json',
    runSources: ['import:fixtures', 'fixtures'],
  },
  {
    id: 'last-season',
    title: "Last season's stats",
    cadence: 'One time only',
    cadenceTone: 'once',
    what:
      'Points, minutes and underlying stats from a completed season. It never changes, so this ' +
      'is a one-off. Before a ball is kicked it is the only real evidence there is, and it is ' +
      'what stops opening-gameweek projections ranking on noise. Accepts a CSV - either one row ' +
      "per player per gameweek (richer, preferred) or season totals - or the FPL API's own " +
      'element-summary files. Players are matched by name and club, never by the id in the ' +
      'file, because FPL reassigns ids between seasons.',
    source: `${FPL}/element-summary/1/`,
    sourceLabel: 'element-summary (one per player)',
    accepts: ['season-csv', 'element-summary'],
    acceptAttr: '.csv,.json',
    runSources: [
      'import:season-csv',
      'import:gameweek-csv',
      'import:element-summary',
      'element-summary',
    ],
  },
  {
    id: 'my-squad',
    title: 'Your squad',
    cadence: 'Every week',
    cadenceTone: 'weekly',
    what:
      'Your 15 for a gameweek, plus your chip and transfer history. Loading this turns on ' +
      'transfer advice and points-based chip valuation. Only public once a gameweek has ' +
      'started - before the first deadline there is nothing to download.',
    source: `${FPL}/entry/2651633/event/1/picks/`,
    sourceLabel: 'your picks for a gameweek',
    accepts: ['picks', 'entry', 'entry-history'],
    acceptAttr: '.json',
    runSources: ['import:picks', 'import:entry', 'import:entry-history', 'entry'],
  },
];

/** Attach "last imported" to each slot, so the screen shows what is already in. */
export function buildImportSlots(db: Database): ImportSlot[] {
  const now = nowSeconds();

  return IMPORT_SLOTS.map((slot) => {
    // A slot may be filled by more than one source; the most recent wins.
    let lastImported: number | null = null;
    for (const source of slot.runSources) {
      const run = lastSuccessfulRun(db, source);
      if (run && (lastImported === null || run.startedAt > lastImported)) {
        lastImported = run.startedAt;
      }
    }

    return {
      id: slot.id,
      title: slot.title,
      cadence: slot.cadence,
      cadenceTone: slot.cadenceTone,
      what: slot.what,
      source: slot.source,
      sourceLabel: slot.sourceLabel,
      accepts: slot.accepts,
      acceptAttr: slot.acceptAttr,
      lastImported,
      lastImportedAgo: lastImported === null ? null : formatDuration(now - lastImported),
    };
  });
}
