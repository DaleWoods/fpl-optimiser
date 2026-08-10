#!/usr/bin/env node
import { HttpFplApi } from '../api/httpClient.js';
import { ReplayFplApi } from '../api/replayClient.js';
import type { FplApi } from '../api/client.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { openDatabase } from '../db/index.js';
import { ingestAll } from '../ingest/index.js';
import { recommend } from './recommend.js';
import { startServer } from './server.js';
import { formatDuration, formatMoney, getStateOfPlay } from './state.js';

const USAGE = `
fpl-optimiser - Fantasy Premier League optimiser

Usage:
  fpl ingest [options]     Pull fresh data from the FPL API into local storage
  fpl status               Show the current state of play
  fpl optimise [--gw N]    Recommend the best team for a gameweek
  fpl serve [--port N]     Serve the status report over HTTP
  fpl help                 Show this message

Optimise options:
  --gw N                   Gameweek to advise on (default: the next deadline)
  --scratch                Build a squad from scratch, ignoring any loaded squad
  --budget N               Budget in tenths of a million (default: from rules)

Ingest options:
  --summaries              Also pull per-player match history (one request per
                           player, throttled - slow, but needed by the model)
  --elite                  Also sample what top-ranked managers own (needs a
                           finished gameweek; squads are private before that)
  --no-entry               Skip loading your own squad
  --replay <dir>           Read recorded API payloads from a directory instead
                           of calling the FPL API

Serve options:
  --port N                 Port to listen on (default: PORT env var, or 3000)
  --ingest-interval N      Minutes between background ingestions (default 180,
                           0 disables the scheduler)
`.trim();

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function buildApi(config: ReturnType<typeof loadConfig>, flags: Map<string, string | true>): FplApi {
  const replay = flags.get('replay');
  if (typeof replay === 'string') return new ReplayFplApi(replay);
  return new HttpFplApi(config.app.api, {
    onWarning: (message) => console.warn(`  warning: ${message}`),
  });
}

async function commandIngest(flags: Map<string, string | true>): Promise<number> {
  const config = loadConfig();
  const db = openDatabase({ path: config.app.database.path });
  const api = buildApi(config, flags);

  const result = await ingestAll(db, api, config.rules, {
    teamId: flags.get('no-entry') ? null : config.app.teamId,
    includePlayerSummaries: Boolean(flags.get('summaries')),
    includeEliteOwnership: Boolean(flags.get('elite')),
    onProgress: (message) => console.log(message),
  });

  console.log('\nDone.');
  if (result.bootstrap.changes.length > 0) {
    console.log(`\n${result.bootstrap.changes.length} change(s) since the last snapshot:`);
    for (const change of result.bootstrap.changes.slice(0, 20)) {
      console.log(`  - ${change.note}`);
    }
    if (result.bootstrap.changes.length > 20) {
      console.log(`  ... and ${result.bootstrap.changes.length - 20} more`);
    }
  }

  db.close();
  return 0;
}

function commandStatus(): number {
  const config = loadConfig();
  const db = openDatabase({ path: config.app.database.path });
  const state = getStateOfPlay(db, {
    teamId: config.app.teamId,
    staleAfterSeconds: config.app.staleness.warnAfterSeconds,
  });

  console.log('FPL Optimiser - state of play');
  console.log('='.repeat(60));

  console.log('\nData freshness:');
  for (const entry of state.freshness) {
    const marker = entry.stale ? '!' : ' ';
    const when =
      entry.lastSuccessAt === null ? 'never pulled' : `${formatDuration(entry.ageSeconds)} ago`;
    console.log(`  ${marker} ${entry.source.padEnd(18)} ${when}`);
  }
  if (state.anyStale) {
    console.log('\n  ! Some data is stale. Run `fpl ingest` before trusting any recommendation.');
  }

  console.log(`\nPlayers ingested: ${state.playerCount}   Snapshots kept: ${state.snapshotCount}`);

  if (state.nextDeadline) {
    console.log(
      `\nNext deadline: ${state.nextDeadline.name ?? `GW${state.nextDeadline.eventId}`} - ` +
        `${state.nextDeadline.deadlineIso} (in ${formatDuration(state.nextDeadline.secondsUntil)})`,
    );
  } else {
    console.log('\nNext deadline: unknown (no future gameweek in the ingested data)');
  }

  console.log(`\nTeam ${state.teamId ?? '(not configured)'}`);
  console.log(`  Bank: ${formatMoney(state.bank)}   Squad value: ${formatMoney(state.teamValue)}`);
  console.log(
    `  Free transfers: ${state.freeTransfers ?? 'unknown'}` +
      (state.freeTransfersSource ? ` (${state.freeTransfersSource})` : ''),
  );
  console.log(`  Chips available: ${state.chipsAvailable.join(', ') || 'none recorded'}`);

  if (!state.squadLoaded) {
    console.log(`\n  ${state.squadNote}`);
  } else {
    console.log('\nSquad:');
    for (const player of state.squad) {
      const role = player.isCaptain ? ' (C)' : player.isViceCaptain ? ' (V)' : '';
      const bench = player.slot > 11 ? ' [bench]' : '';
      const flag =
        player.status && player.status !== 'a'
          ? `  ! ${player.status}${player.chanceOfPlaying !== null ? ` ${player.chanceOfPlaying}%` : ''}`
          : '';
      console.log(
        `  ${String(player.slot).padStart(2)} ${player.position} ${player.name.padEnd(16)} ` +
          `${player.team}  ${formatMoney(player.price)}${role}${bench}${flag}`,
      );
    }

    if (state.flaggedInSquad.length > 0) {
      console.log('\nFlagged in your squad:');
      for (const player of state.flaggedInSquad) {
        console.log(`  - ${player.name}: ${player.news || `status '${player.status}'`}`);
      }
    }
  }

  const squadChanges = state.recentChanges.filter((change) => change.inSquad);
  if (squadChanges.length > 0) {
    console.log('\nRecent changes affecting your squad:');
    for (const change of squadChanges.slice(0, 10)) {
      console.log(`  - ${change.name}: ${change.note}`);
    }
  }

  db.close();
  return 0;
}

async function commandOptimise(flags: Map<string, string | true>): Promise<number> {
  const config = loadConfig();
  const db = openDatabase({ path: config.app.database.path });

  const gw = flags.get('gw');
  const budget = flags.get('budget');

  const result = await recommend(db, config.rules, config.weights, {
    teamId: config.app.teamId,
    eventId: typeof gw === 'string' ? Number(gw) : undefined,
    fromScratch: Boolean(flags.get('scratch')),
    budget: typeof budget === 'string' ? Number(budget) : undefined,
  });

  const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

  console.log(`${result.eventName ?? `Gameweek ${result.eventId}`}`);
  console.log('='.repeat(60));
  console.log(`Deadline: ${result.deadlineIso ?? 'unknown'}`);
  console.log(`Model: ${result.modelVersion}   Players considered: ${result.playersConsidered}`);
  if (result.mode === 'build-squad') {
    console.log('\nBuilding a squad from scratch (no existing squad loaded).');
  }

  console.log(
    `\nFormation ${result.eleven.formation}, projected ${result.eleven.expectedPoints.toFixed(1)} points`,
  );
  console.log(`Squad cost ${money(result.totalCost)}, ${money(result.bankRemaining)} left in the bank`);

  console.log('\nStarting XI:');
  for (const player of result.eleven.starters) {
    const role =
      player.playerId === result.eleven.captain.playerId
        ? ' (C)'
        : player.playerId === result.eleven.viceCaptain.playerId
          ? ' (V)'
          : '';
    console.log(
      `  ${player.position} ${player.name.padEnd(18)} ${player.clubShort.padEnd(4)} ` +
        `${money(player.price).padStart(7)}  ${player.xPts.toFixed(2)} xPts${role}` +
        `  [${player.confidence}]`,
    );
    // Why this player: the components that make up the projection, then the narrative.
    const parts = Object.entries(player.breakdown)
      .filter(([, value]) => Math.abs(value) >= 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([name, value]) => `${name} ${value >= 0 ? '+' : ''}${value.toFixed(2)}`);
    if (parts.length > 0) console.log(`       ${parts.join(', ')}`);
    for (const reason of player.reasons) console.log(`       - ${reason}`);
  }

  console.log('\nBench (auto-sub order):');
  for (const [index, player] of result.eleven.bench.entries()) {
    console.log(
      `  ${index + 1}. ${player.position} ${player.name.padEnd(18)} ${player.clubShort.padEnd(4)} ` +
        `${money(player.price).padStart(7)}  ${player.xPts.toFixed(2)} xPts`,
    );
  }

  if (result.transfers.length > 0) {
    console.log('\nSuggested transfers:');
    for (const transfer of result.transfers) {
      console.log(`  ${transfer.out.name} -> ${transfer.in.name} (${transfer.netGain >= 0 ? '+' : ''}${transfer.netGain.toFixed(2)} pts)`);
      console.log(`    ${transfer.reason}`);
    }
  }

  console.log('\nEvidence behind these projections:');
  console.log(`  - ${result.playersConsidered} players considered, model ${result.modelVersion}`);
  if (result.evidence.usingPreviousSeason > 0) {
    console.log(
      `  - ${result.evidence.usingPreviousSeason} player(s) projected from last season's rates ` +
        '(no minutes yet this season)',
    );
  }
  if (result.evidence.intelCompiledAt) {
    console.log(
      `  - curated pre-season notes compiled ${result.evidence.intelCompiledAt}, ` +
        `${result.evidence.intelApplied} adjustment(s) applied`,
    );
  }
  console.log(
    result.evidence.eliteSampleSize > 0
      ? `  - elite-manager ownership sampled for ${result.evidence.eliteSampleSize} players`
      : '  - elite-manager ownership: not available yet (squads are private until GW1 starts)',
  );
  for (const note of result.evidence.contextNotes) console.log(`  - ${note}`);
  if (result.evidence.intelSources.length > 0) {
    console.log('\nSources for the curated notes:');
    for (const source of result.evidence.intelSources) console.log(`  ${source}`);
  }

  if (result.notes.length > 0) {
    console.log('\nNotes:');
    for (const note of result.notes) console.log(`  - ${note}`);
  }

  db.close();
  return 0;
}

async function commandServe(flags: Map<string, string | true>): Promise<number> {
  const config = loadConfig();
  const portFlag = flags.get('port');
  const port = Number(
    typeof portFlag === 'string' ? portFlag : (process.env.PORT ?? 3000),
  );
  const intervalFlag = flags.get('ingest-interval');
  const intervalMinutes = Number(typeof intervalFlag === 'string' ? intervalFlag : 180);

  await startServer({ config, port, ingestIntervalMinutes: intervalMinutes });
  return 0;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'ingest':
      return commandIngest(flags);
    case 'status':
      return commandStatus();
    case 'optimise':
    case 'optimize':
      return commandOptimise(flags);
    case 'serve':
      return commandServe(flags);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command '${command}'.\n`);
      console.error(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    // `serve` never resolves in practice; anything else exits on its own.
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(`\nConfiguration problem:\n${error.message}`);
    } else {
      console.error(`\n${(error as Error).stack ?? String(error)}`);
    }
    process.exitCode = 1;
  });
