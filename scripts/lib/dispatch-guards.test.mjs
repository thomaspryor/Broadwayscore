// dispatch-guards.test.mjs — direct unit coverage for closedCardGuard's
// trashed-page check (task #1811). closedCardGuard had no colocated test
// file before this — it was only exercised indirectly through
// bsc-next.test.mjs's runSuccessionDispatch harness, which is the right
// place for wiring coverage but the wrong place for the guard's own pure
// decision logic. This file covers that logic directly, matching the
// colocated-test pattern predispatch-guard.test.mjs already establishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { closedCardGuard, dispatchClaimGuard } = require('./dispatch-guards.js');
// BRO-2488: marketingProjectGuard lives in linear-dispatch.js, not this
// file's GUARD_NAMES family — it's issue-shaped (needs issue.project), and
// predispatch-queue-audit.js's runGuard() only ever simulates GUARD_NAMES
// members against a task-shaped {id, subject, description} object (a
// Notion-mirror task has no .project), so adding it there would report 100%
// "error" forever instead of ever actually firing. Same precedent
// checkTerminalStateGuard already set for a Linear-only issue-shaped guard.
// Required directly here (not just in linear-dispatch.test.mjs) because
// BRO-2488's own acceptance criteria is `node --test
// scripts/lib/dispatch-guards.test.mjs` proving this is no longer invisible
// to the dispatch funnel.
const { marketingProjectGuard } = require('./linear-dispatch.js');

const TASK = { id: '1811', subject: 'test task', status: 'in_progress' };

// ── behaviour table (task #1811 acceptance criteria) ───────────────────────
test('closedCardGuard: trashed page + "In progress" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: trashed page + "Not started" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'Not started', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: live page + "In progress" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: false }, {}), null);
});

test('closedCardGuard: live page + "Not started" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'Not started', archived: false }, {}), null);
});

test('closedCardGuard: "Done" status (not trashed) is still REFUSED — existing behavior preserved', () => {
  const err = closedCardGuard(TASK, { status: 'Done', archived: false }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /already Done/);
});

test('closedCardGuard: card == null (degraded fetch) is ALLOWED — never livelocks the stall sweep', () => {
  assert.equal(closedCardGuard(TASK, null, {}), null);
});

// ── archived flag absent (pre-fix payloads, or any caller bypassing formatCard) ──
test('closedCardGuard: archived flag absent behaves as not-trashed (falsy, no throw)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress' }, {}), null);
});

// ── bypass flags ─────────────────────────────────────────────────────────────
test('closedCardGuard: --allow-closed-card bypasses a trashed-page refusal too (same top-level bypass as any closed card)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'allow-closed-card': true }), null);
});

test('closedCardGuard: --dry-run / --print-prompt bypass a trashed-page refusal', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'dry-run': true }), null);
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'print-prompt': true }), null);
});

// Adversarial review (codex, task #1811): --allow-closed-card only bypasses
// closedCardGuard — predispatch-guard.js's classifyCandidate runs its own
// independent archived check right after and refuses it unless
// --allow-reopen-suspect is ALSO set (card-archived-in-trash never matches
// the `card-status-terminal:${status}` pattern predispatchGuard's
// --allow-closed-card carve-out looks for). A real dispatch onto a trashed
// card therefore needs BOTH flags — this is the same shape a Done+PARKED
// card already required pre-#1811 (closedCardGuard's --allow-closed-card
// clears the status check, but classifyCandidate's parked-marker branch
// still needs --allow-reopen-suspect too), not a new inconsistency. The
// refusal text must say so, since a reader who follows closedCardGuard's
// suggestion literally and adds only --allow-closed-card would otherwise
// hit a second, differently-worded refusal from predispatch-guard.js.
test('closedCardGuard: trashed-page refusal message tells the reader --allow-closed-card alone will not be enough', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /--allow-reopen-suspect/);
});

// ── dispatchClaimGuard (task #1896) ─────────────────────────────────────────
// Pure: the actual acquireClaim() mkdir/EEXIST I/O is scripts/lib/atomic-
// claim.js's job (covered in scripts/lib/dispatch-overlap-check.test.mjs's
// race-simulation cases); this only checks how a claim RESULT becomes a
// refusal (or not).
test('dispatchClaimGuard: claimResult === true is silent (this attempt won the claim)', () => {
  assert.equal(dispatchClaimGuard(TASK, true, {}), null);
});

test('dispatchClaimGuard: claimResult === false (genuinely held elsewhere) refuses, naming the mirror-staleness race', () => {
  const err = dispatchClaimGuard(TASK, false, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /mirror-staleness race/);
  assert.match(err, /--force/);
});

test('dispatchClaimGuard: claimResult === \'error\' (unreadable claim meta) fails closed with a distinct message', () => {
  const err = dispatchClaimGuard(TASK, 'error', {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /claim dir unreadable\/corrupt/);
});

test('dispatchClaimGuard: --force / --dry-run / --print-prompt all bypass it, even on a held claim', () => {
  assert.equal(dispatchClaimGuard(TASK, false, { force: true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'dry-run': true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'print-prompt': true }), null);
  assert.equal(dispatchClaimGuard(TASK, 'error', { force: true }), null);
});

// ── marketingProjectGuard (BRO-2488) ────────────────────────────────────────
// The documented dispatch funnel is "Backlog/Todo, not `· Marketing`, not BSC
// Daily/CANARY" — but no query linear-next.js used ever fetched an issue's
// Linear `project` relation, so the exclusion was invisible to every
// dispatcher. Confirmed live: BRO-128 (project "Marketing/distribution")
// dispatched cleanly via `linear-next.js --id BRO-128 --headless` with no
// refusal. This case fails against that pre-fix behaviour (issue.project
// undefined => guard always returns null => never refuses anything).
test('marketingProjectGuard: a Marketing/distribution-project issue is REFUSED', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  const err = marketingProjectGuard(issue, {});
  assert.match(err, /BRO-128/);
  assert.match(err, /Marketing\/distribution/);
  assert.match(err, /--force/);
});

test('marketingProjectGuard: an issue with no project (or a non-Marketing project) is ALLOWED', () => {
  assert.equal(marketingProjectGuard({ identifier: 'BRO-1' }, {}), null);
  assert.equal(marketingProjectGuard({ identifier: 'BRO-2', project: { name: 'Infrastructure' } }, {}), null);
});

test('marketingProjectGuard: --force bypasses the refusal', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { force: true }), null);
});

// ── BRO-2575: a still-running workspace is never classified as having died ──
//
// THE INCIDENT. On 2026-08-31T00:55:32Z one bsc-prune sweep journaled 'dead'
// for FIVE workspaces in the same 2ms — every dispatch launched in the
// preceding 20 minutes. workspace:138 (linear:BRO-2506) was one of them; it
// committed its fix at 00:53Z and posted its session report at 01:31Z, 36
// minutes AFTER being declared dead. That row is what made the crown-loop
// re-dispatch BRO-2506 with --force at 02:15Z, wasting a full opus dispatch.
//
// THE MECHANISM. checkLiveness requires TWO signals to agree before calling a
// workspace dead (cards #559/#564), but both are read from the same cmux
// daemon over the same socket: claudeAliveIn is `cmux top --processes`,
// terminalSurfaceAliveIn is `cmux read-screen`. When cmux degrades they go
// quiet together and the whole fleet reads as dead at once — the sweep's
// "dead but un-marked" list jumped from 7 workspaces to 25 in that one tick
// while its `⚠ Registry desync` list of surface-ALIVE workspaces dropped to
// zero. Verified live on this machine, 2026-08-31: 4 of 32 workspaces return
// `internal_error: ERROR: Terminal surface not found` from read-screen.
//
// WHY NO PER-WORKSPACE PREDICATE FIXES IT. A live session whose surface cmux
// EVICTED and a #1199 husk whose surface NEVER RENDERED emit the identical
// pair of cmux signals. Narrowing either one to spare the first necessarily
// strands the second (nothing else reaps husks — sweepNoPayload swallows the
// read-screen throw into an empty screen and never flags, sweepVanished only
// fires once a ref leaves the listing). The fix therefore adds a signal that
// is not cmux's to lie about: the launch's own bash wrapper in the OS process
// table, which cmux-launch.js already treats as ground truth for every launch.
//
// These tests drive the REAL checkDeadDispatch and the REAL deadBreadcrumbs
// (CLAUDE.md rule 15) — only the process-table probe is faked, since that is
// the actual I/O boundary.
const { checkDeadDispatch } = require('./dispatch-guards.js');

// Verified live, 2026-08-31, against `ps -e -ww -o command=` on this machine:
// linear-next.js sanitizes the seedKey (`taskId.replace(/[^a-zA-Z0-9-]/g,'_')`),
// so a Linear dispatch's wrapper is `bsc-cmd-linear_BRO-NNNN-<nonce>.sh` —
// underscore, not the colon of the ledger taskId. Using the real shape here
// keeps the fixture honest for the next reader.
const LIVE_MARKER = 'bsc-cmd-linear_BRO-2506-a1b2c3d4.sh';
// The exact `ps -e -ww -o command=` line shape the wrapper produces.
const PS_WITH_WRAPPER = `/bin/bash /var/folders/xy/T/${LIVE_MARKER}\n/usr/bin/login -pf tompryor\n`;
const PS_WITHOUT_WRAPPER = '/usr/bin/login -pf tompryor\n/sbin/launchd\n';

// The real production predicate, so a change to how a wrapper is recognised
// breaks this test instead of silently passing.
const { hasSeedProcess } = require('./cmux-launch.js');
const probeOver = psText => marker => hasSeedProcess(psText, marker);

// cmux insisting the workspace is dead — BOTH signals, exactly as during the
// blackout. Any weaker setup would not reach the code under test.
const CMUX_SAYS_DEAD = { isDoneTitleFn: () => false, claudeAliveInFn: () => false, surfaceAliveFn: () => false };

function ledgerFor(marker) {
  return [{
    ts: '2026-08-31T00:43:00.598Z', event: 'launch', taskId: 'linear:BRO-2506',
    subject: 'BRO-2506 digest-autofix.js reconcileDigestOutcomes', workspaceRef: 'workspace:138',
    ...(marker ? { marker } : {}),
  }];
}
const WORKSPACES = [{ ref: 'workspace:138', title: '🤖⚡ Data·BRO-2506 digest-autofix.js reconcileDigestOutcomes' }];
const TASK_2506 = { id: 'linear:BRO-2506', subject: 'BRO-2506 digest-autofix.js reconcileDigestOutcomes', status: 'in_progress' };

test('BRO-2575: a workspace whose wrapper is STILL RUNNING is never journaled dead, even when both cmux signals say dead', () => {
  const { freshDead } = checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: probeOver(PS_WITH_WRAPPER) },
  );
  assert.deepEqual(freshDead, [],
    'workspace:138 was alive (it reported back 36 min later) — no dead breadcrumb may be written for it');
});

test('BRO-2575: the suppression is reported, never silent — it is evidence of a live cmux desync', () => {
  const seen = [];
  checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: probeOver(PS_WITH_WRAPPER), onSuppressed: info => seen.push(info) },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspaceRef, 'workspace:138');
  assert.equal(seen[0].taskId, 'linear:BRO-2506');
  assert.equal(seen[0].marker, LIVE_MARKER);
});

// The other half of the contract: this must not become a blanket amnesty. A
// #1199 husk (surface never rendered, wrapper never ran) still has to be
// journaled, or sweepZombieTabs stops reaping husks and deadDispatchGuard
// stops capping genuinely failing tasks.
test('BRO-2575: a genuinely dead workspace with no wrapper process IS still journaled dead', () => {
  const { freshDead } = checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: probeOver(PS_WITHOUT_WRAPPER) },
  );
  assert.deepEqual(freshDead.map(b => b.workspaceRef), ['workspace:138']);
  assert.equal(freshDead[0].event, 'dead');
});

test('BRO-2575: a launch predating the ledger marker field keeps the pre-fix verdict (no silent breadcrumb loss)', () => {
  const { freshDead } = checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(null),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: probeOver(PS_WITH_WRAPPER) },
  );
  assert.deepEqual(freshDead.map(b => b.workspaceRef), ['workspace:138'],
    'with no marker there is nothing to cross-check — the cmux verdict must stand rather than be guessed at');
});

test('BRO-2575: a throwing process probe falls back to the cmux verdict, never to a fabricated life', () => {
  const { freshDead } = checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: () => { throw new Error('ps: cannot allocate memory'); } },
  );
  assert.deepEqual(freshDead.map(b => b.workspaceRef), ['workspace:138']);
});

test('BRO-2575: omitting the probe entirely reproduces the exact pre-fix behaviour', () => {
  const { freshDead } = checkDeadDispatch(
    TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    {},
  );
  assert.deepEqual(freshDead.map(b => b.workspaceRef), ['workspace:138'],
    'no probe = no opinion; every existing caller must be unaffected');
});

// The whole batch, as it actually happened. A per-workspace assertion would
// pass even if the fix only worked for one ref; this is the shape that reached
// production.
test('BRO-2575: the real 5-workspace blackout batch produces ZERO dead rows when the wrappers are alive', () => {
  const batch = [
    ['workspace:138', 'linear:BRO-2506'], ['workspace:132', 'linear:BRO-2311'],
    ['workspace:131', 'linear:BRO-2258'], ['workspace:139', 'linear:BRO-80'],
    ['workspace:129', 'linear:BRO-2538'],
  ];
  const entries = batch.map(([ref, taskId], i) => ({
    ts: `2026-08-31T00:4${i}:00.000Z`, event: 'launch', taskId, subject: taskId,
    workspaceRef: ref, marker: `bsc-cmd-${taskId.replace(/[^a-zA-Z0-9-]/g, '_')}-0000000${i}.sh`,
  }));
  const workspaces = batch.map(([ref, taskId]) => ({ ref, title: `🤖⚡ ${taskId}` }));
  const ps = entries.map(e => `/bin/bash /var/folders/xy/T/${e.marker}`).join('\n');

  const { freshDead } = checkDeadDispatch(
    { id: 'linear:BRO-2506', subject: 'x', status: 'in_progress' }, workspaces, entries,
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: probeOver(ps) },
  );
  assert.deepEqual(freshDead, [],
    'all five sessions were alive; the pre-fix code wrote five dead rows in the same 2ms');
});

// ── BRO-2575 ship-check follow-ups ─────────────────────────────────────────
const ledger = require('./dispatch-ledger.js');

// Codex/Claude P1: bsc-prune's idle filter resolves the owning launch itself,
// so it must apply deadBreadcrumbs' OWN reconciliation rule. Without it, cmux
// renumbering (which writes a terminal 'remapped' row for the old ref) lets a
// live session's still-running wrapper vouch for whatever husk later lands on
// its recycled ref — sparing that husk from BOTH the breadcrumb and
// sweepZombieTabs, permanently.
test('BRO-2575: unreconciledLaunchForRef returns the owning launch while the ref is unreconciled', () => {
  const entries = [{ ts: '2026-08-31T00:43:00.000Z', event: 'launch', taskId: 'linear:BRO-2506', workspaceRef: 'workspace:138', marker: 'm1' }];
  assert.equal(ledger.unreconciledLaunchForRef('workspace:138', entries).marker, 'm1');
});

test('BRO-2575: unreconciledLaunchForRef returns null once a terminal row reconciles the ref (recycled-ref strand)', () => {
  const entries = [
    { ts: '2026-08-31T00:43:00.000Z', event: 'launch', taskId: 'linear:BRO-2506', workspaceRef: 'workspace:138', marker: 'm1' },
    { ts: '2026-08-31T01:00:00.000Z', event: 'remapped', taskId: 'linear:BRO-2506', workspaceRef: 'workspace:138', newRef: 'workspace:120' },
  ];
  assert.equal(ledger.unreconciledLaunchForRef('workspace:138', entries), null,
    "a live session's wrapper must not vouch for the next occupant of its old ref");
});

test('BRO-2575: a husk on a recycled ref is still journaled dead even though the old launch\'s wrapper is alive', () => {
  const entries = [
    { ts: '2026-08-31T00:43:00.000Z', event: 'launch', taskId: 'linear:BRO-2506', workspaceRef: 'workspace:138', marker: 'm-alive' },
    { ts: '2026-08-31T01:00:00.000Z', event: 'remapped', taskId: 'linear:BRO-2506', workspaceRef: 'workspace:138', newRef: 'workspace:120' },
    { ts: '2026-08-31T01:05:00.000Z', event: 'launch', taskId: 'linear:BRO-999', workspaceRef: 'workspace:138', marker: 'm-husk' },
  ];
  const { freshDead } = checkDeadDispatch(
    { id: 'linear:BRO-999', subject: 'husk', status: 'in_progress' },
    [{ ref: 'workspace:138', title: '🤖⚡ husk' }], entries,
    CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
    { isWrapperAlive: m => m === 'm-alive' }, // only the OLD session's wrapper is running
  );
  assert.deepEqual(freshDead.map(b => b.taskId), ['linear:BRO-999'],
    'the husk owns the ref now; the remapped session\'s wrapper is not evidence about it');
});

// Codex P1: every behaviour-changing sweep in this fleet ships with a way to
// turn it off without a deploy (ZOMBIE_TAB_SWEEP_DISABLED, NO_PAYLOAD_REAPER_DISABLED).
test('BRO-2575: DEAD_WRAPPER_CHECK_DISABLED=1 restores the exact pre-fix behaviour', () => {
  const prior = process.env.DEAD_WRAPPER_CHECK_DISABLED;
  process.env.DEAD_WRAPPER_CHECK_DISABLED = '1';
  try {
    const { freshDead } = checkDeadDispatch(
      TASK_2506, WORKSPACES, ledgerFor(LIVE_MARKER),
      CMUX_SAYS_DEAD.isDoneTitleFn, CMUX_SAYS_DEAD.claudeAliveInFn, CMUX_SAYS_DEAD.surfaceAliveFn,
      { isWrapperAlive: probeOver(PS_WITH_WRAPPER) },
    );
    assert.deepEqual(freshDead.map(b => b.workspaceRef), ['workspace:138']);
  } finally {
    if (prior === undefined) delete process.env.DEAD_WRAPPER_CHECK_DISABLED;
    else process.env.DEAD_WRAPPER_CHECK_DISABLED = prior;
  }
});

test('BRO-2575: wrapperVouchesAlive says "no evidence" for every degraded input, never "dead"', () => {
  const yes = () => true;
  assert.equal(ledger.wrapperVouchesAlive({ marker: 'm' }, yes), true);
  assert.equal(ledger.wrapperVouchesAlive(null, yes), false, 'no launch row');
  assert.equal(ledger.wrapperVouchesAlive({}, yes), false, 'launch predating the marker field');
  assert.equal(ledger.wrapperVouchesAlive({ marker: 'm' }, null), false, 'no probe supplied');
  assert.equal(ledger.wrapperVouchesAlive({ marker: 'm' }, () => { throw new Error('ps died'); }), false, 'throwing probe');
  assert.equal(ledger.wrapperVouchesAlive({ marker: 'm' }, () => 'truthy-but-not-true'), false, 'strict true only');
});

// ── BRO-2647: resolveCanonicalRepoRoot ──────────────────────────────────────
// REPO in bsc-next.js/linear-next.js is hardcoded to the dev machine's
// checkout and doesn't exist on a CI runner. Feeding it straight into
// resolvePathCheck() as repoRoot made every acceptance-path check refuse as
// phantom in CI, tripping a real, un-mocked process.exit(1) mid test-file
// run (a real process.exit() truncates buffered TAP output before it can
// flush) — the exact "zero subtests, exitCode 1" signature that made main's
// Unit Tests job red. This locks the fix's behavior AND that both known
// dispatcher call sites actually use it, so a third dispatcher (or a
// reverted call site) can't silently recreate the same failure.
const { resolveCanonicalRepoRoot } = require('./dispatch-guards.js');

test('resolveCanonicalRepoRoot: an existing hardcoded path wins over the fallback (the dev-machine case)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2647-repo-root-'));
  try {
    assert.equal(resolveCanonicalRepoRoot(tmp, '/some/unrelated/module/dir'), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCanonicalRepoRoot: falls back to moduleDir/.. when the hardcoded path is absent (the CI case)', () => {
  const bogus = path.join(os.tmpdir(), 'bro-2647-definitely-absent-' + Date.now());
  const moduleDir = '/home/runner/work/Broadwayscore/Broadwayscore/scripts';
  assert.equal(resolveCanonicalRepoRoot(bogus, moduleDir), path.resolve(moduleDir, '..'));
});

test('every resolvePathCheck() call in bsc-next.js and linear-next.js routes repoRoot through resolveCanonicalRepoRoot', () => {
  for (const file of ['../bsc-next.js', '../linear-next.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const calls = src.match(/resolvePathCheck\([^)]*\)/gs) || [];
    assert.ok(calls.length > 0, `${file}: expected at least one resolvePathCheck() call`);
    for (const call of calls) {
      assert.match(call, /resolveCanonicalRepoRoot\(/,
        `${file}: "${call}" must route its repoRoot through resolveCanonicalRepoRoot(), not REPO directly (BRO-2647)`);
    }
  }
});
