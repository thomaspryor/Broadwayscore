import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { actionable, pickTask, completedLaunchGuard, deadDispatchGuard, checkDeadDispatch, findLiveWorkspaceForTask, notionIdOf, buildSeed, main, USAGE, successionRefusal, buildSuccessionSeed } = require('./bsc-next.js');
const { isDoneTitle } = require('./lib/cmux-workspaces.js');
const { SUCCESSION_DEPTH_CAP } = require('./lib/dispatch-ledger.js');
const { matchesTaskWorkBranch, findWorkBranchCollisions, workBranchCollisionGuard } = require('./lib/dispatch-guards.js');

// 2026-07-14 incident class + scope add (2026-07-20): `--help` used to fall
// through parseArgs as an unrecognized flag and launch a real Cmux workspace
// on the top task instead of printing usage. main() checks hasHelpFlag()
// BEFORE loadTasks/fetchCard/launchCmux/cmux ever run. Every dep is stubbed
// to throw here (not just left as the real implementation) so this test
// actually PROVES zero side-effecting calls happen for --help/-h, instead of
// merely trusting the guard is still correctly placed — ship-check catch
// (2026-07-20): a test that calls real main() with real deps would itself
// perform a live dispatch if the guard were ever moved.
test('--help / -h return before loadTasks/fetchCard/launchCmux/cmux ever run', () => {
  const throwingDeps = {
    loadTasks: () => { throw new Error('loadTasks must not be called for --help'); },
    fetchCard: () => { throw new Error('fetchCard must not be called for --help'); },
    launchCmux: () => { throw new Error('launchCmux must not be called for --help'); },
    cmuxAvailable: () => { throw new Error('cmuxAvailable must not be called for --help'); },
    listWorkspaces: () => { throw new Error('listWorkspaces must not be called for --help'); },
    isDoneTitle: () => { throw new Error('isDoneTitle must not be called for --help'); },
    claudeAliveIn: () => { throw new Error('claudeAliveIn must not be called for --help'); },
    terminalSurfaceAliveIn: () => { throw new Error('terminalSurfaceAliveIn must not be called for --help'); },
    readLedgerEntries: () => { throw new Error('readLedgerEntries must not be called for --help'); },
    appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for --help'); },
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.doesNotThrow(() => main(['--help'], throwingDeps));
    assert.doesNotThrow(() => main(['--id', '12', '-h'], throwingDeps));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /open a new Cmux workspace/);
  assert.match(logged[1], /open a new Cmux workspace/);
});

test('USAGE documents the flags this CLI accepts', () => {
  for (const flag of ['--pick', '--id', '--list', '--dry-run', '--exec', '--model', '--force', '--succession', '--handoff', '--help, -h']) {
    assert.ok(USAGE.includes(flag), `USAGE missing ${flag}`);
  }
});

// Belt-and-suspenders: run the real CLI as a subprocess. If the --help guard
// were ever removed, this would fall through to loadTasks()/dispatch instead
// of printing usage — this test would then either error on a missing task
// list or (worse) actually open a Cmux workspace.
test('node scripts/bsc-next.js --help prints usage and exits 0 (real process)', () => {
  const out = execFileSync('node', [new URL('./bsc-next.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.match(out, /Usage:/);
  assert.match(out, /--pick 3/);
  assert.doesNotMatch(out, /shared task list/);
  assert.doesNotMatch(out, /opened Cmux workspace/);
});

test('findLiveWorkspaceForTask: matches glyph-prefixed and truncated titles, skips ✅ and unrelated', () => {
  const task = { id: '46', subject: 'Triage 27 open needs-manual-review feedback issues' };
  const ws = (title, ref = 'workspace:1') => ({ ref, title, selected: false });
  // exact launch title (subject.slice(0,50)) with activity glyph prefix
  assert.equal(findLiveWorkspaceForTask(task, [ws('⠂ Triage 27 open needs-manual-review feedback issu')], isDoneTitle).ref, 'workspace:1');
  // cmux-truncated title (shorter than launch title, >=20 chars)
  assert.equal(findLiveWorkspaceForTask(task, [ws('Triage 27 open needs-manual-review')], isDoneTitle).ref, 'workspace:1');
  // ✅-finished twin does NOT block (sweep closes it)
  assert.equal(findLiveWorkspaceForTask(task, [ws('✅ Triage 27 open needs-manual-review feedback issu')], isDoneTitle), null);
  // unrelated + too-short prefixes don't match
  assert.equal(findLiveWorkspaceForTask(task, [ws('Redesign show pages'), ws('Triage 27')], isDoneTitle), null);
  // auto-dispatch naming (scope add, card #168): "🤖 <Project>·<subject>" —
  // the duplicate-dispatch guard must still recognize its own launch title.
  assert.equal(findLiveWorkspaceForTask(task, [ws('🤖 Infra·Triage 27 open needs-manual-review feedback issu')], isDoneTitle).ref, 'workspace:1');
  // ship-check P1 catch: a compliant phase-rename APPENDS text after the
  // launch title (never replaces it — see buildSeed's rename instruction) —
  // the guard must still recognize the workspace as live on this task.
  // (task.subject here is exactly 50 chars, so the launch title carries the
  // FULL subject, unlike the truncation fixtures above.)
  assert.equal(findLiveWorkspaceForTask(task, [ws('🤖 Infra·Triage 27 open needs-manual-review feedback issues — Sprint 2')], isDoneTitle).ref, 'workspace:1');
});

const TASKS = [
  { id: '1', subject: 'P0 task', status: 'in_progress', description: '[notion:aaa] x' },
  { id: '2', subject: 'P1 pending', status: 'pending', description: '[notion:bbb] y' },
  { id: '3', subject: 'done task', status: 'completed', description: 'z' },
  { id: '4', subject: 'P2 pending', status: 'pending', description: 'no marker' },
];

test('actionable = pending before in_progress, completed dropped (no priorities)', () => {
  const a = actionable(TASKS).map(t => t.id);
  assert.deepEqual(a, ['2', '4', '1']); // all rank 9 → pending(2,4) then in_progress(1); 3 dropped
});

test('actionable sorts by Notion priority first (P0 beats P1 beats unranked)', () => {
  const T = [
    { id: '1', subject: 'p1 inprog', status: 'in_progress', description: '[notion:a] P1 Next · In progress' },
    { id: '2', subject: 'unranked pending', status: 'pending', description: 'no marker' },
    { id: '3', subject: 'p0 pending', status: 'pending', description: '[notion:c] P0 Now · Not started' },
    { id: '4', subject: 'p1 pending', status: 'pending', description: '[notion:d] P1 Next · Not started' },
  ];
  // P0(3) → P1 pending(4) before P1 in_progress(1) → unranked(2)
  assert.deepEqual(actionable(T).map(t => t.id), ['3', '4', '1', '2']);
});

test('pickTask default = first actionable', () => {
  assert.equal(pickTask(TASKS, {}).id, '2');
});

test('pickTask --pick N is 1-indexed over the actionable list', () => {
  assert.equal(pickTask(TASKS, { pick: '3' }).id, '1');
  assert.equal(pickTask(TASKS, { pick: '99' }), null);
});

test('pickTask --pick with no value (true) or non-numeric defaults to top task', () => {
  assert.equal(pickTask(TASKS, { pick: true }).id, '2');   // bare --pick flag
  assert.equal(pickTask(TASKS, { pick: 'x' }).id, '2');    // garbage value
});

test('pickTask --id selects that task even if completed', () => {
  assert.equal(pickTask(TASKS, { id: '3' }).id, '3');
  assert.equal(pickTask(TASKS, { id: 'nope' }), null);
});

test('completedLaunchGuard blocks launching a completed task without --force', () => {
  const done = TASKS[2]; // id 3, completed
  assert.match(completedLaunchGuard(done, {}), /already completed/);
  assert.equal(completedLaunchGuard(done, { force: true }), null);
  assert.equal(completedLaunchGuard(done, { 'dry-run': true }), null);     // inspection stays open
  assert.equal(completedLaunchGuard(done, { 'print-prompt': true }), null);
  assert.equal(completedLaunchGuard(TASKS[1], {}), null);                  // non-completed unaffected
});

test('completedLaunchGuard: silent on a completed task carrying a RECHECK-AFTER stamp (task #1355)', () => {
  const recheckTask = { ...TASKS[2], description: 'Verifying the fix held.\nRECHECK-AFTER: 2026-08-20' };
  assert.equal(completedLaunchGuard(recheckTask, {}), null);
});

// Task #334: task #297 got a 3rd cmux workspace dispatched onto it with zero
// visibility into the 2 that had already died silently (killed at the #289
// >30min timeout, never ran the Stop hook's ✅ self-mark). deadDispatchGuard
// refuses once DEAD_ATTEMPT_LIMIT (2) 'dead' breadcrumbs exist for the task.
test('deadDispatchGuard refuses a 3rd dispatch after 2 recorded deaths, --force/--dry-run/--print-prompt bypass it', () => {
  const task = TASKS[0]; // id '1'
  const twoDeaths = [
    { event: 'dead', taskId: '1', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '1', workspaceRef: 'workspace:229' },
  ];
  const msg = deadDispatchGuard(task, twoDeaths, {});
  assert.match(msg, /died 2x already/);
  assert.match(msg, /workspace:227, workspace:229/);
  assert.match(msg, /--force/);
  assert.equal(deadDispatchGuard(task, twoDeaths, { force: true }), null);
  assert.equal(deadDispatchGuard(task, twoDeaths, { 'dry-run': true }), null);
  assert.equal(deadDispatchGuard(task, twoDeaths, { 'print-prompt': true }), null);
});

test('deadDispatchGuard allows dispatch under the limit, and ignores deaths for other tasks', () => {
  const task = TASKS[0]; // id '1'
  const oneDeath = [{ event: 'dead', taskId: '1', workspaceRef: 'workspace:227' }];
  assert.equal(deadDispatchGuard(task, oneDeath, {}), null);
  const otherTaskDeaths = [
    { event: 'dead', taskId: '999', workspaceRef: 'workspace:1' },
    { event: 'dead', taskId: '999', workspaceRef: 'workspace:2' },
  ];
  assert.equal(deadDispatchGuard(task, otherTaskDeaths, {}), null);
  assert.equal(deadDispatchGuard(task, [], {}), null);
});

// Card #1233: the dead-launch rate is ~21% infra (cmux's terminal surface
// never rendered), and a task shouldn't get the "investigate the scope"
// refusal for dying that way twice. deadDispatchGuard must let it through.
test('deadDispatchGuard does NOT refuse a task whose 2 deaths are both infra (paired unverified launch)', () => {
  const task = TASKS[0]; // id '1'
  const infraOnly = [
    { ts: '2026-08-10T10:00:00.000Z', event: 'dead', taskId: '1', workspaceRef: 'workspace:301', failureReason: 'command injection never ran' },
    { ts: '2026-08-10T10:00:00.002Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:301', unverified: true },
    { ts: '2026-08-10T11:00:00.000Z', event: 'dead', taskId: '1', workspaceRef: 'workspace:302', failureReason: 'command injection never ran' },
    { ts: '2026-08-10T11:00:00.002Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:302', unverified: true },
  ];
  assert.equal(deadDispatchGuard(task, infraOnly, {}), null);
});

test('deadDispatchGuard still refuses a task whose 2 deaths are substantive (verified launch, later found dead)', () => {
  const task = TASKS[0]; // id '1'
  const substantiveOnly = [
    { ts: '2026-08-10T09:00:00.000Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:401' },
    { ts: '2026-08-10T11:30:00.000Z', event: 'dead', taskId: '1', workspaceRef: 'workspace:401', failureReason: 'workspace idle, never booted' },
    { ts: '2026-08-10T12:00:00.000Z', event: 'launch', taskId: '1', workspaceRef: 'workspace:402' },
    { ts: '2026-08-10T14:30:00.000Z', event: 'dead', taskId: '1', workspaceRef: 'workspace:402', failureReason: 'workspace idle, never booted' },
  ];
  const msg = deadDispatchGuard(task, substantiveOnly, {});
  assert.match(msg, /died 2x already/);
  assert.match(msg, /workspace:401, workspace:402/);
});

// Ship-check adversarial finding (2026-07-22): a 'dead' breadcrumb written
// ONLY by bsc-prune.js's own sweep would miss a same-SESSION burst — the
// actual #297 incident shape (3 dispatches in one sitting, no sweep in
// between). checkDeadDispatch composes the self-heal (idle-workspace →
// breadcrumb) with the refusal check in one pure call so this exact scenario
// is provable without needing process.exit.
test('checkDeadDispatch catches a same-session burst with ZERO prior dead breadcrumbs (the real #297 shape)', () => {
  const task = { id: '297', subject: 'T1-retrieval Sprint 2' };
  // Two PRIOR launches from earlier in this same session, both now idle
  // (no live claude, not ✅-marked) — but bsc-prune.js has NEVER run, so the
  // ledger has no 'dead' entries yet, only the two 'launch' records.
  const ledgerEntries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:229' },
  ];
  const workspaces = [
    { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' },
    { ref: 'workspace:229', title: 'T1-retrieval Sprint 2' },
  ];
  const isDoneTitle = () => false; // neither ✅-marked
  const claudeAliveIn = () => false; // neither has a live claude — both idle/dead
  const surfaceAliveIn = () => false; // and the second signal agrees — both really dead

  const { freshDead, refusal } = checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitle, claudeAliveIn, surfaceAliveIn, {});
  assert.equal(freshDead.length, 2); // both self-healed from idle workspaces, no sweep needed
  assert.match(refusal, /died 2x already/);
  assert.match(refusal, /workspace:227, workspace:229/);
});

test('checkDeadDispatch: a task with only 1 dead/idle workspace is NOT refused (under the limit)', () => {
  const task = { id: '297', subject: 'T1-retrieval Sprint 2' };
  const ledgerEntries = [{ event: 'launch', taskId: '297', workspaceRef: 'workspace:227' }];
  const workspaces = [{ ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }];
  const { freshDead, refusal } = checkDeadDispatch(task, workspaces, ledgerEntries, () => false, () => false, () => false, {});
  assert.equal(freshDead.length, 1);
  assert.equal(refusal, null);
});

test('checkDeadDispatch: a live or ✅-marked workspace from a past launch is NOT counted as dead', () => {
  const task = { id: '297', subject: 'T1-retrieval Sprint 2' };
  const ledgerEntries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:229' },
  ];
  const workspaces = [
    { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' },        // still alive
    { ref: 'workspace:229', title: '✅ T1-retrieval Sprint 2' },      // finished successfully
  ];
  const isDoneTitle = (t) => t.startsWith('✅');
  const claudeAliveIn = (ref) => ref === 'workspace:227';
  const surfaceAliveIn = () => false;
  const { freshDead, refusal } = checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitle, claudeAliveIn, surfaceAliveIn, {});
  assert.equal(freshDead.length, 0);
  assert.equal(refusal, null);
});

// Card #564: claudeAliveIn alone is the same single-signal trust that #559
// proved has a real false-negative mode (verified live, 2026-07-26 — a
// workspace had claudeAliveIn() === false while still visibly running an
// active Claude Code session). checkDeadDispatch must not count a workspace
// as a fresh-dead breadcrumb when the independent terminal-surface signal
// says it's still alive, even if claudeAliveIn alone said not-alive — same
// shape as #559's pruneDone test in scripts/lib/cmux-workspaces.test.mjs.
test('checkDeadDispatch: does NOT count a workspace as dead when terminalSurfaceAliveIn says alive, even if claudeAliveIn alone said not-alive', () => {
  const task = { id: '297', subject: 'T1-retrieval Sprint 2' };
  const ledgerEntries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:229' },
  ];
  const workspaces = [
    { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }, // registry desync: claudeAliveIn says dead, surface says alive
    { ref: 'workspace:229', title: 'T1-retrieval Sprint 2' }, // both signals agree: truly dead
  ];
  const isDoneTitle = () => false;
  const claudeAliveIn = () => false; // primary registry: both look dead
  const surfaceAliveIn = (ref) => ref === 'workspace:227'; // surface registry disagrees on workspace:227
  const { freshDead, refusal } = checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitle, claudeAliveIn, surfaceAliveIn, {});
  assert.deepEqual(freshDead.map(d => d.workspaceRef), ['workspace:229']);
  assert.equal(refusal, null); // only 1 dead, under DEAD_ATTEMPT_LIMIT
});

test('notionIdOf extracts the embedded page id, null when absent', () => {
  assert.equal(notionIdOf(TASKS[0]), 'aaa');
  assert.equal(notionIdOf(TASKS[3]), null);
});

test('buildSeed first line is the card identity for /resume findability', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'n', priority: 'P1', keyFiles: 'a' });
  assert.equal(seed.split('\n')[0], '[#2] P1 pending —');
});

test('buildSeed includes the task number, subject, notes, and claim instruction', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'the real problem', priority: 'P1 Next', keyFiles: 'a.ts' });
  assert.match(seed, /task #2 in_progress/);
  assert.match(seed, /CARD: P1 pending/);
  assert.match(seed, /Notion: https:\/\/n\/x/);
  assert.match(seed, /Priority: P1 Next/);
  assert.match(seed, /the real problem/);
  assert.match(seed, /ship-check/);
});

test('buildSeed falls back to task.description when no Notion card fetched', () => {
  const seed = buildSeed({ id: '9', subject: 'S', status: 'pending', description: 'fallback body' }, null);
  assert.match(seed, /fallback body/);
});

// Chain break #1 (2026-07-12): a stale seed ended Sprint 1 by telling the
// user to paste the next prompt. EVERY seed must carry the re-read-the-card
// instruction so post-launch card directives (like chaining) are honored.
test('buildSeed always appends the re-read-before-wrap-up instruction', () => {
  const withCard = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'n', priority: 'P1' });
  const withoutCard = buildSeed({ id: '9', subject: 'S', status: 'pending', description: 'd' }, null);
  for (const seed of [withCard, withoutCard]) {
    assert.match(seed, /RE-READ this card via notion-brain get/);
    assert.match(seed, /dispatch the next workspace yourself/);
    assert.match(seed, /never end by telling the user to paste a prompt/);
  }
});

test('buildSeed: with a project, instructs the session to APPEND (never replace) phase text on rename', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'n', priority: 'P1' }, 'Infra');
  assert.match(seed, /🤖 Infra·P1 pending/);
  assert.match(seed, /APPEND the current phase after this exact title/);
  assert.match(seed, /never replace or shorten it/);
  // ship-check P1: the rename command must carry the FULL unchanged launch
  // title, not a placeholder — otherwise the ✅ hook / dup-dispatch guard
  // stop matching the moment a session follows this instruction.
  assert.match(seed, /cmux workspace-action --action rename --title "🤖 Infra·P1 pending — <current phase>"/);
});

test('buildSeed: without a project (backward-compat callers), omits the rename instruction entirely', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'n', priority: 'P1' });
  assert.doesNotMatch(seed, /APPEND the current phase/);
  assert.doesNotMatch(seed, /🤖/);
});

// Context-limit succession (card #856, Session-system overhaul S3): the
// runaway guard is a P0 from the pre-mortem — depth must come from the
// ledger, never a caller-supplied number, and a chain past the cap refuses.
test('successionRefusal: no prior launches → this dispatch is depth 1, never refused', () => {
  assert.deepEqual(successionRefusal('856', []), { newDepth: 1, refusal: null });
});

test('successionRefusal: allows dispatch up to and including the cap', () => {
  const entries = [];
  for (let i = 1; i < SUCCESSION_DEPTH_CAP; i++) {
    entries.push({ event: 'launch', taskId: '856', ts: `2026-08-03T0${i}:00:00Z`, workspaceRef: `workspace:${i}`, ...(i > 1 ? { successionOf: `workspace:${i - 1}` } : {}) });
  }
  // entries chain to depth SUCCESSION_DEPTH_CAP - 1; the next dispatch is
  // exactly at the cap and must still be allowed.
  const result = successionRefusal('856', entries);
  assert.equal(result.newDepth, SUCCESSION_DEPTH_CAP);
  assert.equal(result.refusal, null);
});

test('successionRefusal: refuses the dispatch that would exceed the cap', () => {
  const entries = [];
  for (let i = 1; i <= SUCCESSION_DEPTH_CAP; i++) {
    entries.push({ event: 'launch', taskId: '856', ts: `2026-08-03T0${i}:00:00Z`, workspaceRef: `workspace:${i}`, ...(i > 1 ? { successionOf: `workspace:${i - 1}` } : {}) });
  }
  const result = successionRefusal('856', entries);
  assert.equal(result.newDepth, SUCCESSION_DEPTH_CAP + 1);
  assert.match(result.refusal, new RegExp(`hard cap is ${SUCCESSION_DEPTH_CAP}`));
  assert.match(result.refusal, /chained \d+ succession dispatch/);
});

test('successionRefusal: --force bypasses the cap refusal', () => {
  const entries = [];
  for (let i = 1; i <= SUCCESSION_DEPTH_CAP; i++) {
    entries.push({ event: 'launch', taskId: '856', ts: `2026-08-03T0${i}:00:00Z`, workspaceRef: `workspace:${i}`, ...(i > 1 ? { successionOf: `workspace:${i - 1}` } : {}) });
  }
  const result = successionRefusal('856', entries, { force: true });
  assert.equal(result.refusal, null);
});

test('buildSuccessionSeed embeds the handoff brief verbatim and states the depth/cap', () => {
  const task = { id: '856', subject: 'Session-system S3', status: 'in_progress' };
  const seed = buildSuccessionSeed(task, 'Data', 'sonnet', 3, SUCCESSION_DEPTH_CAP, '## What is done\nfoo\n## What is next\nbar');
  assert.match(seed, /succession \(depth 3\/5\)/);
  assert.match(seed, /Succession depth: 3 of a hard cap of 5/);
  assert.match(seed, /## What is done\nfoo\n## What is next\nbar/);
  assert.match(seed, /RE-READ this card via notion-brain get/);
  assert.match(seed, /successor in a context-limit handoff chain/);
});

// End-to-end succession dispatch (ship-check adversarial catch, 2026-08-03):
// the real dispatch path — context-budget-nudge.sh's instructions — NEVER
// passes --succession-of (that flag is optional caller-supplied provenance
// only). An earlier version keyed successionDepthForTask's chain membership
// on successionOf alone, so every REAL succession launch persisted with
// successionOf:null and silently reset to depth 1 forever — the P0 runaway
// guard never actually engaged in production. Every prior test in this file
// hand-constructed ledger entries with successionOf pre-populated, which is
// exactly why this slipped through: nothing drove runSuccessionDispatch()
// itself against a real read/append round-trip. This test does.
function runSuccessionHarness() {
  const { runSuccessionDispatch } = require('./bsc-next.js');
  const ledger = [];
  const launched = [];
  const paged = [];
  let exitCode = null;
  const origExit = process.exit;
  const deps = {
    launchCmux: () => { const ref = `workspace:${launched.length + 1}`; launched.push(ref); return { ok: true, ref }; },
    readLedgerEntries: () => ledger.slice(),
    appendLedgerEntry: (e) => { const w = { ts: new Date().toISOString(), ...e }; ledger.push(w); return w; },
    fetchCard: () => null,
    // Injected so this end-to-end test never writes to the real, shared
    // data/audit/alert-digest-queue.json (it did, before this seam existed
    // — see pageSuccessionCapExceeded's injection comment in bsc-next.js).
    pageSuccessionCapExceeded: (task, depth) => paged.push({ task, depth }),
    // Injected (CI-red catch, 2026-08-03): without this, runSuccessionDispatch
    // falls back to the REAL file-based lock at data/audit/succession-locks/
    // using this test's real taskId — on this repo's shared/self-hosted
    // runner, a concurrent CI job for another push can hold that exact lock
    // path at the exact moment this test's dispatch 1 tries to acquire it,
    // making the test flake red for a reason that has nothing to do with the
    // depth-cap logic it's actually verifying. An in-memory stub isolates
    // this test from that filesystem race entirely.
    acquireSuccessionLock: () => true,
    releaseSuccessionLock: () => {},
  };
  const dispatchOnce = (task, args) => {
    process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
    try { runSuccessionDispatch(task, args, deps); }
    catch (e) { if (e.message !== '__EXIT__') throw e; }
    finally { process.exit = origExit; }
    const result = { exitCode, launchedCount: launched.length };
    exitCode = null;
    return result;
  };
  return { ledger, launched, paged, dispatchOnce };
}

test('runSuccessionDispatch end-to-end: 5 real successive dispatches succeed, the 6th is refused (no fabricated ledger state)', () => {
  const { ledger, launched, paged, dispatchOnce } = runSuccessionHarness();
  const task = { id: '856', subject: 'E2E succession test', status: 'in_progress' };
  const handoffPath = path.join(os.tmpdir(), `e2e-succession-handoff-${process.pid}.md`);
  fs.writeFileSync(handoffPath, '## Done\nfoo\n## Next\nbar\n');

  for (let i = 1; i <= SUCCESSION_DEPTH_CAP; i++) {
    const r = dispatchOnce(task, { id: task.id, succession: true, handoff: handoffPath });
    assert.equal(r.exitCode, null, `dispatch ${i} should not have refused`);
    assert.equal(r.launchedCount, i);
  }
  // Prove the depth actually accumulated from what runSuccessionDispatch
  // itself wrote to the ledger — not from a test-fabricated fixture.
  const launchEntries = ledger.filter(e => e.event === 'launch');
  assert.equal(launchEntries.length, SUCCESSION_DEPTH_CAP);
  assert.ok(launchEntries.every(e => e.succession === true), 'every real succession launch must set succession:true — this is the flag successionDepthForTask keys on');
  assert.deepEqual(launchEntries.map(e => e.successionDepth), [1, 2, 3, 4, 5]);

  // The 6th real dispatch — same code path, real ledger read-back — refuses.
  const sixth = dispatchOnce(task, { id: task.id, succession: true, handoff: handoffPath });
  assert.equal(sixth.exitCode, 1, 'the 6th succession dispatch must be refused by the depth cap');
  assert.equal(sixth.launchedCount, SUCCESSION_DEPTH_CAP, 'no new workspace launched on refusal');
  assert.equal(paged.length, 1, 'the injected pager (not the real routeAlert) sees exactly the one refusal');

  fs.unlinkSync(handoffPath);
});

test('category filter: Marketing/Partnerships never default-picked, --id still works', () => {
  const { categoryOf, isExcludedCategory } = require('./bsc-next.js');
  const T = [
    { id: '1', subject: 'Scope TodayTix partnership', status: 'pending', description: '[notion:a] P0 Now · Not started · Partnerships\nhttps://n/1' },
    { id: '2', subject: 'LinkedIn post', status: 'pending', description: '[notion:b] P0 Now · Not started · Marketing' },
    { id: '3', subject: 'Fix scraper', status: 'pending', description: '[notion:c] P1 Next · Not started · Product' },
    { id: '4', subject: 'legacy task no category', status: 'pending', description: '[notion:d] P2 · Not started' },
  ];
  assert.equal(categoryOf(T[0]), 'partnerships');
  assert.equal(categoryOf(T[3]), null);            // legacy 2-segment format
  assert.equal(isExcludedCategory(T[3]), false);   // unknown category is NOT excluded
  // default pick skips P0 marketing/partnerships, lands on Product despite lower priority
  assert.equal(pickTask(T, {}).id, '3');
  // actionable hides them; includeExcluded shows them
  assert.deepEqual(actionable(T).map(t => t.id), ['3', '4']);
  assert.equal(actionable(T, true).length, 4);
  // explicit --id can still select a human card
  assert.equal(pickTask(T, { id: '1' }).id, '1');
});

test('verb layer: Admin-category human actions excluded; technical Admin allowed', () => {
  const { isExcludedCategory } = require('./bsc-next.js');
  const email = { id: '1', subject: 'Email volunteers', status: 'pending', description: '[notion:a] P0 Now · Not started · Admin' };
  const reconnect = { id: '2', subject: 'Reconnect App Store Connect', status: 'pending', description: '[notion:b] P2 · Not started · Admin' };
  const trim = { id: '3', subject: 'CLAUDE.md trim + anchor-extraction', status: 'pending', description: '[notion:c] P2 · Not started · Admin' };
  assert.equal(isExcludedCategory(email), true);
  assert.equal(isExcludedCategory(reconnect), true);
  assert.equal(isExcludedCategory(trim), false);
});

test('verb layer word-bound: "Email gate conversion..." (product) allowed, "Email volunteers" excluded', () => {
  const { isExcludedCategory } = require('./bsc-next.js');
  const gate = { subject: 'Email gate conversion critically low at 0.9%', description: '[notion:a] P0 Now · In progress · Product' };
  const vols = { subject: 'Email volunteers', description: '[notion:b] P0 Now · Not started · Admin' };
  assert.equal(isExcludedCategory(gate), false);
  assert.equal(isExcludedCategory(vols), true);
});

// Card #139: tasks created NATIVELY via TaskCreate have no fmt-2 bridge line →
// categoryOf()=null. That must fail CLOSED (verb filter without the ≤5-word
// bound), not fall through to the bounded product-card carve-out.
test('native (null-category) tasks fail closed: human-action verbs excluded regardless of length', () => {
  const { categoryOf, isExcludedCategory } = require('./bsc-next.js');
  const nativeEmail = { id: '1', subject: 'Email volunteers', status: 'pending', description: 'reach out to the volunteer list' };
  const nativeLongVerb = { id: '2', subject: 'Email gate conversion critically low at 0.9%', status: 'pending', description: 'no bridge line here' };
  const nativeTech = { id: '3', subject: 'Fix bsc-next category filter fail-open hole', status: 'pending', description: 'native task, plain description' };
  assert.equal(categoryOf(nativeEmail), null);
  assert.equal(isExcludedCategory(nativeEmail), true);       // the card's exact scenario
  assert.equal(isExcludedCategory(nativeLongVerb), true);    // no word bound without a category vouching Product
  assert.equal(isExcludedCategory(nativeTech), false);       // technical native task stays pickable
  // default pick lands on the technical task, never the native human actions
  assert.equal(pickTask([nativeEmail, nativeLongVerb, nativeTech], {}).id, '3');
  // explicit --id still reaches an excluded native task
  assert.equal(pickTask([nativeEmail, nativeLongVerb, nativeTech], { id: '1' }).id, '1');
});

test('bridge tasks with a category keep the ≤5-word product-card carve-out (unchanged behavior)', () => {
  const { isExcludedCategory } = require('./bsc-next.js');
  const bridgeGate = { subject: 'Email gate conversion critically low at 0.9%', description: '[notion:a] P0 Now · In progress · Product' };
  const bridgeTech = { subject: 'Fix rage clicks', description: '[notion:b] P1 Next · Not started · Product\n' };
  assert.equal(isExcludedCategory(bridgeGate), false);
  assert.equal(isExcludedCategory(bridgeTech), false);
});

// Task #1438 triage: the old version of this test also pinned cmux-launch.js's
// exact `claude --model ${model}${settingsArg} --dangerously-skip-permissions`
// template via a source regex (the #1432/#1434 fragile class — a harmless
// reformat there would break this file's test for zero behavior change). That
// template is now `buildLaunchCommand()`, extracted and behavior-tested
// directly in scripts/lib/cmux-launch.test.mjs. What's left here are
// presence/wiring checks (require + call-site exist), which is the
// 'unavoidable, generic' precedent from autonomous-checks.test.mjs — they
// don't pin formatting, only that the resolveModel() integration wasn't
// silently deleted. The real behavioral proof is the end-to-end test below.
test('bsc-next.js wires resolveModel() and cmux-launch.js in (presence, not formatting)', () => {
  const src = fs.readFileSync(new URL('./bsc-next.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/cmux-launch\.js'\)/);
  assert.match(src, /launchCmuxSession\(\{/);
  assert.match(src, /require\('\.\/lib\/bsc-next-model\.js'\)/);
  assert.match(src, /const model = resolveModel\(/);
});

// Behavior test (task #1438): proves the model resolveModel() actually
// computes is what reaches the real launchCmux() call in main()'s cmux
// dispatch path — an explicit --model flag, and the no-hint/no-card default
// (which must float to the sonnet floor, not a stale/inherited value).
// cmuxAvailable:false skips the duplicate/dead/park guards (unrelated to
// model threading); readLedgerEntries/appendLedgerEntry are stubbed so this
// never touches the real dispatch-ledger.jsonl.
test('main(): resolved model reaches the real launchCmux() call (dispatch command threading)', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bsc-next-model-thread-'));
  const dir = path2.join(tmp, 'tasks');
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(path2.join(dir, '9001.json'), JSON.stringify({
    id: '9001', subject: 'Model threading test task', description: 'no notion id here',
    activeForm: 'Working on it', status: 'pending', blocks: [], blockedBy: [],
  }));
  const calls = [];
  const dispatch = (argv) => {
    calls.length = 0;
    main(argv, {
      loadTasks: () => loadTasks(dir),
      fetchCard: () => null,
      loadLinearMirrorMapping: () => ({}),
      cmuxAvailable: () => false,
      launchCmux: (task, seed, override, model, project) => { calls.push({ task, model, project }); return { ok: true, ref: 'workspace:1' }; },
      appendLedgerEntry: () => {},
      readLedgerEntries: () => [],
    });
  };

  try {
    dispatch(['--id', '9001', '--model', 'opus']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'opus', 'explicit --model flag must be the model launchCmux actually receives');

    dispatch(['--id', '9001']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'sonnet', 'default dispatch (no hint, no card, no triage) must float to the sonnet floor via resolveModel()');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

// resolveModel()'s own resolution-order tests (fable-exclusion, size->model,
// hint precedence) live in scripts/lib/bsc-next-model.test.mjs — this only
// checks that bsc-next.js wires the explicit --model flag through untouched
// (layer 1 must always win, verified end-to-end here since resolveModel's
// own unit tests can't see bsc-next's arg-parsing).
test('explicit --model flag is threaded through as opts.explicitFlag unchanged', () => {
  const { resolveModel } = require('./lib/bsc-next-model.js');
  const task = { id: '1', description: '[notion:x] P1 Next · Not started' };
  assert.equal(resolveModel({ explicitFlag: 'fable', task, card: null, notionId: null, queuePath: '/nonexistent' }), 'fable');
  assert.equal(resolveModel({ explicitFlag: 'opus', task, card: null, notionId: null, queuePath: '/nonexistent' }), 'opus');
});

test('buildSeed: with a model, the quoted title carries the model glyph (production path)', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'n', priority: 'P1' }, 'Infra', 'sonnet');
  assert.match(seed, /🤖⚡ Infra·P1 pending/);
  assert.match(seed, /cmux workspace-action --action rename --title "🤖⚡ Infra·P1 pending — <current phase>"/);
});

// ── Owner-close park guard (task #578) ─────────────────────────────────────
const { parkedGuard } = require('./bsc-next.js');
const PARK = { event: 'vanished', taskId: '42', workspaceRef: 'workspace:7', ts: '2026-08-02T10:00:00.000Z' };

test('parkedGuard: refuses a task whose workspace the owner closed', () => {
  const refusal = parkedGuard({ id: '42' }, [PARK], {});
  assert.match(refusal, /#42 is parked/);
  assert.match(refusal, /workspace:7/);
  assert.match(refusal, /--id 42 --force/, 'must name its own escape hatch');
});

test('parkedGuard: silent for an unparked task', () => {
  assert.equal(parkedGuard({ id: '43' }, [PARK], {}), null);
});

test('parkedGuard: --force / --dry-run / --print-prompt all bypass', () => {
  for (const flag of ['force', 'dry-run', 'print-prompt']) {
    assert.equal(parkedGuard({ id: '42' }, [PARK], { [flag]: true }), null, `${flag} must bypass`);
  }
});

test('parkedGuard: a later launch clears the park (force IS the unpark)', () => {
  const entries = [PARK, { event: 'launch', taskId: '42', workspaceRef: 'workspace:9', ts: '2026-08-02T11:00:00.000Z' }];
  assert.equal(parkedGuard({ id: '42' }, entries, {}), null);
});

// ── Stale-outcome guard (task #1272, the #383 class) ────────────────────────
const { staleOutcomeGuard } = require('./bsc-next.js');
const OUTCOME_TASK = { id: '383', subject: 'Pull design and UX inspo from TodayTix predictions site', description: '[notion:369637c5-416f-8183-8dca-e32d05c59dcc] P0 Now' };

test('staleOutcomeGuard: refuses a card with a filled Outcome and no acceptance criteria', () => {
  const refusal = staleOutcomeGuard(OUTCOME_TASK, { outcome: 'FINDINGS.md written, 12 screenshots.', notes: 'Pull design inspo from TodayTix.' }, {});
  assert.match(refusal, /#383/);
  assert.match(refusal, /#383 class/);
  assert.match(refusal, /--status Done/);
  assert.match(refusal, /369637c5-416f-8183-8dca-e32d05c59dcc/, 'must name the actual notion id, not a placeholder');
});

test('staleOutcomeGuard: silent when Outcome is empty', () => {
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, { outcome: '', notes: 'no criteria here' }, {}), null);
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, { outcome: '   ', notes: 'whitespace-only outcome' }, {}), null);
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, null, {}), null);
});

test('staleOutcomeGuard: silent when the card has real acceptance criteria (a fresh, verifiable re-attempt)', () => {
  const card = { outcome: 'Shipped in a prior pass.', notes: '## Acceptance criteria\n`node --test scripts/lib/foo.test.mjs`' };
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, card, {}), null);
});

test('staleOutcomeGuard: silent when the card declares VERIFY: owner-judgment', () => {
  const card = { outcome: 'Shipped in a prior pass.', notes: 'VERIFY: owner-judgment — only the owner can judge this.' };
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, card, {}), null);
});

test('staleOutcomeGuard: silent on a RECHECK-AFTER-stamped card (legitimate scheduled recheck, not silent staleness)', () => {
  const card = { outcome: 'RECHECK-AFTER: 2026-08-20\nDeployed; verifying it holds after a day of traffic.', notes: 'no acceptance criteria' };
  assert.equal(staleOutcomeGuard(OUTCOME_TASK, card, {}), null);
});

test('staleOutcomeGuard: fires even when notes are unavailable — the exact #383 gap (Outcome is a separate property from Notes)', () => {
  const refusal = staleOutcomeGuard(OUTCOME_TASK, { outcome: 'FINDINGS.md written, 12 screenshots.', notes: '' }, {});
  assert.match(refusal, /REFUSING/);
});

test('staleOutcomeGuard: --force / --allow-unverifiable / --dry-run / --print-prompt all bypass', () => {
  const card = { outcome: 'FINDINGS.md written.', notes: '' };
  for (const flag of ['force', 'allow-unverifiable', 'dry-run', 'print-prompt']) {
    assert.equal(staleOutcomeGuard(OUTCOME_TASK, card, { [flag]: true }), null, `${flag} must bypass`);
  }
});

// ── Single-dispatch-side guard (Phase 0 rail 1, plan 2026-08-12, task #1341) ─
const { linearMirrorGuard, loadLinearMirrorMapping } = require('./bsc-next.js');

test('linearMirrorGuard: refuses a task with a live (non-archived) Linear counterpart, naming the identifier and the linear-next.js command', () => {
  const mapping = { '1341': { linearId: 'uuid-1', identifier: 'BRO-500', title: 'x', project: 'Infrastructure' } };
  const refusal = linearMirrorGuard({ id: '1341' }, mapping, {});
  assert.match(refusal, /#1341/);
  assert.match(refusal, /BRO-500/);
  assert.match(refusal, /node scripts\/linear-next\.js --id BRO-500/);
});

test('linearMirrorGuard: silent when the task is not in the mapping at all', () => {
  assert.equal(linearMirrorGuard({ id: '999' }, {}, {}), null);
  assert.equal(linearMirrorGuard({ id: '999' }, { '1341': { identifier: 'BRO-500' } }, {}), null);
});

test('linearMirrorGuard: silent for a mapping entry retired to Archive (notion_done/noise/idle-stale — not live work on the other side)', () => {
  const retired = { '10': { linearId: 'uuid-2', identifier: 'BRO-11', title: 'x', project: 'Archive', retiredReason: 'notion_done' } };
  assert.equal(linearMirrorGuard({ id: '10' }, retired, {}), null);
});

test('linearMirrorGuard: silent for a mapping entry parked in Archive project even without an explicit retiredReason (belt-and-suspenders)', () => {
  const archived = { '10': { linearId: 'uuid-2', identifier: 'BRO-11', title: 'x', project: 'Archive' } };
  assert.equal(linearMirrorGuard({ id: '10' }, archived, {}), null);
});

test('linearMirrorGuard: silent for a mapping entry missing its identifier (defensive — should never happen in practice)', () => {
  const broken = { '1341': { linearId: 'uuid-1', project: 'Infrastructure' } };
  assert.equal(linearMirrorGuard({ id: '1341' }, broken, {}), null);
});

test('linearMirrorGuard: --force / --dry-run / --print-prompt all bypass', () => {
  const mapping = { '1341': { linearId: 'uuid-1', identifier: 'BRO-500', title: 'x', project: 'Infrastructure' } };
  for (const flag of ['force', 'dry-run', 'print-prompt']) {
    assert.equal(linearMirrorGuard({ id: '1341' }, mapping, { [flag]: true }), null, `${flag} must bypass`);
  }
});

test('loadLinearMirrorMapping: reads a real JSON file', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'linear-mapping-test-'));
  const mappingPath = path2.join(tmp, 'mapping.json');
  fs2.writeFileSync(mappingPath, JSON.stringify({ '1341': { identifier: 'BRO-500' } }));
  try {
    const mapping = loadLinearMirrorMapping(mappingPath);
    assert.equal(mapping['1341'].identifier, 'BRO-500');
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadLinearMirrorMapping: missing/corrupt file fails open to {} (never blocks dispatch on a read error)', () => {
  assert.deepEqual(loadLinearMirrorMapping('/nonexistent/path/mapping.json'), {});
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'linear-mapping-corrupt-'));
  const mappingPath = path2.join(tmp, 'mapping.json');
  fs2.writeFileSync(mappingPath, 'not valid json{{{');
  try {
    assert.deepEqual(loadLinearMirrorMapping(mappingPath), {});
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main(): a task mapped to a live Linear issue is refused before launching anything, even with --headless', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bsc-next-linear-guard-'));
  const dir = path2.join(tmp, 'tasks');
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(path2.join(dir, '1341.json'), JSON.stringify({
    id: '1341', subject: 'A task now tracked on Linear', description: 'no notion id here',
    activeForm: 'Working on it', status: 'pending', blocks: [], blockedBy: [],
  }));
  const origExit = process.exit;
  let exitCode = null;
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(String(msg));
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  try {
    main(['--id', '1341'], {
      loadTasks: () => loadTasks(dir),
      loadLinearMirrorMapping: () => ({ '1341': { linearId: 'x', identifier: 'BRO-500', title: 'y', project: 'Infrastructure' } }),
      launchCmux: () => { throw new Error('launchCmux must never be called once the Linear guard refuses'); },
      fetchCard: () => null,
    });
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal(e.message, '__EXIT__');
  } finally {
    process.exit = origExit;
    console.error = origError;
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(exitCode, 1);
  assert.ok(errors.some(e => /BRO-500/.test(e)), `expected a BRO-500 refusal, got: ${errors.join(' | ')}`);
});

// ── Card #1281: cross-session worktree/job-branch collision guard ──────────
// card #1233 was independently dispatched 3+ times (3 dead cmux attempts,
// then 2-3 concurrent successful sessions each redoing the same fix) because
// findLiveWorkspaceForTask only sees currently-live cmux workspace titles,
// never local git branches. See dispatch-guards.js's workBranchCollisionGuard
// header for the full incident.

test('matchesTaskWorkBranch: matches worktree-<id>-* and job/<id>-* (bsc-runner headless naming)', () => {
  assert.ok(matchesTaskWorkBranch('worktree-1233-infra-death-cap', 1233));
  assert.ok(matchesTaskWorkBranch('worktree-1233-infra-vs-substantive-dead', '1233'));
  assert.ok(matchesTaskWorkBranch('job/1233-msp9eki9', 1233), 'headless bsc-runner job branch');
});

test('matchesTaskWorkBranch: matches a trailing id, still requires the worktree-/job/ prefix', () => {
  assert.ok(matchesTaskWorkBranch('worktree-infra-death-cap-1233', 1233));
  assert.ok(!matchesTaskWorkBranch('infra-death-cap-1233', 1233), 'no worktree-/job/ prefix at all');
});

test('matchesTaskWorkBranch: numeric-substring safety — #123 never matches a #1233 branch or vice versa', () => {
  assert.ok(!matchesTaskWorkBranch('worktree-1233-infra-death-cap', 123));
  assert.ok(!matchesTaskWorkBranch('worktree-infra-death-cap-1233', 123));
  assert.ok(!matchesTaskWorkBranch('worktree-123-something', 1233));
});

test('matchesTaskWorkBranch: known gap — a branch that never mentions the task id is invisible (documented, not silently "fixed")', () => {
  // The actual 3rd #1233 branch from the incident this card describes.
  assert.ok(!matchesTaskWorkBranch('worktree-dead-dispatch-cap-infra-split', 1233));
});

test('findWorkBranchCollisions: only branches matching the task id AND carrying unlanded commits count', () => {
  const statuses = [
    { name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] },
    { name: 'worktree-1233-already-merged', unlandedCommits: [] }, // squash-merged, landed
    { name: 'worktree-999-unrelated-task', unlandedCommits: ['def456 other work'] },
  ];
  const collisions = findWorkBranchCollisions('1233', statuses);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].name, 'worktree-1233-infra-death-cap');
});

test('workBranchCollisionGuard: refuses when a matching branch carries unlanded commits', () => {
  const task = { id: '1233', subject: 'the 2-death dispatch cap fix' };
  const statuses = [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] }];
  const msg = workBranchCollisionGuard(task, statuses, {});
  assert.ok(msg);
  assert.match(msg, /REFUSING to dispatch #1233/);
  assert.match(msg, /worktree-1233-infra-death-cap/);
});

test('workBranchCollisionGuard: silent when the matching branch has zero unlanded commits (already landed/merged)', () => {
  const task = { id: '1233', subject: 'x' };
  const statuses = [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: [] }];
  assert.equal(workBranchCollisionGuard(task, statuses, {}), null);
});

test('workBranchCollisionGuard: --force/--dry-run/--print-prompt all bypass it', () => {
  const task = { id: '1233', subject: 'x' };
  const statuses = [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] }];
  assert.equal(workBranchCollisionGuard(task, statuses, { force: true }), null);
  assert.equal(workBranchCollisionGuard(task, statuses, { 'dry-run': true }), null);
  assert.equal(workBranchCollisionGuard(task, statuses, { 'print-prompt': true }), null);
});

test('workBranchCollisionGuard: ignores collisions belonging to a different task id', () => {
  const task = { id: '999', subject: 'unrelated task' };
  const statuses = [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] }];
  assert.equal(workBranchCollisionGuard(task, statuses, {}), null);
});

test('main(): --id refuses to dispatch when a local worktree branch already carries unlanded commits for that task (the actual #1233 collision shape), never reaching launchCmux', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bsc-next-worktree-branch-guard-'));
  const dir = path2.join(tmp, 'tasks');
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(path2.join(dir, '1233.json'), JSON.stringify({
    id: '1233', subject: 'the 2-death dispatch cap fix', description: 'no notion id here',
    activeForm: 'Working on it', status: 'pending', blocks: [], blockedBy: [],
  }));
  const origExit = process.exit;
  let exitCode = null;
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(String(msg));
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  try {
    main(['--id', '1233'], {
      loadTasks: () => require('./bsc-next.js').loadTasks(dir),
      listWorkBranchStatuses: () => [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] }],
      launchCmux: () => { throw new Error('launchCmux must never be called once the worktree-branch guard refuses'); },
      cmuxAvailable: () => { throw new Error('cmux availability must never even be checked — this guard runs before it'); },
      fetchCard: () => null,
    });
    assert.fail('expected process.exit');
  } catch (e) {
    assert.equal(e.message, '__EXIT__');
  } finally {
    process.exit = origExit;
    console.error = origError;
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(exitCode, 1);
  assert.ok(errors.some(e => /REFUSING to dispatch #1233/.test(e)), `expected a worktree-branch refusal, got: ${errors.join(' | ')}`);
  assert.ok(errors.some(e => /worktree-1233-infra-death-cap/.test(e)));
});

test('main(): --id --force bypasses the worktree-branch guard and proceeds to the cmux duplicate check', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bsc-next-worktree-branch-guard-force-'));
  const dir = path2.join(tmp, 'tasks');
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(path2.join(dir, '1233.json'), JSON.stringify({
    id: '1233', subject: 'the 2-death dispatch cap fix', description: 'no notion id here',
    activeForm: 'Working on it', status: 'pending', blocks: [], blockedBy: [],
  }));
  let listWorkBranchStatusesCalled = false;
  const origExit = process.exit;
  let exitCode = null;
  const origError = console.error;
  console.error = () => {};
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  try {
    main(['--id', '1233', '--force'], {
      loadTasks: () => require('./bsc-next.js').loadTasks(dir),
      listWorkBranchStatuses: () => { listWorkBranchStatusesCalled = true; return [{ name: 'worktree-1233-infra-death-cap', unlandedCommits: ['abc123 fix the thing'] }]; },
      cmuxAvailable: () => false, // sidestep the cmux path entirely once past this guard
      fetchCard: () => null,
      launchCmux: () => ({ ok: true, ref: 'workspace:1' }),
    });
  } catch (e) {
    assert.equal(e.message, '__EXIT__');
  } finally {
    process.exit = origExit;
    console.error = origError;
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
  // --force skips the outer `if (!args.force)` gate entirely — the guard's
  // own I/O function is never even called.
  assert.equal(listWorkBranchStatusesCalled, false);
});

test('main(): --id --dry-run also skips the git I/O entirely (ship-check finding, 2026-08-14: a "dry" preview was still running a real git fetch)', () => {
  const os2 = require('os');
  const path2 = require('path');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'bsc-next-worktree-branch-guard-dryrun-'));
  const dir = path2.join(tmp, 'tasks');
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(path2.join(dir, '1233.json'), JSON.stringify({
    id: '1233', subject: 'the 2-death dispatch cap fix', description: 'no notion id here',
    activeForm: 'Working on it', status: 'pending', blocks: [], blockedBy: [],
  }));
  let listWorkBranchStatusesCalled = false;
  const origLog = console.log;
  console.log = () => {};
  try {
    main(['--id', '1233', '--dry-run'], {
      loadTasks: () => require('./bsc-next.js').loadTasks(dir),
      listWorkBranchStatuses: () => { listWorkBranchStatusesCalled = true; return []; },
      fetchCard: () => null,
    });
  } finally {
    console.log = origLog;
    fs2.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(listWorkBranchStatusesCalled, false);
});

// ── Card #854: archive/ lookup, live-dir-only loadTasks ─────────────────────
const os = require('os');
const path = require('path');
const { loadTasks } = require('./bsc-next.js');

test('loadTasks: stays live-dir-only — does not merge archive/ (ship-check finding: eager merge re-read the whole archive on every call)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-next-loadtasks-'));
  fs.writeFileSync(path.join(dir, '5.json'), JSON.stringify({ id: '5', subject: 'live pending', status: 'pending' }));
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '2.json'), JSON.stringify({ id: '2', subject: 'old finished work', status: 'completed' }));
  const tasks = loadTasks(dir);
  assert.deepEqual(tasks.map((t) => t.id), ['5']);
});

test('pickTask: --id falls back to a point lookup in archive/ when the dir is passed and the live array misses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-next-picktask-archive-'));
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '2.json'), JSON.stringify({ id: '2', subject: 'old finished work', status: 'completed' }));
  const tasks = [{ id: '5', subject: 'live pending', status: 'pending' }];
  assert.equal(pickTask(tasks, { id: '2' }, dir).subject, 'old finished work');
  assert.equal(pickTask(tasks, { id: '2' }), null, 'no dir passed — pre-#854 behavior, archived id not found');
  assert.equal(pickTask(tasks, { id: '999' }, dir), null, 'dir passed but id truly does not exist anywhere');
});
