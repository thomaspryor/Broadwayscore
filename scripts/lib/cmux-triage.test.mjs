/**
 * cmux-triage.test.mjs — BRO-2623.
 *
 * Requires the real module (CLAUDE.md rule 15: never restate the logic here).
 * Every case is a workspace shape that actually occurred on this machine, or
 * one of the misclassifications the module's header says it exists to stop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const triage = require('./cmux-triage.js');
const { triageDeadTabs, formatTriageReport, extractLinearKey, linearKeyFor, workKeyForTitle } = triage;

// Default collaborators: know nothing. Each test overrides only what it needs,
// so a case can never pass because some unrelated stub happened to answer.
const NOTHING = {
  launchByRef: () => null,
  taskStatusById: () => null,
  linearStateByKey: () => null,
};

function run(deadTabs, over = {}) {
  return triageDeadTabs({ deadTabs, liveWorkspaces: [], ...NOTHING, ...over });
}

function only(buckets) {
  const names = Object.keys(buckets).filter(k => buckets[k].length);
  assert.equal(names.length, 1, `expected exactly one non-empty bucket, got ${JSON.stringify(names)}`);
  return { bucket: names[0], entry: buckets[names[0]][0] };
}

// ── key extraction ──────────────────────────────────────────────────────────

test('extractLinearKey finds a BRO key and ignores a bare card number', () => {
  assert.equal(extractLinearKey('🤖🔮 Data·BRO-2623 Triage dead tabs'), 'BRO-2623');
  assert.equal(extractLinearKey('🧭 👑 OWNER — land card #1889 Express retry merge'), null);
});

test('linearKeyFor falls back to the ledger taskId and subject when the title has no key', () => {
  // The live 2026-09-07 shape: owner-renamed crown tab, key only in the ledger.
  assert.equal(linearKeyFor('🧭 👑 OWNER — land card #1889 Express retry merge', 'linear:BRO-2620', null), 'BRO-2620');
  assert.equal(linearKeyFor('👑 OWNER watchdog — 5 in flight', null, 'BRO-989 P1: outlet-registry lost-update'), 'BRO-989');
  assert.equal(linearKeyFor('👑 OWNER watchdog — 5 in flight', null, null), null);
});

test('workKeyForTitle collapses crown succession versions but keeps distinct non-crown titles apart', () => {
  assert.equal(
    workKeyForTitle('👑 OWNER-crown v20 — BRO-343 backlog triage'),
    workKeyForTitle('👑 OWNER-crown v46 — BRO-343 backlog triage'),
  );
  assert.notEqual(
    workKeyForTitle('🤖 Data·BRO-1 Fix the scraper'),
    workKeyForTitle('🤖 Data·BRO-2 Fix the scraper timeout'),
  );
});

// ── bucket precedence ───────────────────────────────────────────────────────

test('a dead tab whose Linear issue is Done is safe to close', () => {
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖🔮 Data·BRO-77 Ship it' }],
    { linearStateByKey: () => ({ type: 'completed', name: 'Done' }) },
  ));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'linear-completed');
});

test('Duplicate and Canceled count as finished, not as open work', () => {
  for (const type of ['canceled', 'duplicate']) {
    const { bucket, entry } = only(run(
      [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
      { linearStateByKey: () => ({ type, name: type }) },
    ));
    assert.equal(bucket, 'safeToClose', `${type} should be terminal`);
    assert.equal(entry.reason, `linear-${type}`);
  }
});

test('a dead tab whose Linear issue is still open needs resuming', () => {
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    { linearStateByKey: () => ({ type: 'started', name: 'In Progress' }) },
  ));
  assert.equal(bucket, 'needsResuming');
  assert.equal(entry.reason, 'linear-open');
  assert.equal(entry.linearState, 'In Progress');
});

test('a LIVE tab on the same issue outranks "Linear says In Progress" — never re-dispatch onto a live session', () => {
  const { bucket, entry } = only(triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '🤖 Data·BRO-77 Ship it' }],
    ...NOTHING,
    linearStateByKey: () => ({ type: 'started', name: 'In Progress' }),
  }));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'live-duplicate');
});

test('a failed status lookup is an owner call, never silently "no open work"', () => {
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    { linearStateByKey: () => ({ error: 'api.github.com 503' }) },
  ));
  assert.equal(bucket, 'needsOwnerCall');
  assert.equal(entry.reason, 'unverifiable-lookup');
});

test('two dead instances of the same crown loop are an owner call, not a re-dispatch', () => {
  const buckets = run([
    { ref: 'workspace:20', title: '👑 OWNER-crown v20 — BRO-343 backlog triage' },
    { ref: 'workspace:46', title: '👑 OWNER-crown v46 — BRO-343 backlog triage' },
  ], { linearStateByKey: () => ({ type: 'started', name: 'In Progress' }) });
  assert.equal(buckets.needsOwnerCall.length, 2);
  assert.equal(buckets.needsResuming.length, 0);
  assert.ok(buckets.needsOwnerCall.every(e => e.reason === 'duplicate-crown-loop'));
});

test('a single dead crown whose loop has a LIVE successor is safe to close, not an owner call', () => {
  const { bucket, entry } = only(triageDeadTabs({
    deadTabs: [{ ref: 'workspace:20', title: '👑 OWNER-crown v20 — backlog triage' }],
    liveWorkspaces: [{ ref: 'workspace:46', title: '👑 OWNER-crown v46 — backlog triage' }],
    ...NOTHING,
  }));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'live-duplicate');
});

test('a dead tab mapping to nothing at all is reported, never acted on', () => {
  const { bucket, entry } = only(run([{ ref: 'workspace:9', title: 'Domain Authority (recovered)' }]));
  assert.equal(bucket, 'needsOwnerCall');
  assert.equal(entry.reason, 'unmapped');
  assert.equal(entry.autoActionAllowed, false);
});

test('the task store answers when the title carries no Linear key', () => {
  const withStatus = (status) => run(
    [{ ref: 'workspace:9', title: '🤖 Data·some legacy task' }],
    { launchByRef: () => ({ taskId: 42, subject: 'legacy' }), taskStatusById: () => status },
  );
  assert.equal(only(withStatus('completed')).bucket, 'safeToClose');
  assert.equal(only(withStatus('pending')).entry.reason, 'task-pending');
  // in_progress is NOT resumed here — see the reconciler-territory test below.
  assert.equal(only(withStatus('in_progress')).entry.reason, 'reconciler-territory');
});

test('Linear outranks a stale task-store status (Linear is the board of record)', () => {
  const { bucket } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    { launchByRef: () => ({ taskId: 42 }), taskStatusById: () => 'pending', linearStateByKey: () => ({ type: 'completed', name: 'Done' }) },
  ));
  assert.equal(bucket, 'safeToClose');
});

// ── the ownership vetoes stay owned by prune-dead-autodispatch-tabs ─────────

test('autoActionAllowed is true only for a non-selected, non-crown, 🤖-dispatched tab', () => {
  const done = { linearStateByKey: () => ({ type: 'completed', name: 'Done' }) };
  const flag = (tab) => run([tab], done).safeToClose[0].autoActionAllowed;

  assert.equal(flag({ ref: 'w:1', title: '🤖 Data·BRO-77 Ship it' }), true);
  assert.equal(flag({ ref: 'w:2', title: 'Data·BRO-77 Ship it' }), false, 'owner-opened tab');
  assert.equal(flag({ ref: 'w:3', title: '👑 🤖 Data·BRO-77 Ship it' }), false, 'crown tab');
  assert.equal(flag({ ref: 'w:4', title: '🤖 Data·BRO-77 Ship it', selected: true }), false, 'selected tab');
});

test('a completed OWNER-opened tab is still surfaced as safe to close, just not auto-closable', () => {
  // The whole point of BRO-2623: the existing sweeps drop this tab entirely.
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:100', title: '🧭 👑 OWNER — land card #1889 Express retry merge' }],
    { launchByRef: () => ({ taskId: 'linear:BRO-2620', subject: 'BRO-2620 P2: nothing runs audit-stale-announced-shows.js' }),
      linearStateByKey: () => ({ type: 'completed', name: 'Done' }) },
  ));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.linearKey, 'BRO-2620');
  assert.equal(entry.autoActionAllowed, false);
});

// ── robustness + report ─────────────────────────────────────────────────────

test('a throwing collaborator degrades one fact to unknown, it does not abort the sweep', () => {
  const buckets = run([
    { ref: 'workspace:1', title: '🤖 Data·BRO-77 A' },
    { ref: 'workspace:2', title: '🤖 Data·BRO-78 B' },
  ], {
    launchByRef: () => { throw new Error('ledger unreadable'); },
    linearStateByKey: (k) => (k === 'BRO-77' ? { type: 'completed', name: 'Done' } : null),
  });
  assert.equal(buckets.safeToClose.length, 1);
  assert.equal(buckets.needsOwnerCall.length, 1);
});

test('empty input is a clean empty triage', () => {
  const buckets = run([]);
  assert.deepEqual(buckets, { safeToClose: [], needsResuming: [], needsOwnerCall: [] });
  assert.match(formatTriageReport(buckets)[0], /0 dead workspace/);
});

test('the report names the re-dispatch command for a resumable tab and flags owner-only closes', () => {
  const lines = formatTriageReport(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    { linearStateByKey: () => ({ type: 'started', name: 'In Progress' }) },
  )).join('\n');
  assert.match(lines, /linear-next\.js --id BRO-77/);

  const ownerLines = formatTriageReport(run(
    [{ ref: 'workspace:100', title: '👑 OWNER — done thing' }],
    { launchByRef: () => ({ taskId: 'linear:BRO-2620' }), linearStateByKey: () => ({ type: 'completed', name: 'Done' }) },
  )).join('\n');
  assert.match(ownerLines, /OWNER-ONLY/);
});


// ── the fleet-watchdog dashboard is not a corpse ────────────────────────────

test('the watchdog dashboard tab is never reported as closeable or resumable', () => {
  // Live 2026-09-07 title. Runs as a plain node --dashboard process, so every
  // liveness signal in this repo reads it as dead, permanently and by design.
  const { bucket, entry } = only(run([{
    ref: 'workspace:140',
    title: '👑 OWNER watchdog — 5 in flight · 18 need you · 202 P0/P1 queued · upd 23:52',
  }]));
  assert.equal(bucket, 'needsOwnerCall');
  assert.equal(entry.reason, 'watchdog-dashboard');
  assert.equal(entry.autoActionAllowed, false);
  assert.match(formatTriageReport(run([{ ref: 'workspace:140', title: '👑 OWNER watchdog — upd 23:52' }])).join('\n'), /leave it open/);
});

test('a crowned owner SESSION that merely mentions the watchdog is NOT the dashboard', () => {
  // dispatch-watchdog.js shipped this exact bug as a P0: a substring match
  // closed live owner sessions. Exact-prefix only.
  assert.equal(triage.isWatchdogDashboardTitle('👑 OWNER — repair dispatch-watchdog alerts'), false);
  assert.equal(triage.isWatchdogDashboardTitle('👑 OWNER watchdog — 5 in flight'), true);
  assert.equal(triage.isWatchdogDashboardTitle('⠙ 👑 OWNER watchdog — 5 in flight'), true, 'cmux activity-glyph prefix');
});

test('the watchdog predicate is built from dispatch-watchdog-core constants, not copied literals', () => {
  const core = require('./dispatch-watchdog-core.js');
  assert.equal(triage.isWatchdogDashboardTitle(`${core.WATCHDOG_TAB_PREFIX} ${core.WATCHDOG_TAB_MARKER} — anything`), true);
});

// ── ref recycling: the wiring regression this module shipped once ───────────

test('the CLI resolves ledger provenance with unreconciledLaunchForRef, never a bare launchByRef', () => {
  // Caught live 2026-09-07 pre-ship: cmux recycles workspace refs, so the last
  // `launch` row for a ref routinely belongs to a long-gone occupant. A bare
  // dispatchLedger.launchByRef attributed the owner's live fleet dashboard
  // (workspace:140, created 01:59 that morning) to task 989 — prune-closed a
  // month earlier, status "completed" — and classified it SAFE TO CLOSE.
  // Injected collaborators cannot catch a wiring regression, so this asserts
  // the real source, comments stripped (a scan a comment can fool proves
  // nothing) — the same shape ux-walkthrough-filing.test.mjs uses.
  const fs = require('fs');
  const src = fs.readFileSync(new URL('./cmux-triage.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /dispatchLedger\.unreconciledLaunchForRef\(/);
  assert.doesNotMatch(src, /dispatchLedger\.launchByRef\(/);
});

// ── a live non-Claude agent is not a corpse ─────────────────────────────────

// Verbatim rows from `cmux top --workspace workspace:100 --processes --format
// tsv` on 2026-09-07 (a live, idle Codex session) and workspace:129 (Claude).
const CODEX_TSV = [
  '0.0\t306618144\t6\tworkspace\tworkspace:100\twindow:1\t🧭 👑 OWNER — land card #1889',
  '0.0\t0\t0\ttag\tworkspace:AC086338-365E-49C4-AD65-64C906EB7781:tag:codex\tworkspace:100\tIdle',
  '0.0\t17270752\t1\tprocess\t85714\tworkspace:AC086338-365E-49C4-AD65-64C906EB7781:tag:codex.01a055e0-8ac3-7c33-b4fa-6c12c2cf89ce\tnode',
  '0.0\t3310000\t1\tprocess\t57099\tsurface:103\tzsh',
].join('\n');

const CLAUDE_TSV = '0.7\t202753248\t1\tprocess\t24430\tworkspace:B270C269-600D-4DA6-B20A-ADA295D52BD7:tag:claude_code\t2.1.263';

// workspace:140, the watchdog dashboard: a surface-parented node process, with
// no agent tag anywhere.
const DASHBOARD_TSV = [
  '0.0\t126618368\t1\tsurface\tsurface:144\tpane:141\tbsc-watchdog-dashboard.sh',
  '0.0\t126618368\t1\tprocess\t1889\tsurface:144\tnode',
].join('\n');

test('liveAgentIn sees a live Codex session that hasLiveClaude misses', () => {
  const cmuxws = require('./cmux-workspaces.js');
  // The premise, asserted against the REAL predicate rather than described:
  // this is precisely why the third signal has to exist.
  assert.equal(cmuxws.hasLiveClaude(CODEX_TSV), false, 'hasLiveClaude is blind to codex');
  assert.equal(triage.liveAgentIn(CODEX_TSV), 'codex');
});

test('liveAgentIn still recognises Claude, and reports nothing for the dashboard', () => {
  assert.equal(triage.liveAgentIn(CLAUDE_TSV), 'claude_code');
  assert.equal(triage.liveAgentIn(DASHBOARD_TSV), null);
  assert.equal(triage.liveAgentIn(''), null);
  assert.equal(triage.liveAgentIn(undefined), null);
});

test('liveAgentIn requires a PROCESS row, not a bare tag row left by a crash', () => {
  // Same rule cmux-workspaces.hasLiveClaude states: a stale tag row with no
  // process behind it is a crashed agent, and must stay prunable.
  const tagOnly = '0.0\t0\t0\ttag\tworkspace:AC08:tag:codex\tworkspace:100\tIdle';
  assert.equal(triage.liveAgentIn(tagOnly), null);
});

// ── ship-check findings, pinned so they cannot come back ────────────────────

test('the issue-key regex is anchored to this team, not a generic KEY-N shape', () => {
  // A generic /[A-Z]{2,5}-\d+/ matched plenty of non-issues that really do
  // appear in titles, and each one produced a status verdict about unrelated
  // work.
  for (const notAKey of ['UTF-8 encoding fix', 'CVE-2024 patch', 'bump GPT-5 model', 'ENG-1234 upstream']) {
    assert.equal(extractLinearKey(notAKey), null, notAKey);
  }
  const { TEAM_KEY } = require('./linear-client.js');
  assert.equal(extractLinearKey(`Data·${TEAM_KEY}-2623 triage`), `${TEAM_KEY}-2623`);
});

test('a title-derived issue key never proves two tabs share work', () => {
  // "fix BRO-123 link in BRO-456 report" is one tab's free text, not evidence
  // about another tab. Only the dispatch record may establish a duplicate.
  const buckets = triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '🤖 Data·BRO-123 fix the scraper' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '👑 OWNER — fix BRO-123 link in BRO-456 report' }],
    ...NOTHING,
  });
  assert.equal(buckets.safeToClose.length, 0, 'must NOT be called a live duplicate');
  assert.equal(buckets.needsOwnerCall[0].reason, 'unmapped');
});

test('a LEDGER-derived issue key does prove two tabs share work', () => {
  const launches = {
    'workspace:9': { taskId: 'linear:BRO-123' },
    'workspace:12': { taskId: 'linear:BRO-123' },
  };
  const { bucket, entry } = only(triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '🤖 Data·some renamed tab' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '👑 OWNER — totally different title' }],
    ...NOTHING,
    launchByRef: (ref) => launches[ref] || null,
  }));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'live-duplicate');
});

test('a lookup that THROWS is unverifiable, never "unmapped"', () => {
  // Collapsing "the ledger read failed" into "this tab has no work attached"
  // understates an outage as an absence — the exact conflation the
  // unverifiable bucket exists to stop, leaking in through error handling.
  const thrown = (over) => only(run([{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }], over));

  assert.equal(thrown({ launchByRef: () => { throw new Error('ledger unreadable'); } }).entry.reason, 'unverifiable-lookup');
  assert.equal(thrown({ linearStateByKey: () => { throw new Error('502'); } }).entry.reason, 'unverifiable-lookup');
  assert.equal(thrown({
    launchByRef: () => ({ taskId: 42 }),
    taskStatusById: () => { throw new Error('EACCES'); },
  }).entry.reason, 'unverifiable-lookup');

  // ...and a tab that genuinely maps to nothing is still plain 'unmapped'.
  assert.equal(only(run([{ ref: 'workspace:9', title: 'Domain Authority (recovered)' }])).entry.reason, 'unmapped');
});

test('a confirmed-finished verdict still wins over an unrelated failed lookup', () => {
  // Linear answered "Done"; only the task-store read failed. Downgrading a
  // confirmed answer to unverifiable would make every archived task noisy.
  const { bucket } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    {
      launchByRef: () => ({ taskId: 42 }),
      taskStatusById: () => { throw new Error('EACCES'); },
      linearStateByKey: () => ({ type: 'completed', name: 'Done' }),
    },
  ));
  assert.equal(bucket, 'safeToClose');
});

test('the module closes nothing: no close path exists in the source at all', () => {
  // An --apply flag was removed pre-ship: it had a TOCTOU close (verdict
  // computed from a snapshot, several Linear round trips before the close)
  // and took none of the single-writer lock bsc-prune uses to make concurrent
  // sweeps safe. bsc-prune owns the only close path; this tool reports.
  const fs = require('fs');
  const src = fs.readFileSync(new URL('./cmux-triage.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /closeWorkspace/, 'must not close workspaces');
  assert.doesNotMatch(src, /appendEntry/, 'must not write to the dispatch ledger');
  assert.doesNotMatch(src, /--apply/, 'the --apply flag must stay gone');
});

// ── resolveLinearStates: the I/O half's one injectable seam ─────────────────

test('a failed Linear lookup becomes {error}, and reaches the report as unverifiable', () => {
  // End-to-end across the seam: the real resolveLinearStates must produce the
  // `{error}` shape the classifier's contract requires, and the classifier
  // must route it to unverifiable-lookup. Unit-testing the two halves against
  // separate hand-written fixtures would let their agreed shape drift apart —
  // this is the case the card names ("an unverifiable PR due to an API
  // outage"), so the handoff itself is what needs pinning.
  return triage.resolveLinearStates(['BRO-77'], {
    getIssue: async () => { throw new Error('api.linear.app 503'); },
  }).then((states) => {
    assert.deepEqual(states.get('BRO-77'), { error: 'api.linear.app 503' });

    const { bucket, entry } = only(run(
      [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
      { linearStateByKey: (k) => (states.has(k) ? states.get(k) : null) },
    ));
    assert.equal(bucket, 'needsOwnerCall');
    assert.equal(entry.reason, 'unverifiable-lookup');
  });
});

test('resolveLinearStates distinguishes a missing issue (null) from a failed lookup', () => {
  // null means "Linear answered, there is no such issue" — a real, usable
  // answer that must NOT be treated as an outage. Only `{error}` is an outage.
  return triage.resolveLinearStates(['BRO-1', 'BRO-2'], {
    getIssue: async (key) => (key === 'BRO-1' ? null : { state: { type: 'completed', name: 'Done' } }),
  }).then((states) => {
    assert.equal(states.get('BRO-1'), null);
    assert.deepEqual(states.get('BRO-2'), { type: 'completed', name: 'Done' });
  });
});

test('resolveLinearStates makes no network call when there are no keys', () => {
  // The common case is zero dead tabs; it must not construct a client or pay
  // for a round trip to say so.
  return triage.resolveLinearStates([], {
    getIssue: () => { throw new Error('must not be called'); },
  }).then((states) => assert.equal(states.size, 0));
});

// ── second-reviewer findings, pinned ───────────────────────────────────────

test('P0: a stale "completed" task row must NOT stand in for an unreachable Linear', () => {
  // The module declares the task store a frozen mirror that Linear outranks,
  // then fell back to it as SOLE evidence exactly when Linear was unreachable
  // — the moment the mirror is least trustworthy and the verdict most
  // destructive. Linear 503 + a month-old "completed" row read "safe to close".
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    {
      launchByRef: () => ({ taskId: 989 }),
      taskStatusById: () => 'completed',
      linearStateByKey: () => ({ error: 'api.linear.app 503' }),
    },
  ));
  assert.equal(bucket, 'needsOwnerCall');
  assert.equal(entry.reason, 'unverifiable-lookup');
});

test('P0 sibling: a THROWN Linear lookup also blocks the stale-completed shortcut', () => {
  const { entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    {
      launchByRef: () => ({ taskId: 989 }),
      taskStatusById: () => 'completed',
      linearStateByKey: () => { throw new Error('ENOTFOUND'); },
    },
  ));
  assert.equal(entry.reason, 'unverifiable-lookup');
});

test('a task-store "completed" still stands on its own when Linear simply has no such issue', () => {
  // null = Linear answered "no such issue". That is a real answer, not an
  // outage, so the task store remains usable evidence.
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·legacy task' }],
    { launchByRef: () => ({ taskId: 989 }), taskStatusById: () => 'completed', linearStateByKey: () => null },
  ));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'task-completed');
});

test('a Linear state with a name but no type is a malformed answer, not a verdict', () => {
  const { entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·BRO-77 Ship it' }],
    { linearStateByKey: () => ({ name: 'In Review' }) },
  ));
  assert.equal(entry.reason, 'unverifiable-lookup');
});

test('two untitled tabs are never duplicates of each other', () => {
  // parseWorkspacesJson defaults `title` to '' — every untitled tab shared one
  // key, so the dead one was declared safe to close.
  const buckets = triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '' }],
    ...NOTHING,
  });
  assert.equal(buckets.safeToClose.length, 0);
  assert.equal(buckets.needsOwnerCall[0].reason, 'unmapped');
});

test('two owner tabs sharing a generic cwd-derived title are never duplicates', () => {
  const buckets = triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: 'Broadwayscore' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: 'Broadwayscore' }],
    ...NOTHING,
  });
  assert.equal(buckets.safeToClose.length, 0, 'a shared generic title proves nothing');
});

test('title-equality duplicates still work for 🤖 tabs, whose titles are generated', () => {
  // zombie-tab-sweep.js relies on this and is safe because buildAutoTitle
  // derives the title from a unique card. The precondition is re-asserted
  // here rather than inherited.
  const { bucket, entry } = only(triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '🤖 Data·some dispatched card' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '🤖 Data·some dispatched card' }],
    ...NOTHING,
  }));
  assert.equal(bucket, 'safeToClose');
  assert.equal(entry.reason, 'live-duplicate');
});

test('a free-text ledger SUBJECT naming an issue never proves duplication', () => {
  // subjects "Follow-up to BRO-100: …" and "Revert BRO-100 and …" are
  // different tasks that both mention BRO-100.
  const launches = {
    'workspace:9': { taskId: 11, subject: 'Follow-up to BRO-100: add the guard' },
    'workspace:12': { taskId: 22, subject: 'Revert BRO-100 and re-land it' },
  };
  const buckets = triageDeadTabs({
    deadTabs: [{ ref: 'workspace:9', title: '🤖 Data·follow-up' }],
    liveWorkspaces: [{ ref: 'workspace:12', title: '🤖 Data·revert' }],
    ...NOTHING,
    launchByRef: (ref) => launches[ref] || null,
    taskStatusById: () => 'in_progress',
  });
  assert.equal(buckets.safeToClose.length, 0, 'different taskIds are not duplicates');
});

test('a task-store in_progress row defers to the #883 reconciler instead of re-dispatching', () => {
  const { bucket, entry } = only(run(
    [{ ref: 'workspace:9', title: '🤖 Data·legacy task' }],
    { launchByRef: () => ({ taskId: 42 }), taskStatusById: () => 'in_progress' },
  ));
  assert.equal(bucket, 'needsOwnerCall');
  assert.equal(entry.reason, 'reconciler-territory');
});

test('liveAgentIn sees a SUFFIXED claude_code tag that hasLiveClaude anchors past', () => {
  // The suffix-tolerant regex is the point: this is a live Claude session the
  // repo's own predicate reports dead, so it must not be filtered out as
  // "not a foreign agent".
  const suffixed = '0.7\t202\t1\tprocess\t24430\tworkspace:B270:tag:claude_code.01a0-55e0\t2.1.263';
  const cmuxws = require('./cmux-workspaces.js');
  assert.equal(cmuxws.hasLiveClaude(suffixed), false, 'anchored regex misses the suffixed form');
  assert.equal(triage.liveAgentIn(suffixed), 'claude_code');
});

test('the CLI treats ANY live agent as alive, and a failed probe as alive too', () => {
  const fs = require('fs');
  const src = fs.readFileSync(new URL('./cmux-triage.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Swallowing a probe error to null resolved a transient socket failure to
  // "dead", inverting checkLiveness's fail-safe-to-alive rule.
  assert.doesNotMatch(src, /agent !== 'claude_code'/, 'must not exclude suffixed claude_code');
  assert.match(src, /livenessUnverifiable\.push/, 'a failed probe must be reported, not dropped');
});

test('the watchdog predicate stays byte-identical to dispatch-watchdog.js isWatchdogTitle', () => {
  // Same drift guard prune-closeable.test.mjs applies to CROWN_TAB_RE: the two
  // definitions live in different files and must not silently split in half.
  // (dispatch-watchdog-core.js:468 uses a SUBSTRING marker test — a third,
  // deliberately looser definition for a different question. Not compared.)
  const fs = require('fs');
  const wd = fs.readFileSync(new URL('../dispatch-watchdog.js', import.meta.url), 'utf8');
  const m = /function isWatchdogTitle\(title\) \{\s*return ([\s\S]*?);\s*\}/.exec(wd);
  assert.ok(m, 'could not locate isWatchdogTitle in dispatch-watchdog.js');
  const theirs = m[1].replace(/\s+/g, '');
  // Both must agree on: strip leading non-alphanumeric-non-👑, then startsWith
  // the prefix+marker. Compare behaviour on the titles that discriminate.
  for (const t of [
    '👑 OWNER watchdog — 5 in flight',
    '⠙ 👑 OWNER watchdog — 5 in flight',
    '👑 OWNER — repair dispatch-watchdog alerts',
    '✅ 👑 OWNER watchdog — done',
    'watchdog',
    '',
  ]) {
    const theirResult = new Function('title', 'WATCHDOG_TITLE_START', `return ${m[1]};`)(
      t, `${require('./dispatch-watchdog-core.js').WATCHDOG_TAB_PREFIX} ${require('./dispatch-watchdog-core.js').WATCHDOG_TAB_MARKER}`,
    );
    assert.equal(triage.isWatchdogDashboardTitle(t), theirResult, `disagreement on ${JSON.stringify(t)}`);
  }
  assert.ok(theirs.includes('startsWith'), 'their predicate is still an exact-prefix test');
});
