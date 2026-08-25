import type { GameweekAccuracy, SeasonAccuracy } from '../model/accuracy.js';
import type { ChipAdvice } from '../optimise/chips.js';
import type { PayloadKind } from '../ingest/import.js';
import type { ResetScope } from '../ingest/reset.js';
import { escapeHtml, renderShell } from './layout.js';
import type { Readiness, Recommendation } from './recommend.js';
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

export function renderRecommendation(rec: Recommendation): string {
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

  const transfers =
    rec.transfers.length > 0
      ? rec.transfers
          .map(
            (transfer) => `<div class="card"${transfer.priority ? ' style="border-color:var(--warn-fg)"' : ''}>
              <h3>${transfer.priority ? '<span class="pill" style="background:var(--warn-fg);color:#000">Priority fix</span> ' : ''}${escapeHtml(transfer.out.name)} &rarr; ${escapeHtml(transfer.in.name)}
                <span class="pill good">${transfer.netGain >= 0 ? '+' : ''}${transfer.netGain.toFixed(2)} pts</span></h3>
              <p class="muted" style="margin:0">${escapeHtml(transfer.reason)}</p>
            </div>`,
          )
          .join('')
      : '';

  const body = `
  <p style="margin:0 0 .6rem">
    <a class="btn ghost" href="/optimise?generate=1">Regenerate</a>
    <button class="btn danger" data-clear-squad style="margin-left:.4rem">Clear squad</button>
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
    <div class="stat"><div class="label">Projected</div><div class="value">${rec.eleven.expectedPoints.toFixed(1)}</div></div>
    <div class="stat"><div class="label">Squad cost</div><div class="value">${formatMoney(rec.totalCost)}</div></div>
    <div class="stat"><div class="label">In the bank</div><div class="value">${formatMoney(rec.bankRemaining)}</div></div>
  </div>

  <p style="margin-top:1rem">Captain <strong>${escapeHtml(rec.eleven.captain.name)}</strong>,
     vice <strong>${escapeHtml(rec.eleven.viceCaptain.name)}</strong>.</p>

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
  <p class="muted" style="font-size:.88rem;margin:0 0 .5rem">
    <strong>Confidence</strong> is how much real playing-time evidence backs a player's own
    rate &mdash; not whether this is a good pick. A nailed-on starter can be high confidence and
    still low-scoring in a tough fixture, both at once; check the <strong>Fixture</strong>
    column and FDR for that. Confidence only turns low when the evidence itself is thin (little
    or no minutes, or a rate carried over from last season).
  </p>
  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${head}<tbody>${starters}</tbody></table></div></div>

  <h2>Bench <span class="muted" style="font-weight:400">(auto-sub order)</span></h2>
  <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${head}<tbody>${bench}</tbody></table></div></div>

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
      rec.evidence.usingPreviousSeason > 0
        ? `${rec.evidence.usingPreviousSeason} player(s) projected from last season's rates,
           because this season has no minutes yet`
        : `<strong>No last-season history loaded.</strong> Import it on the
           <a href="/import">Import Data</a> tab to project from real rates rather than the
           API's own estimate`
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

  <div class="banner info"><strong>Nothing is generated until you click the button.</strong>
  A team is only worth acting on when it is built from all the evidence at once, so generation
  is blocked until this season's players, the fixtures and last season's stats are all in.</div>

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
          rec.recommendedEvent !== null
            ? `<strong>GW${rec.recommendedEvent}</strong>`
            : '<span class="muted">hold for now</span>'
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
        <span class="muted" style="margin-left:.5rem;font-size:.88rem">or drop it on this card</span>
      </p>
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
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.position)}</td>
        <td>${escapeHtml(p.club)}</td>
        <td>${p.predicted.toFixed(2)}</td>
        <td><strong>${p.actual}</strong></td>
        <td style="color:${p.error > 0 ? 'var(--danger)' : 'var(--ok)'}">${p.error > 0 ? '+' : ''}${p.error.toFixed(2)}</td>
      </tr>`,
    )
    .join('');
}

export function renderAccuracy(season: SeasonAccuracy, latest: GameweekAccuracy | null): string {
  const errHead = `<thead><tr><th>Player</th><th>Pos</th><th>Club</th><th>Predicted</th><th>Actual</th><th>Error</th></tr></thead>`;

  const seasonRows = season.gameweeks
    .map(
      (gw) => `<tr>
        <td><strong>GW${gw.eventId}</strong></td>
        <td>${gw.playersScored}</td>
        <td>${gw.meanAbsoluteError.toFixed(2)}</td>
        <td style="color:${Math.abs(gw.bias) < 0.25 ? 'var(--ok)' : 'var(--warn-fg)'}">${gw.bias > 0 ? '+' : ''}${gw.bias.toFixed(2)}</td>
        <td>${gw.recommendedXiActual ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.bestPossibleFromSquad ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.yourActual ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.leagueAverage ?? '<span class="muted">&mdash;</span>'}</td>
        <td>${gw.leagueHighest ?? '<span class="muted">&mdash;</span>'}</td>
      </tr>`,
    )
    .join('');

  const body = `
  ${
    season.overall
      ? `<div class="grid">
          <div class="stat"><div class="label">Gameweeks graded</div><div class="value">${season.overall.gameweeks}</div></div>
          <div class="stat"><div class="label">Projections scored</div><div class="value">${season.overall.playersScored}</div></div>
          <div class="stat"><div class="label">Mean error</div><div class="value">${season.overall.meanAbsoluteError.toFixed(2)}</div><div class="muted" style="font-size:.78rem">points per player</div></div>
          <div class="stat"><div class="label">Bias</div><div class="value">${season.overall.bias > 0 ? '+' : ''}${season.overall.bias.toFixed(2)}</div><div class="muted" style="font-size:.78rem">${
            season.overall.bias > 0.1
              ? 'too optimistic'
              : season.overall.bias < -0.1
                ? 'too pessimistic'
                : 'well centred'
          }</div></div>
        </div>`
      : ''
  }

  ${
    season.notes.length > 0
      ? `<div class="banner info">${season.notes.map((n) => escapeHtml(n)).join('<br>')}</div>`
      : ''
  }

  ${
    season.gameweeks.length > 0
      ? `<h2>By gameweek</h2>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
           <thead><tr><th>GW</th><th>Players</th><th>Mean error</th><th>Bias</th>
             <th>Our XI scored</th><th>Best possible</th><th>You scored</th>
             <th>League average</th><th>League highest</th></tr></thead>
           <tbody>${seasonRows}</tbody></table></div></div>
         <p class="muted" style="font-size:.9rem">Mean error is how far a typical projection was
         out, in points. Bias is the direction: positive means the model was too optimistic,
         which is the fixable kind of wrong &mdash; it can be tuned out in
         <code>config/model.weights.json</code>.</p>`
      : ''
  }

  ${
    latest && latest.playersScored > 0
      ? `<h2>Gameweek ${latest.eventId} in detail</h2>
         <div class="card">
           <p style="margin:.2rem 0">Model <strong>${escapeHtml(latest.modelVersion ?? 'unknown')}</strong>,
              ${latest.playersScored} projections scored.
              Mean error <strong>${latest.meanAbsoluteError.toFixed(2)}</strong>,
              bias <strong>${latest.bias > 0 ? '+' : ''}${latest.bias.toFixed(2)}</strong>,
              RMSE ${latest.rootMeanSquareError.toFixed(2)}.</p>
           ${
             latest.recommendedXiActual !== null
               ? `<p style="margin:.2rem 0">The recommended XI was projected at
                  <strong>${latest.recommendedXiPredicted?.toFixed(1)}</strong> and actually scored
                  <strong>${latest.recommendedXiActual}</strong>.${
                    latest.bestPossibleFromSquad !== null
                      ? ` The best XI available from that squad would have scored
                         <strong>${latest.bestPossibleFromSquad}</strong> &mdash; a gap of
                         ${latest.bestPossibleFromSquad - latest.recommendedXiActual} points.`
                      : ''
                  }</p>`
               : ''
           }
           ${
             latest.leagueAverage !== null || latest.leagueHighest !== null
               ? `<p style="margin:.2rem 0">Across the whole game, the average score was
                  ${latest.leagueAverage !== null ? `<strong>${latest.leagueAverage}</strong>` : '<span class="muted">&mdash;</span>'}
                  and the highest was
                  ${latest.leagueHighest !== null ? `<strong>${latest.leagueHighest}</strong>` : '<span class="muted">&mdash;</span>'}.</p>`
               : ''
           }
         </div>

         <h2>By position</h2>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>
           <thead><tr><th>Position</th><th>Players</th><th>Mean error</th><th>Bias</th></tr></thead>
           <tbody>${latest.byPosition
             .map(
               (row) => `<tr><td>${escapeHtml(row.position)}</td><td>${row.players}</td>
                 <td>${row.meanAbsoluteError.toFixed(2)}</td>
                 <td>${row.bias > 0 ? '+' : ''}${row.bias.toFixed(2)}</td></tr>`,
             )
             .join('')}</tbody></table></div></div>

         <h2>Most over-rated <span class="muted" style="font-weight:400">(we said more than they scored)</span></h2>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${errHead}
           <tbody>${errorRows(latest.overRated)}</tbody></table></div></div>

         <h2>Most under-rated <span class="muted" style="font-weight:400">(they beat the projection)</span></h2>
         <div class="card" style="padding:.3rem .4rem"><div class="scroll"><table>${errHead}
           <tbody>${errorRows(latest.underRated)}</tbody></table></div></div>

         ${
           latest.notes.length > 0
             ? `<div class="banner info">${latest.notes.map((n) => escapeHtml(n)).join('<br>')}</div>`
             : ''
         }`
      : ''
  }`;

  return renderShell({
    title: 'Accuracy - FPL Optimiser',
    activePath: '/accuracy',
    subtitle: 'How close the projections were to what actually happened',
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
