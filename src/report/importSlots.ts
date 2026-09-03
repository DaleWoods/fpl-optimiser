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
      'decide chip timing, and the chip advice changes as soon as this does. This file also ' +
      'carries the score once a match finishes, so re-importing it after kickoffs is also how ' +
      'the league table on the Dashboard updates - there is no separate table import.',
    source: `${FPL}/fixtures/`,
    sourceLabel: 'fixtures',
    accepts: ['fixtures'],
    acceptAttr: '.json',
    runSources: ['import:fixtures', 'fixtures'],
  },
  {
    id: 'last-season',
    title: "Last season's stats",
    cadence: 'Nothing to do - automatic',
    cadenceTone: 'once',
    what:
      "Points, minutes and underlying stats, one row per player per gameweek (or season " +
      "totals) - or the FPL API's own element-summary files. Before a ball is kicked, a " +
      "completed season's file is the only real evidence there is, and stops opening-gameweek " +
      "projections ranking on noise. Nothing to upload for this any more, in either direction: " +
      "the app fetches its own element-summary for every player automatically - once, the " +
      "first time the background refresh runs and finds no last-season history at all (no " +
      "gameweek needs to have finished first), and again for CURRENT-season results once each " +
      "gameweek finishes - on the same refresh that already keeps prices and injuries current. " +
      "This slot still accepts a file too, purely as a shortcut if you want something recorded " +
      "sooner than the next scheduled refresh, or you are running locally without the " +
      "background scheduler on - the app tells last season and this season's files apart " +
      "automatically by the season each one names. Players are matched by name and club, " +
      "never by the id in the file, because FPL reassigns ids between seasons.",
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
    cadence: 'Nothing to do - automatic',
    cadenceTone: 'weekly',
    what:
      'Your 15, bank, chip and transfer history. This is what turns on transfer advice and ' +
      'points-based chip valuation, but there is nothing to upload for it: whenever a team ID ' +
      'is configured, the server loads it itself on every background refresh, the same as ' +
      "prices and fixtures. Only public once a gameweek has started - before the first " +
      'deadline the FPL API has nothing to return yet, automatically or otherwise. This slot ' +
      'still takes a manual upload too, purely as a shortcut if you want it sooner than the ' +
      "next scheduled refresh. The file itself only lists player IDs, never names - that's " +
      'the FPL API, not a bug in this file; the app resolves each ID against the player data ' +
      'already imported from bootstrap-static.',
    source: `${FPL}/entry/2651633/event/1/picks/`,
    sourceLabel: 'your picks for a gameweek',
    accepts: ['picks', 'entry', 'entry-history'],
    acceptAttr: '.json',
    runSources: ['import:picks', 'import:entry', 'import:entry-history', 'entry'],
  },
  {
    id: 'my-team-prices',
    title: 'Your real selling prices and free transfers',
    cadence: 'When you make transfers',
    cadenceTone: 'occasional',
    what:
      'Two numbers the public API does not publish, and which this app otherwise has to infer. ' +
      'FPL sells a player for what you paid plus half of any rise, so for anyone who has gone ' +
      'up in price the current price overstates what selling them frees up - which is how a ' +
      'suggested transfer turns out to be one you cannot actually afford. This file has the ' +
      'real figure for each of your 15, and the true free-transfer count that the hit ' +
      'arithmetic depends on. You must be logged in to fantasy.premierleague.com in the same ' +
      'browser for the link to return anything; it cannot be fetched automatically for exactly ' +
      'that reason. Re-upload whenever you make a transfer - prices only change when you do.',
    source: `${FPL}/my-team/2651633/`,
    sourceLabel: 'my-team',
    accepts: ['my-team'],
    acceptAttr: '.json',
    runSources: ['import:my-team'],
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
