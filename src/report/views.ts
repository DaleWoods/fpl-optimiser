import type { GameweekAccuracy, SeasonAccuracy } from '../model/accuracy.js';
import type { CalibrationFactor } from '../model/calibration.js';

/** What calibrationProgress() returns: how close the model is to correcting itself. */
interface CalibrationProgress {
  gradedUnderCurrentModel: number;
  needed: number;
  gradedUnderOtherModels: number;
}
import type { ChipAdvice } from '../optimise/chips.js';
import type { PayloadKind } from '../ingest/import.js';
import type { ResetScope } from '../ingest/reset.js';
import { escapeHtml, renderShell } from './layout.js';
import type { PriorityFixPlan, Readiness, Recommendation } from './recommend.js';
import type { LeagueTableRow } from '../model/table.js';
import { formatDuration, formatMoney, type StateOfPlay } from './state.js';

/** Every page in the app, sharing one shell so the tabs and styling stay consistent. */

export function renderError(title: string, message: string, activePath: string): string {
  return renderShell({
    title: `${title} - FPL Optimiser`,
    activePath,
    body: `<div class="card">
      <h2 style="margin-top:0">${escapeHtml(title)}</h2>
      <pre style="white-space:pre-wrap;margin:.5rem 0 0;font:inherit">${escapeHtml(message)}</pre>
    </div>`,
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function renderDashboard(state: StateOfPlay & { leagueTable?: LeagueTableRow[] }): string {
  const table = (state.leagueTable ?? []).filter((row) => row.played > 0);
  const leagueRows = table
    .map(
      (row) => `<tr>
        <td>${row.position}</td><td>${escapeHtml(row.name)}</td><td>${row.played}</td>
        <td>${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td><td><strong>${row.points}</strong></td>
      </tr>`,
    )
    .join('');
  const staleSources = state.freshness.filter((entry) => entry.stale).map((entry) => entry.source);
  const staleBanner =
    staleSources.length > 0
      ? `<div class="banner warn"><strong>Some data is stale: ${escapeHtml(staleSources.join(', '))}.</strong>
         Refresh it before trusting a recommendation &mdash; see Data freshness below.</div>`
      : '';

  const deadline = state.nextDeadline
    ? `${escapeHtml(state.nextDeadline.name ?? `GW${state.nextDeadline.eventId}`)}
       <span class="muted">&middot; ${escapeHtml(state.nextDeadline.deadlineIso ?? 'unknown')}
       (in ${formatDuration(state.nextDeadline.secondsUntil)})</span>`
    : '<span class="muted">unknown - import fixtures</span>';

  const freshnessRows = state.freshness
    .map(
      (entry) => `<tr class="${entry.stale ? 'stale' : ''}">
        <td>${escapeHtml(entry.source)}</td>
        <td>${entry.lastSuccessAt === null ? '<span class="muted">never</span>' : `${formatDuration(entry.ageSeconds)} ago`}</td>
      </tr>`,
    )
    .join('');

  const squadRows = state.squad
    .map((player) => {
      const role = player.isCaptain
        ? '<span class="badge">C</span>'
        : player.isViceCaptain
          ? '<span class="badge v">V</span>'
          : '';
      const flagged = player.status !== null && player.status !== 'a';
      return `<tr class="${flagged ? 'flagged' : ''}${player.slot > 11 ? ' bench' : ''}">
        <td>${player.slot}</td>
        <td>${escapeHtml(player.position)}</td>
        <td>${escapeHtml(player.name)} ${role}</td>
        <td>${escapeHtml(player.team)}</td>
        <td>${formatMoney(player.price)}</td>
        <td>${flagged ? escapeHtml(player.news || `status '${player.status}'`) : ''}</td>
      </tr>`;
    })
    .join('');

  const changeRows = state.recentChanges
    .slice(0, 25)
    .map(
      (change) => `<tr class="${change.inSquad ? 'flagged' : ''}">
        <td>${escapeHtml(change.name)}</td>
        <td>${escapeHtml(change.kind)}</td>
        <td>${escapeHtml(change.note)}</td>
      </tr>`,
    )
    .join('');

  const body = `
  ${staleBanner}

  <p style="font-size:1.05rem"><strong>Next deadline:</strong> ${deadline}</p>

  <div class="grid">
    <div class="stat"><div class="label">Bank</div><div class="value">${formatMoney(state.bank)}</div></div>
    <div class="stat"><div class="label">Squad value</div><div class="value">${formatMoney(state.teamValue)}</div></div>
    <div class="stat"><div class="label">Free transfers</div><div class="value">${
      state.freeTransfers ?? '&mdash;'
    }</div><div class="muted" style="font-size:.78rem">${escapeHtml(state.freeTransfersSource ?? '')}</div></div>
    <div class="stat"><div class="label">Players tracked</div><div class="value">${state.playerCount}</div></div>
    <div class="stat"><div class="label">Snapshots</div><div class="value">${state.snapshotCount}</div></div>
  </div>

  <p style="margin-top:1.2rem">
    <a class="btn accent" href="/optimise">Generate my best team for ${escapeHtml(
      state.nextDeadline?.name ?? 'the next gameweek',
    )}</a>
    ${
      state.squadLoaded
        ? `<a class="btn ghost" href="/optimise?generate=1&refresh=1" style="margin-left:.4rem">
             End gameweek &amp; plan next</a>`
        : ''
    }
    <a class="btn ghost" href="/chips" style="margin-left:.4rem">Chip strategy</a>
  </p>
  ${
    state.squadLoaded
      ? `<p class="muted" style="font-size:.85rem;margin:.3rem 0 0">"End gameweek" refreshes
         live data first (results, prices, your picks), then generates a team for the next
         deadline and shows exactly what changed &mdash; captain, vice-captain, subs and
         transfers &mdash; from what you had.</p>`
      : ''
  }

  <h2>Your squad</h2>
  ${
    state.squadLoaded
      ? `<div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
          <thead><tr><th>#</th><th>Pos</th><th>Player</th><th>Club</th><th>Price</th><th>Note</th></tr></thead>
          <tbody>${squadRows}</tbody></table></div></div>`
      : `<div class="card"><p class="muted" style="margin:0">${escapeHtml(
          state.squadNote ?? 'No squad loaded.',
        )}</p>
        <p style="margin:.6rem 0 0"><a class="btn ghost" href="/import">Import your squad</a></p></div>`
  }

  <h2>Data freshness</h2>
  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
    <thead><tr><th>Source</th><th>Last successful import</th></tr></thead>
    <tbody>${freshnessRows}</tbody></table></div></div>

  ${
    table.length > 0
      ? `<h2>League table <span class="muted" style="font-weight:400">(computed from imported
         results - it feeds back into club strength)</span></h2>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
           <thead><tr><th>#</th><th>Club</th><th>P</th><th>GD</th><th>Pts</th></tr></thead>
           <tbody>${leagueRows}</tbody></table></div></div>`
      : state.playerCount > 0
        ? `<h2>League table</h2>
           <div class="card"><p class="muted" style="margin:0">No results yet, so there is
           nothing to show. There is nothing to import for this either &mdash; the Fixtures file
           already carries the score once a match finishes, so re-importing fixtures after
           gameweek 1 fills this in automatically and feeds it straight back into club strength.</p></div>`
        : ''
  }

  <h2>Recent changes</h2>
  ${
    state.recentChanges.length > 0
      ? `<div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
          <thead><tr><th>Player</th><th>Kind</th><th>Change</th></tr></thead>
          <tbody>${changeRows}</tbody></table></div></div>`
      : `<div class="card"><p class="muted" style="margin:0">Nothing yet. Changes appear once
         there are two imports to compare, so price and injury moves show up from your second
         weekly upload onward.</p></div>`
  }`;

  return renderShell({
    title: 'FPL Optimiser',
    activePath: '/',
    subtitle: `Team ${state.teamId ?? 'not configured'}`,
    body,
  });
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/** vs NEW (H) with a difficulty pill, "@ LIV (A) FDR5", "+" between two for a double, or BLANK. */
export function formatFixtures(fixtures: { opponentShort: string; isHome: boolean; difficulty: number | null }[]): string {
  if (fixtures.length === 0) return '<span class="muted">BLANK</span>';
  return fixtures
    .map((fixture) => {
      const fdr =
        fixture.difficulty !== null
          ? ` <span class="pill${fixture.difficulty >= 4 ? ' bad' : ''}">FDR${fixture.difficulty}</span>`
          : '';
      return `${fixture.isHome ? 'vs' : '@'} ${escapeHtml(fixture.opponentShort)}${fdr}`;
    })
    .join(' + ');
}

/** One player on the pitch view: a plain shirt (no per-club kit colours - no licensed asset for
 *  that here), name, opponent and xPts underneath. */
function shirtCard(
  player: {
    playerId: number;
    name: string;
    clubShort: string;
    price: number;
    xPts: number;
    fixtures: { opponentShort: string; isHome: boolean; difficulty: number | null }[];
  },
  options: { captainId: number; viceCaptainId: number; benchIndex?: number },
): string {
  const armband =
    player.playerId === options.captainId
      ? '<span class="armband">C</span>'
      : player.playerId === options.viceCaptainId
        ? '<span class="armband v">V</span>'
        : '';
  const fixtureText =
    player.fixtures.length === 0
      ? 'BLANK'
      : player.fixtures.map((f) => `${f.isHome ? 'vs' : '@'} ${f.opponentShort}`).join(' + ');

  return `<div class="shirt-card${options.benchIndex !== undefined ? ' bench' : ''}">
    ${armband}
    <div class="shirt">${escapeHtml(player.clubShort)}</div>
    <div class="name">${options.benchIndex !== undefined ? `${options.benchIndex}. ` : ''}${escapeHtml(player.name)}</div>
    <div class="meta"><span>${escapeHtml(fixtureText)}</span><span>${player.xPts.toFixed(1)} xPts</span></div>
  </div>`;
}

/** The starting XI laid out on a pitch by formation, plus a substitutes strip below it -
 *  mirroring the actual FPL team page rather than a table, so the squad reads at a glance. */
function renderPitch(eleven: {
  starters: {
    playerId: number;
    name: string;
    clubShort: string;
    position: string;
    price: number;
    xPts: number;
    fixtures: { opponentShort: string; isHome: boolean; difficulty: number | null }[];
  }[];
  bench: {
    playerId: number;
    name: string;
    clubShort: string;
    position: string;
    price: number;
    xPts: number;
    fixtures: { opponentShort: string; isHome: boolean; difficulty: number | null }[];
  }[];
  captain: { playerId: number };
  viceCaptain: { playerId: number };
}): string {
  const options = { captainId: eleven.captain.playerId, viceCaptainId: eleven.viceCaptain.playerId };

  // Attacking end at the top, same convention as the FPL site's own pitch view.
  const rows = ['FWD', 'MID', 'DEF', 'GKP']
    .map((position) => eleven.starters.filter((player) => player.position === position))
    .filter((group) => group.length > 0)
    .map(
      (group) =>
        `<div class="pitch-row">${group.map((player) => shirtCard(player, options)).join('')}</div>`,
    )
    .join('');

  const bench = eleven.bench
    .map((player, index) => shirtCard(player, { ...options, benchIndex: index + 1 }))
    .join('');

  return `<div class="pitch">${rows}</div>
  <div class="bench-strip">
    <div class="bench-label">Substitutes &middot; auto-sub order</div>
    <div class="pitch-row">${bench}</div>
  </div>`;
}

function playerRow(
  player: {
    position: string;
    name: string;
    clubShort: string;
    price: number;
    xPts: number;
    confidence: string;
    breakdown: Record<string, number>;
    reasons: string[];
    fixtures: { opponentShort: string; isHome: boolean; difficulty: number | null }[];
  },
  marker = '',
): string {
  const parts = Object.entries(player.breakdown)
    .filter(([, value]) => Math.abs(value) >= 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(
      ([name, value]) =>
        `<span class="pill">${escapeHtml(name)} ${value >= 0 ? '+' : ''}${value.toFixed(2)}</span>`,
    )
    .join(' ');

  const reasons = player.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');

  return `<tr>
    <td>${escapeHtml(player.position)}</td>
    <td>${escapeHtml(player.name)} ${marker}</td>
    <td>${escapeHtml(player.clubShort)}</td>
    <td>${formatFixtures(player.fixtures)}</td>
    <td>${formatMoney(player.price)}</td>
    <td><strong>${player.xPts.toFixed(2)}</strong></td>
    <td class="muted">${escapeHtml(player.confidence)}</td>
  </tr>
  <tr><td></td><td colspan="6" style="padding-top:0">
    <details><summary>why this player?</summary>
      <div class="parts">${parts}</div>
      ${reasons ? `<ul class="tight">${reasons}</ul>` : ''}
    </details>
  </td></tr>`;
}

/**
 * The team you would have if you acted on every priority fix, with the hit cost stated up front.
 *
 * The point of showing the cost this prominently is that it is the part a list of transfer
 * cards cannot tell you. Each card is costed as though it were the only move of the week, so
 * three cards each showing "+2.4 pts" quietly hide the fact that doing all three costs eight
 * points, and may well be a net loss. Netting it out here, once, is the honest presentation -
 * including when the answer is that the plan is not worth it.
 */
function renderPriorityFixPlan(plan: PriorityFixPlan & { doneOutIds: Set<number> }): string {
  const worthIt = plan.netGain >= 0;
  const paidFor = Math.min(plan.moves.length, plan.freeTransfers);

  const costLine =
    plan.hitCost > 0
      ? `<strong>${plan.moves.length} transfers</strong>, ${paidFor} free &mdash;
         <strong>${plan.hitsTaken} hit${plan.hitsTaken === 1 ? '' : 's'} at
         ${plan.hitCost / plan.hitsTaken} points each, costing you
         ${plan.hitCost} points</strong>.`
      : `<strong>${plan.moves.length} transfer${plan.moves.length === 1 ? '' : 's'}</strong>,
         all covered by your ${plan.freeTransfers} free &mdash; <strong>no hit</strong>.`;

  const moves = plan.moves
    .map(
      (move) => `<tr>
        <td>${escapeHtml(move.out.name)} <span class="muted">${escapeHtml(move.out.clubShort)}</span></td>
        <td class="muted">${move.out.xPts.toFixed(2)}</td>
        <td>&rarr;</td>
        <td><strong>${escapeHtml(move.in.name)}</strong> <span class="muted">${escapeHtml(move.in.clubShort)}</span></td>
        <td><strong>${move.in.xPts.toFixed(2)}</strong></td>
        <td>${(() => {
          // Signed, because a downgrade freeing money up reads as a very different move from
          // an upgrade spending it, and an unsigned "£1.5m" cannot tell you which happened.
          const change = move.in.price - move.out.price;
          return change === 0
            ? '<span class="muted">level</span>'
            : `${change > 0 ? '+' : '&minus;'}${formatMoney(Math.abs(change))}`;
        })()}</td>
        <td><label class="done-box${plan.doneOutIds.has(move.out.playerId) ? ' done' : ''}">
          <input type="checkbox" data-done-out="${move.out.playerId}"
                 data-done-in="${move.in.playerId}"${plan.doneOutIds.has(move.out.playerId) ? ' checked' : ''}>
          <span>Done</span></label></td>
      </tr>`,
    )
    .join('');

  return `<h2>Your team with every priority fix</h2>
  <p class="muted" style="font-size:.88rem;margin:0 0 .6rem">Every squad member barely projected
  to feature, replaced in one go &mdash; applied in sequence, so each move only spends money the
  previous one left and the three-per-club limit still holds. This is a whole team, not a
  shopping list: it is an alternative to the single transfers below, not something to do on top
  of them.</p>

  <div class="card" style="border-color:${worthIt ? 'var(--ok)' : 'var(--warn-fg)'}">
    <h3 style="margin:0 0 .5rem">What it costs you</h3>
    <p style="margin:.2rem 0">${costLine}</p>
    <div class="gw-foot" style="grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));border-top:0;padding-top:.2rem">
      <div><div class="k">XI now</div><div class="v">${plan.elevenBefore.expectedPoints.toFixed(1)}</div></div>
      <div><div class="k">XI after</div><div class="v">${plan.eleven.expectedPoints.toFixed(1)}</div></div>
      <div><div class="k">Hit</div><div class="v">${plan.hitCost > 0 ? `&minus;${plan.hitCost}` : '0'}</div></div>
      <div><div class="k">Net, this week</div><div class="v">${
        plan.gainBeforeHit - plan.hitCost >= 0 ? '+' : '&minus;'
      }${Math.abs(plan.gainBeforeHit - plan.hitCost).toFixed(1)}</div></div>
      <div><div class="k">Net, over the run</div><div class="v" style="color:${worthIt ? 'var(--ok)' : 'var(--danger)'}">${
        plan.netGain >= 0 ? '+' : '&minus;'
      }${Math.abs(plan.netGain).toFixed(1)}</div></div>
    </div>
    <p style="margin:.7rem 0 0">${
      worthIt
        ? `The fixes gain <strong>${(plan.gainBeforeHit + plan.horizonGain).toFixed(1)}</strong> points
           across this gameweek and the run of fixtures after it, against
           <strong>${plan.hitCost}</strong> paid in hits &mdash; <strong>worth doing</strong>, on
           these projections.`
        : `The fixes gain <strong>${(plan.gainBeforeHit + plan.horizonGain).toFixed(1)}</strong> points
           across this gameweek and the run of fixtures after it, against
           <strong>${plan.hitCost}</strong> paid in hits. That is a <strong>net loss of
           ${Math.abs(plan.netGain).toFixed(1)}</strong>: doing all of it at once is not worth it.
           Spread the fixes over the next few gameweeks, using your free transfer each week, and
           you get the same team without paying for it.`
    }</p>
    ${
      plan.unresolved.length > 0
        ? `<p class="muted" style="margin:.5rem 0 0">${plan.unresolved
            .map((p) => escapeHtml(p.name))
            .join(', ')} could not be fixed &mdash; nothing legal and affordable was available at
            that position once the other moves were paid for.</p>`
        : ''
    }
  </div>

  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
    <thead><tr><th>Out</th><th>xPts</th><th></th><th>In</th><th>xPts</th><th>Price change</th>
      <th>Made it?</th></tr></thead>
    <tbody>${moves}</tbody></table></div></div>

  ${renderPitch(plan.eleven)}
  <p class="muted" style="font-size:.88rem;margin:.5rem 0 0">Captain
    <strong>${escapeHtml(plan.eleven.captain.name)}</strong>, vice
    <strong>${escapeHtml(plan.eleven.viceCaptain.name)}</strong>. Squad cost
    ${formatMoney(plan.totalCost)}, ${formatMoney(plan.bankRemaining)} left in the bank.</p>`;
}

export function renderRecommendation(
  rec: Recommendation,
  options: { generatedAt?: number } = {},
): string {
  const head = `<thead><tr><th>Pos</th><th>Player</th><th>Club</th><th>Fixture</th><th>Price</th><th>xPts</th><th>Confidence</th></tr></thead>`;

  const starters = rec.eleven.starters
    .map((player) =>
      playerRow(
        player,
        player.playerId === rec.eleven.captain.playerId
          ? '<span class="badge">C</span>'
          : player.playerId === rec.eleven.viceCaptain.playerId
            ? '<span class="badge v">V</span>'
            : '',
      ),
    )
    .join('');

  const bench = rec.eleven.bench
    .map((player, index) => playerRow(player, `<span class="muted">#${index + 1}</span>`))
    .join('');

  const doneOutIds = new Set(rec.confirmedTransfers.map((t) => t.outPlayerId));

  /**
   * "I made this one" against each suggestion.
   *
   * FPL publishes your picks only for a gameweek that has already started, so for the whole week
   * between one ending and the next beginning the app is looking at last week's team. Without a
   * way to say what you have actually done, every piece of advice in that window quietly assumes
   * you still own players you may have sold days ago.
   */
  const doneBox = (transfer: { out: { playerId: number; name: string }; in: { playerId: number; name: string } }): string => {
    const done = doneOutIds.has(transfer.out.playerId);
    return `<label class="done-box${done ? ' done' : ''}">
      <input type="checkbox" data-done-out="${transfer.out.playerId}"
             data-done-in="${transfer.in.playerId}"${done ? ' checked' : ''}>
      <span>${done ? 'Done &mdash; applied to your squad' : 'I made this transfer'}</span>
    </label>`;
  };

  const transfers =
    rec.transfers.length > 0
      ? rec.transfers
          .map(
            (transfer) => `<div class="card"${transfer.priority ? ' style="border-color:var(--warn-fg)"' : ''}>
              <h3>${transfer.priority ? '<span class="pill" style="background:var(--warn-fg);color:#000">Priority fix</span> ' : ''}${escapeHtml(transfer.out.name)} &rarr; ${escapeHtml(transfer.in.name)}
                <span class="pill good">${transfer.netGain >= 0 ? '+' : ''}${transfer.netGain.toFixed(2)} pts</span></h3>
              <p class="muted" style="margin:0">${escapeHtml(transfer.reason)}</p>
              ${doneBox(transfer)}
            </div>`,
          )
          .join('')
      : '';

  const age =
    options.generatedAt === undefined
      ? ''
      : `<span class="muted" style="margin-left:.6rem;font-size:.88rem">Built
         ${formatDuration(Math.floor(Date.now() / 1000) - options.generatedAt)} ago, from the data
         on disk now. Rebuild only if something has changed.</span>`;

  const body = `
  <p style="margin:0 0 .6rem">
    <a class="btn ghost" href="/optimise?generate=1">Rebuild</a>
    <button class="btn danger" data-clear-squad style="margin-left:.4rem">Clear squad</button>${age}
  </p>

  ${
    rec.mode === 'build-squad'
      ? `<div class="banner info">This is a squad built from scratch within the budget, because
         no existing squad is loaded.</div>`
      : ''
  }
  ${rec.lowConfidence ? `<div class="banner warn">Most projections are low confidence &mdash; see the evidence below.</div>` : ''}

  <div class="grid">
    <div class="stat"><div class="label">Formation</div><div class="value">${escapeHtml(rec.eleven.formation)}</div></div>
    <div class="stat"><div class="label">Expected score</div><div class="value">${rec.eleven.expectedPoints.toFixed(1)}</div></div>
    <div class="stat"><div class="label">Squad cost</div><div class="value">${formatMoney(rec.totalCost)}</div></div>
    <div class="stat"><div class="label">In the bank</div><div class="value">${formatMoney(rec.bankRemaining)}</div></div>
  </div>

  <p style="margin-top:1rem">Captain <strong>${escapeHtml(rec.eleven.captain.name)}</strong>,
     vice <strong>${escapeHtml(rec.eleven.viceCaptain.name)}</strong>.${
       rec.eleven.captain.ceiling !== undefined
         ? ` <span class="muted">${escapeHtml(rec.eleven.captain.name)} projects
            ${rec.eleven.captain.xPts.toFixed(1)} with a good week around
            ${rec.eleven.captain.ceiling.toFixed(1)}${
              rec.eleven.captain.haulProbability !== undefined
                ? `, and a ${Math.round(rec.eleven.captain.haulProbability * 100)}% chance of a
                   double-figure haul`
                : ''
            } &mdash; the armband doubles one score, so the shape of it matters, not just the
            average.</span>`
         : ''
     }${
       rec.captaincy === null
         ? ''
         : rec.captaincy.tooClose
           ? ` <span class="muted">${escapeHtml(rec.captaincy.runnerUpName)} projects
              ${rec.captaincy.runnerUpXPts.toFixed(1)}${
                rec.captaincy.margin < 0
                  ? ' - <strong>higher</strong>, and was passed over only because the ' +
                    'captain carries more upside for the same average'
                  : `, ${Math.abs(rec.captaincy.margin).toFixed(1)} behind`
              }. That is inside the margin where this model cannot honestly separate two
              players${
                rec.lowConfidence
                  ? ', and most projections this week are low confidence'
                  : ''
              }, so treat it as two similar bets rather than a verdict - your own read on the
              fixture is worth as much here.</span>`
           : ` <span class="muted">Clear of ${escapeHtml(rec.captaincy.runnerUpName)}
              (${rec.captaincy.runnerUpXPts.toFixed(1)}) by
              ${rec.captaincy.margin.toFixed(1)}.</span>`
     }</p>

  ${
    rec.previousComparison
      ? `<h2>Changed since ${escapeHtml(
          rec.previousComparison.previousEventName ?? `gameweek ${rec.previousComparison.previousEventId}`,
        )}</h2>
         <div class="card"><ul class="tight">
           ${
             rec.previousComparison.anyChange
               ? [
                   rec.previousComparison.captain
                     ? `<li>Captain: ${escapeHtml(rec.previousComparison.captain.from.name)}
                        &rarr; <strong>${escapeHtml(rec.previousComparison.captain.to.name)}</strong></li>`
                     : '',
                   rec.previousComparison.viceCaptain
                     ? `<li>Vice-captain: ${escapeHtml(rec.previousComparison.viceCaptain.from.name)}
                        &rarr; <strong>${escapeHtml(rec.previousComparison.viceCaptain.to.name)}</strong></li>`
                     : '',
                   ...rec.previousComparison.movedIntoXi.map(
                     (p) => `<li><strong>${escapeHtml(p.name)}</strong> moves into the starting XI (was on the bench, not a transfer).</li>`,
                   ),
                   ...rec.previousComparison.movedToBench.map(
                     (p) => `<li><strong>${escapeHtml(p.name)}</strong> drops to the bench (still in your squad, not a transfer).</li>`,
                   ),
                   rec.previousComparison.benchOrderChanged
                     ? `<li>Bench order changed &mdash; check the auto-sub priority below.</li>`
                     : '',
                   rec.transfers.length > 0
                     ? `<li>${rec.transfers.length} transfer(s) suggested below.</li>`
                     : '',
                 ]
                   .filter(Boolean)
                   .join('')
               : `<li class="muted">Nothing changed &mdash; same XI, bench order, captain and vice-captain.</li>`
           }
         </ul></div>`
      : ''
  }

  <h2>Starting XI</h2>
  ${renderPitch(rec.eleven)}

  <details style="margin-top:.9rem">
    <summary style="cursor:pointer;color:var(--muted);font-size:.85rem">Table view, prices &amp; why each pick</summary>
    <p class="muted" style="font-size:.88rem;margin:.7rem 0 .5rem">
      <strong>Confidence</strong> is how much real playing-time evidence backs a player's own
      rate &mdash; not whether this is a good pick. A nailed-on starter can be high confidence and
      still low-scoring in a tough fixture, both at once; check the <strong>Fixture</strong>
      column and FDR for that. Confidence only turns low when the evidence itself is thin (little
      or no minutes, or a rate carried over from last season).
    </p>
    <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${head}<tbody>${starters}</tbody></table></div></div>

    <h3 style="margin-top:1rem">Bench <span class="muted" style="font-weight:400">(auto-sub order)</span></h3>
    <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${head}<tbody>${bench}</tbody></table></div></div>
  </details>

  ${rec.priorityFixPlan ? renderPriorityFixPlan({ ...rec.priorityFixPlan, doneOutIds }) : ''}

  ${
    rec.transfers.length > 0
      ? `<h2>Suggested transfers</h2>
         <p class="muted" style="font-size:.88rem;margin:0 0 .5rem">Each card below is a
         standalone alternative for <strong>one</strong> transfer slot, costed as if it were the
         only change made this gameweek &mdash; not a shopping list to act on all at once. Pick
         the one you want (a <span class="pill" style="background:var(--warn-fg);color:#000">Priority
         fix</span> badge means that squad member is barely projected to feature at all, and is
         shown regardless of how it ranks by points).</p>
         ${transfers}`
      : ''
  }

  ${
    rec.transferPlan
      ? `<h2>Squad rebuild worth considering</h2>
         <p class="muted" style="font-size:.88rem;margin:0 0 .5rem">Sometimes a player is only
         affordable by changing more than one at once &mdash; the whole squad considered
         together, not swap by swap. This is an alternative to the single transfers above, not
         on top of them.</p>
         <div class="card">
           <h3 style="margin:0 0 .4rem">${rec.transferPlan.playersOut.length} transfers
             <span class="pill good">${rec.transferPlan.netGain >= 0 ? '+' : ''}${rec.transferPlan.netGain.toFixed(2)} pts net</span>
             ${
               rec.transferPlan.hitsTaken > 0
                 ? `<span class="pill" style="background:var(--warn-fg);color:#000">-${rec.transferPlan.hitCost} hit</span>`
                 : '<span class="pill">no hit</span>'
             }
           </h3>
           <p style="margin:.3rem 0"><strong>Out:</strong> ${rec.transferPlan.playersOut
             .map((p) => escapeHtml(p.name))
             .join(', ')}</p>
           <p style="margin:.3rem 0"><strong>In:</strong> ${rec.transferPlan.playersIn
             .map((p) => escapeHtml(p.name))
             .join(', ')}</p>
           <p class="muted" style="margin:.3rem 0;font-size:.88rem">New squad cost
             ${formatMoney(rec.transferPlan.totalCost)}, ${formatMoney(rec.transferPlan.bankRemaining)}
             left in the bank.</p>
         </div>`
      : ''
  }

  <h2>Evidence behind these projections</h2>
  <div class="card"><ul class="tight">
    <li>${rec.playersConsidered} players considered, model ${escapeHtml(rec.modelVersion)}</li>
    <li>${
      rec.evidence.lastSeasonPlayers === 0
        ? `<strong>No last-season history loaded.</strong> Import it on the
           <a href="/import">Import Data</a> tab. Without it every thin rate this season is
           shrunk toward zero rather than toward what the player actually did, which roughly
           halves each projection and squeezes the good players toward the ordinary ones`
        : rec.evidence.usingPreviousSeason > 0
          ? `${rec.evidence.usingPreviousSeason} player(s) projected from last season's rates,
             because this season has no minutes yet
             (${rec.evidence.lastSeasonPlayers} players have last-season history)`
          : `${rec.evidence.lastSeasonPlayers} players have last-season history, anchoring this
             season's thin rates to what they actually did rather than to zero`
    }</li>
    <li>${
      rec.evidence.intelCompiledAt
        ? `Curated pre-season notes compiled ${escapeHtml(rec.evidence.intelCompiledAt)},
           ${rec.evidence.intelApplied} adjustment(s) applied` +
          (rec.evidence.intelPriceMismatches > 0
            ? `, ${rec.evidence.intelPriceMismatches} withheld on a price mismatch`
            : '') +
          (rec.evidence.intelUnmatched.length > 0
            ? `, ${rec.evidence.intelUnmatched.length} matched no player`
            : '')
        : 'No curated notes file loaded'
    }</li>
    <li>${
      rec.evidence.eliteSampleSize > 0
        ? `Elite-manager ownership sampled for ${rec.evidence.eliteSampleSize} players, and it is
           nudging their projections up where it applies &mdash; see "Owned by...% of the top
           managers" in a player's reasons`
        : 'Elite-manager ownership: not available yet &mdash; squads stay private until a gameweek ' +
          'starts, which the FPL platform itself enforces. Once it is, top managers\' actual picks ' +
          'will boost those players\' projections directly, not just get mentioned.'
    }</li>
    <li>${
      rec.evidence.calibration.length > 0
        ? `Corrected from ${rec.evidence.calibration[0]!.gameweeks} graded gameweek(s) of the
           model's own error: ${rec.evidence.calibration
             .filter((c) => c.factor !== 1)
             .map((c) => `${escapeHtml(c.position)} ×${c.factor.toFixed(3)}`)
             .join(', ') || 'no position needed one'}`
        : 'No correction from past accuracy yet - that needs several graded gameweeks behind it, ' +
          'and until then a measured lean is just one week&rsquo;s variance'
    }</li>
    <li>Transfers and captaincy judged over ${rec.evidence.horizonGameweeks} gameweek(s) ahead,
      weighted most heavily toward this one &mdash; see "run of fixtures after this gameweek" on
      a transfer for what that changed</li>
    ${rec.evidence.contextNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
  </ul></div>

  ${
    rec.notes.length > 0
      ? `<h2>Notes</h2><div class="card"><ul class="tight">${rec.notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join('')}</ul></div>`
      : ''
  }

  ${
    rec.evidence.intelSources.length > 0
      ? `<h2>Sources for the curated notes</h2><div class="card"><ul class="tight">${rec.evidence.intelSources
          .map(
            (src) =>
              `<li><a href="${escapeHtml(src)}" rel="noreferrer noopener">${escapeHtml(src)}</a></li>`,
          )
          .join('')}</ul></div>`
      : ''
  }`;

  return renderShell({
    title: `${rec.eventName ?? `GW${rec.eventId}`} - FPL Optimiser`,
    activePath: '/optimise',
    subtitle: `${rec.eventName ?? `Gameweek ${rec.eventId}`} · deadline ${rec.deadlineIso ?? 'unknown'}`,
    body,
    script: CLEAR_SQUAD_SCRIPT,
  });
}

// ---------------------------------------------------------------------------
// Generate gate (My Team, before a team has been generated)
// ---------------------------------------------------------------------------

const CLEAR_SQUAD_SCRIPT = `
document.querySelectorAll('.done-box input[data-done-out]').forEach((box) => {
  box.onchange = async () => {
    const label = box.closest('.done-box');
    label.classList.add('saving');
    try {
      const res = await fetch('/confirm-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outPlayerId: Number(box.dataset.doneOut),
          inPlayerId: Number(box.dataset.doneIn),
          done: box.checked,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      // Reload so every number on the page reflects the squad you actually have. Showing a
      // ticked box next to advice still built on the old squad would be worse than not
      // offering the tick at all.
      location.reload();
    } catch (err) {
      box.checked = !box.checked;
      label.classList.remove('saving');
      alert('Could not save that: ' + err.message);
    }
  };
});

document.querySelectorAll('[data-clear-squad]').forEach((btn) => {
  btn.onclick = async () => {
    if (!confirm('Clear the loaded squad? Imports and last-season history are kept.')) return;
    btn.disabled = true;
    await fetch('/reset?scope=squad', { method: 'POST' });
    location.href = '/optimise';
  };
});
`;

export function renderGenerate(options: {
  readiness: Readiness;
  eventName: string | null;
  squadLoaded: boolean;
  blockedAttempt?: boolean;
  /** A page was generated before, but the data has moved since - a different sentence. */
  supersededByNewData?: boolean;
}): string {
  const { readiness } = options;

  const rows = readiness.checks
    .map(
      (check) => `<div class="card" style="display:flex;gap:.8rem;align-items:flex-start">
        <div style="font-size:1.2rem;line-height:1.3">${
          check.ok ? '<span style="color:var(--ok)">&#10003;</span>' : check.required ? '<span style="color:var(--danger)">&#10007;</span>' : '<span class="muted">&ndash;</span>'
        }</div>
        <div>
          <strong>${escapeHtml(check.label)}</strong>
          ${check.required ? '' : '<span class="pill" style="margin-left:.4rem">signal</span>'}
          <div class="muted" style="font-size:.9rem">${escapeHtml(check.detail)}</div>
        </div>
      </div>`,
    )
    .join('');

  const body = `
  ${
    options.blockedAttempt
      ? `<div class="banner warn"><strong>Not ready to generate yet.</strong> Missing:
         ${readiness.missing.map((m) => escapeHtml(m)).join(', ')}. Import them on the
         <a href="/import">Import Data</a> tab first.</div>`
      : ''
  }

  ${
    options.supersededByNewData
      ? `<div class="banner info"><strong>New data has arrived since your last team was
         built.</strong> Build it again to use it.</div>`
      : `<div class="banner info"><strong>Nothing is built until you click the button.</strong>
         A team is only worth acting on when it is built from all the evidence at once, so this
         waits for this season's players, the fixtures and last season's stats.</div>`
  }

  ${rows}

  <p style="margin-top:1.2rem">
    ${
      readiness.ready
        ? `<a class="btn accent" href="/optimise?generate=1">Generate my best team for ${escapeHtml(
            options.eventName ?? 'the next gameweek',
          )}</a>`
        : `<button class="btn accent" disabled title="Import the missing data first">Generate my best team</button>
           <a class="btn ghost" href="/import" style="margin-left:.4rem">Go to Import Data</a>`
    }
    ${
      options.squadLoaded
        ? `<button class="btn danger" data-clear-squad style="margin-left:.4rem">Clear squad</button>`
        : ''
    }
  </p>
  ${
    options.squadLoaded
      ? '<p class="muted" style="font-size:.9rem">Clear squad removes the loaded 15 (and bank/chip history) so the next generate starts from a blank slate. Your imports are kept.</p>'
      : ''
  }`;

  return renderShell({
    title: 'My Team - FPL Optimiser',
    activePath: '/optimise',
    subtitle: 'Generate a team when you are ready - never automatically',
    body,
    script: options.squadLoaded ? CLEAR_SQUAD_SCRIPT : undefined,
  });
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function renderChips(advice: ChipAdvice, fromEvent: number): string {
  const rows = advice.horizon
    .map((shape) => {
      const marks: string[] = [];
      if (shape.doubleClubs.length > 0) {
        marks.push(`<span class="pill good">DOUBLE</span> ${escapeHtml(shape.doubleClubs.join(', '))}`);
      }
      if (shape.blankClubs.length > 0) {
        marks.push(`<span class="pill">BLANK</span> ${shape.blankClubs.length} clubs`);
      }
      if (shape.squadDoubles > 0) marks.push(`${shape.squadDoubles} of your 15 play twice`);
      if (shape.squadBlanks > 0) marks.push(`${shape.squadBlanks} of your 15 blank`);
      return `<tr${shape.doubleClubs.length || shape.blankClubs.length ? ' class="special"' : ''}>
        <td><strong>GW${shape.eventId}</strong></td>
        <td>${shape.fixtureCount}</td>
        <td>${marks.join(' &middot; ') || '<span class="muted">normal</span>'}</td>
      </tr>`;
    })
    .join('');

  const recs = advice.recommendations
    .map(
      (rec) => `<div class="card">
        <h3>${escapeHtml(rec.chipName)} &mdash; ${
          rec.recommendedEvent === null
            ? '<span class="muted">hold for now</span>'
            : rec.confident
              ? `<strong>GW${rec.recommendedEvent}</strong>`
              // The model set confident=false because it could not separate this week from
              // several others - it sorted a tie rather than finding a week. Printing a bold
              // gameweek here read as a recommendation and flatly contradicted the paragraph
              // underneath it, which is the one thing this page must never do with a chip that
              // is worth one play a season.
              : '<span class="muted">no standout week &mdash; hold</span>'
        }${rec.confident ? ` <span class="pill good">+${rec.expectedGain} pts</span>` : ''}</h3>
        <p class="muted" style="margin:.2rem 0">${escapeHtml(rec.reason)}</p>
        ${
          rec.alternatives.length > 0
            ? `<p class="muted" style="margin:.2rem 0">Next best: ${rec.alternatives
                .map((a) => `GW${a.eventId} (+${a.gain})`)
                .join(', ')}</p>`
            : ''
        }
        ${rec.warning ? `<p style="color:var(--warn-fg);margin:.3rem 0 0">! ${escapeHtml(rec.warning)}</p>` : ''}
      </div>`,
    )
    .join('');

  const body = `
  <p class="muted" style="font-size:.88rem;margin:0 0 .8rem">Chips are one-per-half-season, so
  holding out for the biggest window is usually worth more than playing the first decent one -
  <a href="/chips?horizon=30">look ahead across the whole rest of the season</a> to check nothing
  bigger is already on the fixture list.</p>

  <h2>Recommendations</h2>
  ${recs || '<div class="card"><p class="muted" style="margin:0">No chips left to advise on.</p></div>'}

  <h2>Fixtures ahead</h2>
  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
    <thead><tr><th>Gameweek</th><th>Fixtures</th><th>Shape</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>

  ${
    advice.notes.length > 0
      ? `<h2>Notes</h2><div class="card"><ul class="tight">${advice.notes
          .map((n) => `<li>${escapeHtml(n)}</li>`)
          .join('')}</ul></div>`
      : ''
  }`;

  return renderShell({
    title: 'Chip strategy - FPL Optimiser',
    activePath: '/chips',
    subtitle: `From GW${fromEvent}, looking ${advice.horizon.length} gameweek(s) ahead`,
    body,
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportSlot {
  id: string;
  title: string;
  cadence: string;
  cadenceTone: 'once' | 'weekly' | 'occasional';
  what: string;
  source: string | null;
  sourceLabel: string | null;
  accepts: PayloadKind[];
  acceptAttr: string;
  lastImported: number | null;
  lastImportedAgo: string | null;
}

export function renderImport(slots: ImportSlot[]): string {
  const cards = slots
    .map(
      (slot) => `<div class="card" data-slot="${escapeHtml(slot.id)}">
      <div style="display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap">
        <h3 style="margin:0">${escapeHtml(slot.title)}</h3>
        <span class="pill${slot.cadenceTone === 'once' ? ' good' : ''}">${escapeHtml(slot.cadence)}</span>
      </div>
      <p class="muted" style="margin:.35rem 0">${escapeHtml(slot.what)}</p>
      ${
        slot.source
          ? `<p style="margin:.35rem 0;font-size:.9rem">Get it from
             <a href="${escapeHtml(slot.source)}" rel="noreferrer noopener" target="_blank">${escapeHtml(
               slot.sourceLabel ?? slot.source,
             )}</a> &mdash; open it and save the page.</p>`
          : ''
      }
      <p style="margin:.35rem 0;font-size:.9rem">
        <strong>Last imported:</strong> ${
          slot.lastImportedAgo
            ? `<span class="pill good">${escapeHtml(slot.lastImportedAgo)} ago</span>`
            : '<span class="pill">never</span>'
        }
      </p>
      <input type="file" id="file-${escapeHtml(slot.id)}" accept="${escapeHtml(slot.acceptAttr)}" multiple hidden>
      <p style="margin:.6rem 0 0">
        <button class="btn" data-choose="${escapeHtml(slot.id)}">Choose file</button>
        <button class="btn ghost" data-paste="${escapeHtml(slot.id)}" style="margin-left:.4rem">Paste instead</button>
        <span class="muted" style="margin-left:.5rem;font-size:.88rem">or drop it on this card</span>
      </p>
      <div id="paste-${escapeHtml(slot.id)}" hidden style="margin-top:.6rem">
        <textarea id="text-${escapeHtml(slot.id)}" rows="6" spellcheck="false"
          placeholder="Paste the JSON here, then press Import."
          style="width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;
                 padding:.6rem;border-radius:8px;border:1px solid var(--line);
                 background:var(--bg);color:var(--fg)"></textarea>
        <p style="margin:.4rem 0 0">
          <button class="btn" data-paste-go="${escapeHtml(slot.id)}">Import pasted text</button>
        </p>
      </div>
      <div class="log" id="log-${escapeHtml(slot.id)}"></div>
    </div>`,
    )
    .join('');

  const script = `
const slots = ${JSON.stringify(slots.map((s) => s.id))};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function line(logEl, cls, html) {
  const el = document.createElement('div');
  el.className = 'result ' + cls;
  el.innerHTML = html;
  logEl.appendChild(el);
  return el;
}

/**
 * Import text that did not come from a file.
 *
 * The my-team endpoint cannot be opened in the address bar - it wants a bearer token the browser
 * does not send on a plain navigation - so the only way to get that file is to copy the response
 * out of developer tools. That leaves you holding text on a clipboard, and requiring it be saved
 * to disk first is a step for the app's convenience rather than yours.
 */
async function sendText(slotId, text, label) {
  const logEl = document.getElementById('log-' + slotId);
  const row = line(logEl, 'pending', 'Importing ' + esc(label) + '…');
  try {
    const res = await fetch('/import?slot=' + encodeURIComponent(slotId) +
                            '&name=' + encodeURIComponent(label), {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
    });
    const body = await res.json();
    if (!res.ok) {
      row.className = 'result bad';
      row.innerHTML = '<strong>' + esc(label) + '</strong><br>' + esc(body.error || res.statusText);
      return;
    }
    row.className = 'result good';
    row.innerHTML = '<strong>' + esc(label) + '</strong><br>' + esc(body.detail) +
      (body.warnings || []).map((w) => '<div class="warn">! ' + esc(w) + '</div>').join('');
  } catch (err) {
    row.className = 'result bad';
    row.innerHTML = '<strong>' + esc(label) + '</strong><br>' + esc(err.message);
  }
}

async function send(slotId, files) {
  const logEl = document.getElementById('log-' + slotId);
  // bootstrap first where several files are dropped together: later files reference it.
  const rank = (f) => (/bootstrap/i.test(f.name) ? 0 : /fixture/i.test(f.name) ? 1 : 2);
  [...files].sort((a, b) => rank(a) - rank(b));

  for (const file of files) {
    const row = line(logEl, 'pending', 'Importing ' + esc(file.name) + '…');
    try {
      const text = await file.text();
      const res = await fetch('/import?slot=' + encodeURIComponent(slotId) +
                              '&name=' + encodeURIComponent(file.name), {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
      });
      const body = await res.json();
      if (!res.ok) {
        row.className = 'result bad';
        row.innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + esc(body.error || res.statusText);
        continue;
      }
      row.className = 'result good';
      row.innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + esc(body.detail) +
        (body.warnings || []).map((w) => '<div class="warn">! ' + esc(w) + '</div>').join('');
    } catch (err) {
      row.className = 'result bad';
      row.innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + esc(err.message);
    }
  }
}

for (const slotId of slots) {
  const card = document.querySelector('[data-slot="' + slotId + '"]');
  const input = document.getElementById('file-' + slotId);
  document.querySelector('[data-choose="' + slotId + '"]').onclick = () => input.click();
  const pasteBtn = document.querySelector('[data-paste="' + slotId + '"]');
  const pasteBox = document.getElementById('paste-' + slotId);
  const textArea = document.getElementById('text-' + slotId);
  if (pasteBtn && pasteBox && textArea) {
    pasteBtn.onclick = () => {
      pasteBox.hidden = !pasteBox.hidden;
      if (!pasteBox.hidden) textArea.focus();
    };
    document.querySelector('[data-paste-go="' + slotId + '"]').onclick = () => {
      const text = textArea.value.trim();
      if (!text) return;
      sendText(slotId, text, 'pasted text');
      textArea.value = '';
      pasteBox.hidden = true;
    };
  }
  input.onchange = () => send(slotId, input.files);
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('over');
    send(slotId, e.dataTransfer.files);
  });
}

const fetchBtn = document.getElementById('fetch-now');
const fetchStatus = document.getElementById('fetch-status');
if (fetchBtn) {
  const poll = async () => {
    try {
      const res = await fetch('/healthz');
      const body = await res.json();
      if (body.ingesting) {
        fetchStatus.textContent = 'Fetching… this can take a while the first time.';
        setTimeout(poll, 2000);
      } else if (body.lastIngestError) {
        fetchStatus.textContent = 'Finished with a problem: ' + body.lastIngestError;
        fetchBtn.disabled = false;
      } else {
        fetchStatus.textContent = 'Done - reloading…';
        setTimeout(() => location.reload(), 600);
      }
    } catch (err) {
      fetchStatus.textContent = 'Lost track of progress: ' + err.message;
      fetchBtn.disabled = false;
    }
  };
  fetchBtn.onclick = async () => {
    fetchBtn.disabled = true;
    fetchStatus.textContent = 'Started…';
    try {
      await fetch('/ingest', { method: 'POST' });
      setTimeout(poll, 1000);
    } catch (err) {
      fetchStatus.textContent = 'Could not start: ' + err.message;
      fetchBtn.disabled = false;
    }
  };
}
`;

  const body = `
  <div class="card" style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
    <button class="btn accent" id="fetch-now">Fetch latest data now</button>
    <span class="muted" id="fetch-status" style="font-size:.9rem"></span>
  </div>
  <p class="muted" style="font-size:.88rem;margin:.4rem 0 0">Most of what's below already
  arrives on its own &mdash; the server refreshes prices, fixtures, your squad and last
  season's history automatically in the background, with no file needed. This button just
  forces that refresh right now instead of waiting for the next scheduled one. The cards below
  are for the two genuine exceptions: uploading something sooner than the schedule, or supplying
  detail (like a community stats export) the FPL API itself doesn't carry.</p>

  <div class="banner info" style="margin-top:.8rem">Each slot below accepts one kind of file and
  checks what you give it, so a file dropped in the wrong place is refused with an explanation
  rather than quietly imported as the wrong thing.</div>

  <style>
    .card.over { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,255,135,.2); }
    .result { margin-top:.5rem; padding:.5rem .7rem; border:1px solid var(--line);
              border-radius:8px; font-size:.9rem; }
    .result.good { border-left:4px solid var(--ok); }
    .result.bad { border-left:4px solid var(--danger); }
    .result.pending { opacity:.7; }
    .result .warn { color:var(--warn-fg); font-size:.86rem; margin-top:.25rem; }
  </style>

  ${cards}

  <h2>Order matters</h2>
  <div class="card"><p style="margin:0">Import <strong>this season's player data first</strong>.
  Fixtures, squads and last-season stats all reference players and clubs, so importing them
  into an empty database drops rows. If you have just reset, start at the top and work down.</p></div>`;

  return renderShell({
    title: 'Import data - FPL Optimiser',
    activePath: '/import',
    subtitle: 'Feed the optimiser real data',
    body,
    script,
  });
}

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

function errorRows(players: GameweekAccuracy['overRated']): string {
  return players
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.name)}${
          p.inRecommendedXi
            ? ' <span class="pill" style="background:var(--warn-fg);color:#000">yours</span>'
            : ''
        }</td>
        <td>${escapeHtml(p.position)}</td>
        <td>${escapeHtml(p.club)}</td>
        <td>${p.predicted.toFixed(2)}</td>
        <td><strong>${p.actual}</strong></td>
        <td style="color:${p.error > 0 ? 'var(--danger)' : 'var(--ok)'}">${p.error > 0 ? '+' : ''}${p.error.toFixed(2)}</td>
      </tr>`,
    )
    .join('');
}

/**
 * A gameweek's projected-vs-actual result, as a single scannable card.
 *
 * This is the page's headline evidence: the number the model committed to before the deadline,
 * and the number that actually came back. Everything else on the page - mean error, bias, the
 * per-position breakdown - is a way of explaining that gap, so it comes after it, not before.
 */
/**
 * The best XI available from the 15 the advice was built on - suppressed when the week's own
 * numbers contradict it.
 *
 * It is computed from the squad stored with that gameweek's recommendation, which is the squad
 * the app could see at the time. The public API only returns picks for a gameweek that has
 * already started, so a team generated before the deadline is working from last week's 15: make
 * a transfer and the stored squad is not the one you fielded. When that happens this figure can
 * come out *below* the score you actually got, which is impossible for a genuine ceiling and
 * makes the whole column untrustworthy. Better to show nothing than a number the same row
 * disproves.
 */
function bestFromSquadCell(gw: SeasonAccuracy['gameweeks'][number]): string {
  const best = gw.bestPossibleFromSquad;
  if (best === null || best === undefined) return '<span class="muted">&mdash;</span>';
  if (gw.yourActual !== null && gw.yourActual !== undefined && gw.yourActual > best) {
    return '<span class="muted" title="The 15 on file for this gameweek were not the 15 you played">n/a</span>';
  }
  return String(best);
}

function gameweekScorecard(gw: SeasonAccuracy['gameweeks'][number]): string {
  const predicted = gw.recommendedXiPredicted;
  const actual = gw.recommendedXiActual;
  const delta = predicted !== null && actual !== null ? actual - predicted : null;

  // Direction is stated in words and names its subject; colour then signals only *how far out*
  // it was. Guessing low is not a better kind of wrong than guessing high.
  const deltaChip =
    delta === null
      ? '<span class="delta none">not played yet</span>'
      : Math.abs(delta) <= 5
        ? '<span class="delta close">we were close</span>'
        : `<span class="delta off">we guessed ${Math.abs(delta).toFixed(1)} too ${
            delta > 0 ? 'low' : 'high'
          }</span>`;

  const num = (value: number | null | undefined, dp = 0): string =>
    value === null || value === undefined
      ? '<span class="muted">&mdash;</span>'
      : dp > 0
        ? value.toFixed(dp)
        : String(value);

  // Two different teams, and that is the whole reason there is more than one score here. The
  // card used to run all of them together in one grid, which read as three attempts to say the
  // same thing - so each is now under a heading naming whose team it was.
  const yourScore = gw.yourActual;
  const comparison =
    yourScore === null || actual === null
      ? ''
      : yourScore === actual
        ? '<div class="gw-note">Same score as our XI.</div>'
        : `<div class="gw-note">You ${yourScore > actual ? 'beat' : 'trailed'} our XI by
           ${Math.abs(yourScore - actual)}.</div>`;

  return `<div class="gw-card">
    <div class="gw-head"><span class="gw-name">Gameweek ${gw.eventId}</span>${deltaChip}</div>

    <div class="gw-block">
      <div class="gw-who">The team <strong>we</strong> told you to play</div>
      <div class="vs">
        <div class="side"><div class="k">we guessed</div>
          <div class="v">${num(predicted, 1)}</div></div>
        <div class="arrow">&rarr;</div>
        <div class="side"><div class="k">it really scored</div>
          <div class="v">${num(actual)}</div></div>
      </div>
    </div>

    <div class="gw-block">
      <div class="gw-who">The team <strong>you</strong> actually played</div>
      <div class="vs">
        <div class="side"><div class="k">you scored</div>
          <div class="v">${num(yourScore)}</div></div>
      </div>
      ${comparison}
    </div>

    <div class="gw-foot">
      <div><div class="k">Average manager</div><div class="v">${num(gw.leagueAverage)}</div></div>
      <div><div class="k">Top manager</div><div class="v">${num(gw.leagueHighest)}</div></div>
    </div>
  </div>`;
}

/**
 * What the model has learned from grading itself, and what it did about it.
 *
 * Shown on the page rather than applied quietly, because a correction the reader cannot see is
 * indistinguishable from the model just changing its mind. Renders a line saying so when there
 * is not enough graded football yet, rather than an empty table - "not measured" and "measured
 * and fine" are different claims and should not look the same.
 */
function renderCalibration(
  factors: readonly CalibrationFactor[],
  progress: CalibrationProgress | null = null,
): string {
  if (factors.length === 0) {
    // "Nothing yet" on its own gives no way to tell "two more gameweeks" apart from "this will
    // never happen because the scoring version keeps moving". The second was the real situation
    // for a while, and it was completely invisible from here.
    // "Nothing yet" reads as "it is not measuring anything", which is wrong and is the
    // complaint this answers: it measures every week (see the reliability figures below) and
    // withholds the *correction* until it has enough of them under one scoring version. Saying
    // which gameweek it becomes usable turns an unexplained blank into a countdown.
    const detail = progress
      ? (() => {
          const short = Math.max(0, progress.needed - progress.gradedUnderCurrentModel);
          const stale =
            progress.gradedUnderOtherModels > 0
              ? ` The ${progress.gradedUnderOtherModels} graded before that change do not count:
                 a correction learned from scoring that has since been fixed would be correcting
                 a mistake that no longer exists.`
              : '';
          return ` It has <strong>${progress.gradedUnderCurrentModel} of the
            ${progress.needed}</strong> it needs, so it starts correcting after
            <strong>${short} more gameweek${short === 1 ? '' : 's'}</strong>.${stale}`;
        })()
      : '';
    return `<h2>What the model has learned</h2>
      <div class="banner info">It is measuring itself every week &mdash; see how far out it
      typically is, below. What it will not do yet is <em>correct</em> itself: one or two weeks
      of a lean is just variance, and acting on it would make the projections worse.${detail}</div>`;
  }

  const rows = factors
    .map((f) => {
      const uncorrected = f.factor === 1;
      return `<tr>
        <td><strong>${escapeHtml(f.position)}</strong></td>
        <td>${f.samplePlayers}</td>
        <td style="color:${Math.abs(f.observedBias) < 0.25 ? 'var(--ok)' : 'var(--warn-fg)'}">${
          f.observedBias > 0 ? 'ran high by ' : 'ran low by '
        }${Math.abs(f.observedBias).toFixed(2)}</td>
        <td><strong>${uncorrected ? '<span class="muted">none</span>' : `×${f.factor.toFixed(3)}`}</strong></td>
      </tr>`;
    })
    .join('');

  return `<h2>What the model has learned</h2>
  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
    <thead><tr><th>Position</th><th>Graded projections</th><th>Measured lean</th>
      <th>Correction applied</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
  <details class="explain">
    <summary>How a correction gets made, and what stops it running away</summary>
    <div class="inner">
      <p>Every graded gameweek is compared, per position, against what was projected. The
      correction is a <em>ratio</em> &mdash; what happened over what was said &mdash; not a flat
      number of points, because half a point means something very different for a goalkeeper
      projected at 3 than for a captain projected at 9.</p>
      <p>It is then shrunk hard toward no correction at all by how much evidence is behind it,
      the same caution every rate in this model gets, and clamped at both ends. A model needing
      more correction than the clamp allows has a bug to be found, not a lean to be tuned out,
      and quietly applying a larger one would hide it.</p>
      <p>The correction is always measured against the projection <em>before</em> any previous
      correction was applied. Measured against its own corrected output, a correction that was
      working would look unnecessary and get thrown away, the error would come back the next
      week, and the model would flip between corrected and uncorrected forever.</p>
      <p>It moves which players get picked, and it is stated in the reasons on the My Team tab
      wherever it applied. It never touches the per-component breakdown, which stays a true
      description of the model that produced it.</p>
    </div>
  </details>`;
}

export function renderAccuracy(
  season: SeasonAccuracy,
  latest: GameweekAccuracy | null,
  calibration: readonly CalibrationFactor[] = [],
  calibrationProgress: CalibrationProgress | null = null,
): string {
  const errHead = `<thead><tr><th>Player</th><th>Pos</th><th>Club</th><th>Predicted</th><th>Actual</th><th>Error</th></tr></thead>`;

  const scorecards = season.gameweeks.map(gameweekScorecard).join('');

  // One plain-English sentence at the top, so the page opens with a verdict rather than with
  // a table the reader has to interpret for themselves.
  const graded = season.gameweeks.filter(
    (gw) => gw.recommendedXiPredicted !== null && gw.recommendedXiActual !== null,
  );
  const headline =
    graded.length === 0
      ? null
      : (() => {
          const totalPredicted = graded.reduce((sum, gw) => sum + (gw.recommendedXiPredicted ?? 0), 0);
          const totalActual = graded.reduce((sum, gw) => sum + (gw.recommendedXiActual ?? 0), 0);
          const perWeek = (totalActual - totalPredicted) / graded.length;
          const direction =
            Math.abs(perWeek) < 2
              ? `within ${Math.abs(perWeek).toFixed(1)} points a week`
              : `${Math.abs(perWeek).toFixed(1)} points a week too ${perWeek > 0 ? 'low' : 'high'}`;
          return `Over ${graded.length} graded gameweek${graded.length === 1 ? '' : 's'} we said
            the team we picked would score <strong>${totalPredicted.toFixed(1)}</strong>. It
            scored <strong>${totalActual}</strong> &mdash; ${direction}.`;
        })();

  const seasonRows = season.gameweeks
    .map(
      (gw) => `<tr>
        <td><strong>GW${gw.eventId}</strong></td>
        <td>${gw.playersScored}</td>
        <td>${gw.meanAbsoluteError.toFixed(2)}</td>
        <td style="color:${Math.abs(gw.bias) < 0.25 ? 'var(--ok)' : 'var(--warn-fg)'}">${gw.bias > 0 ? '+' : ''}${gw.bias.toFixed(2)}</td>
        <td>${gw.recommendedXiPredicted !== null ? gw.recommendedXiPredicted.toFixed(1) : '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.recommendedXiActual ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${bestFromSquadCell(gw)}</td>
        <td>${gw.yourActual ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.leagueAverage ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.leagueHighest ?? '<span class="muted">&mdash;</span>'}</td>
      </tr>`,
    )
    .join('');

  const body = `
  ${
    season.notes.length > 0
      ? `<div class="banner info">${season.notes.map((n) => escapeHtml(n)).join('<br>')}</div>`
      : ''
  }

  ${
    season.gameweeks.length > 0
      ? `${headline ? `<div class="banner info">${headline}</div>` : ''}
         <h2>Week by week</h2>
         <div class="gw-cards">${scorecards}</div>
         <details class="explain">
           <summary>What am I looking at?</summary>
           <div class="inner">
             <p><strong>There are two teams on each card, which is why there is more than one
             score.</strong> This page exists to grade the app, so it has to show what the app's
             own team did &mdash; and that is only the same as your team if you followed every
             piece of advice exactly.</p>
             <p><strong>The team we told you to play:</strong> <em>we guessed</em> is what this
             app expected that XI to score before the deadline. <em>It really scored</em> is what
             those same eleven went on to get, with auto-subs and the vice-captain replayed the
             way FPL would. The gap between those two is the app's mistake, and the tag at the
             top of the card is that gap.</p>
             <p><strong>The team you actually played:</strong> your real FPL score for the week,
             hits and chips included, straight from your own history. Nothing to do with the
             app's guess &mdash; it is there so you can see whether following the advice would
             have helped or hurt.</p>
           </div>
         </details>`
      : ''
  }

  ${
    season.pending.length > 0
      ? `<div class="banner warn"><strong>Not graded yet:</strong>
         ${season.pending
           .map((p) => `Gameweek ${p.eventId} &mdash; ${escapeHtml(p.reason)}`)
           .join('<br>')}
         <br><span class="muted">Advice was given for these, so they belong on this page. They
         appear in the table above as soon as the results land.</span></div>`
      : ''
  }

  ${renderCalibration(calibration, calibrationProgress)}

  ${
    season.overall
      ? `<h2>How reliable each projection is</h2>
         <div class="grid">
          <div class="stat"><div class="label">Gameweeks graded</div><div class="value">${season.overall.gameweeks}</div></div>
          <div class="stat"><div class="label">Projections scored</div><div class="value">${season.overall.playersScored}</div></div>
          <div class="stat"><div class="label">Typical miss</div><div class="value">${season.overall.meanAbsoluteError.toFixed(2)}</div><div class="muted" style="font-size:.78rem">points per player</div></div>
          <div class="stat"><div class="label">Leaning</div><div class="value">${season.overall.bias > 0 ? '+' : ''}${season.overall.bias.toFixed(2)}</div><div class="muted" style="font-size:.78rem">${
            season.overall.bias > 0.1
              ? 'too optimistic'
              : season.overall.bias < -0.1
                ? 'too pessimistic'
                : 'well centred'
          }</div></div>
        </div>
        <details class="explain">
          <summary>What do &ldquo;typical miss&rdquo; and &ldquo;leaning&rdquo; mean?</summary>
          <div class="inner">
            <p><strong>Typical miss</strong> is how far out a single player's projection usually
            was, in points, ignoring direction. Some error here is unavoidable &mdash; football
            is not predictable to the point.</p>
            <p><strong>Leaning</strong> is the direction of the error once the misses are added
            up with their signs. Near zero is what you want: the highs and lows cancel. A
            persistent lean one way is the fixable kind of wrong, because it is a systematic
            bias in the model rather than the game's own randomness, and it can be tuned out in
            <code>config/model.weights.json</code>.</p>
          </div>
        </details>`
      : ''
  }

  ${
    latest && latest.playersScored > 0
      ? `<h2>Gameweek ${latest.eventId} in detail</h2>
         <div class="grid">
           <div class="stat"><div class="label">Typical miss</div><div class="value">${latest.meanAbsoluteError.toFixed(2)}</div></div>
           <div class="stat"><div class="label">Leaning</div><div class="value">${latest.bias > 0 ? '+' : ''}${latest.bias.toFixed(2)}</div></div>
           <div class="stat"><div class="label">Big misses</div><div class="value">${latest.rootMeanSquareError.toFixed(2)}</div></div>
           <div class="stat"><div class="label">Model</div><div class="value" style="font-size:.95rem">${escapeHtml(latest.modelVersion ?? 'unknown')}</div></div>
         </div>

         <p class="muted" style="font-size:.88rem;margin:1.4rem 0 .4rem">These two lists are not
         opposites, and they never will be. A player reaches the first by being rated highly,
         which is also how a player gets picked &mdash; so
         <span class="pill" style="background:var(--warn-fg);color:#000">yours</span> turns up
         here and almost never below, where the players were rated near zero and so were never
         going to be picked. The first list is the one that cost you points.</p>

         <h3 style="margin:0">We rated them too highly</h3>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${errHead}
           <tbody>${errorRows(latest.overRated)}</tbody></table></div></div>

         <h3>We rated them too low</h3>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${errHead}
           <tbody>${errorRows(latest.underRated)}</tbody></table></div></div>

         <details class="explain">
           <summary>Break gameweek ${latest.eventId} down by position</summary>
           <div class="inner"><div class="scroll"><table>
             <thead><tr><th>Position</th><th>Players</th><th>Typical miss</th><th>Leaning</th></tr></thead>
             <tbody>${latest.byPosition
               .map(
                 (row) => `<tr><td>${escapeHtml(row.position)}</td><td>${row.players}</td>
                   <td>${row.meanAbsoluteError.toFixed(2)}</td>
                   <td>${row.bias > 0 ? '+' : ''}${row.bias.toFixed(2)}</td></tr>`,
               )
               .join('')}</tbody></table></div>
             <p class="muted" style="margin:.6rem 0 0">A blind spot in one position shows up here
             long before it shows up in the season-wide number.</p></div>
         </details>

         ${
           latest.notes.length > 0
             ? `<div class="banner info">${latest.notes.map((n) => escapeHtml(n)).join('<br>')}</div>`
             : ''
         }`
      : ''
  }

  ${
    season.gameweeks.length > 0
      ? `<details class="explain">
           <summary>Every number, in one table</summary>
           <div class="inner"><div class="scroll"><table>
             <thead><tr><th>GW</th><th>Players</th><th>Typical miss</th><th>Leaning</th>
               <th>We guessed</th><th>Our XI got</th><th>Best from those 15</th><th>You got</th>
               <th>Game average</th><th>Game best</th></tr></thead>
             <tbody>${seasonRows}</tbody></table></div></div>
         </details>`
      : ''
  }`;

  return renderShell({
    title: 'Accuracy - FPL Optimiser',
    activePath: '/accuracy',
    subtitle: 'What we said would happen, next to what actually did',
    body,
  });
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export function renderReset(
  plans: { scope: ResetScope; title: string; rows: number; description: string; keeps: string }[],
): string {
  const cards = plans
    .map(
      (plan) => `<div class="card">
        <h3>${escapeHtml(plan.title)}</h3>
        <p style="margin:.2rem 0"><strong>Removes:</strong> ${escapeHtml(plan.description)}</p>
        <p class="muted" style="margin:.2rem 0"><strong>Keeps:</strong> ${escapeHtml(plan.keeps)}</p>
        <p class="muted" style="margin:.2rem 0">${plan.rows} row(s) would be deleted.</p>
        <p style="margin:.6rem 0 0">
          <button class="btn danger" data-scope="${escapeHtml(plan.scope)}" data-title="${escapeHtml(plan.title)}" ${plan.rows === 0 ? 'disabled' : ''}>
            Remove ${escapeHtml(plan.title)}
          </button>
        </p>
      </div>`,
    )
    .join('');

  const script = `
document.querySelectorAll('button[data-scope]').forEach((btn) => {
  btn.onclick = async () => {
    const scope = btn.dataset.scope;
    const title = btn.dataset.title;
    if (!confirm('Remove ' + title + '? This cannot be undone.')) return;
    btn.disabled = true;
    const res = await fetch('/reset?scope=' + encodeURIComponent(scope), { method: 'POST' });
    const body = await res.json();
    const el = document.createElement('div');
    el.className = 'banner info';
    el.textContent = res.ok
      ? 'Removed ' + title + ' (' + body.totalRows + ' row(s)). Reload to see the new state.'
      : 'Failed: ' + (body.error || res.statusText);
    btn.parentElement.appendChild(el);
  };
});
`;

  const body = `
  <div class="banner info">The first four cards undo one import each, mirroring the Import Data
  tab. The wider scopes are below. Each names exactly what it removes and what survives, and
  nothing happens until you confirm.</div>
  ${cards}`;

  return renderShell({
    title: 'Reset data - FPL Optimiser',
    activePath: '/reset',
    subtitle: 'Delete stored data and start again',
    body,
    script,
  });
}
