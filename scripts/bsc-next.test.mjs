import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { actionable, pickTask, completedLaunchGuard, deadDispatchGuard, findLiveWorkspaceForTask, notionIdOf, buildSeed, main, USAGE } = require('./bsc-next.js');
const { isDoneTitle } = require('./lib/cmux-workspaces.js');

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
  for (const flag of ['--pick', '--id', '--list', '--dry-run', '--exec', '--model', '--force', '--help, -h']) {
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

test('dispatch command always passes a resolved --model (never bare, never inherits interactive default)', () => {
  const src = fs.readFileSync(new URL('./bsc-next.js', import.meta.url), 'utf8');
  assert.match(src, /claude --model \$\{model\} --dangerously-skip-permissions/);
  // model is resolved via resolveModel() (task #151), not a blanket 'sonnet'
  // literal — the sonnet floor now lives in scripts/lib/bsc-next-model.js.
  assert.match(src, /require\('\.\/lib\/bsc-next-model\.js'\)/);
  assert.match(src, /const model = resolveModel\(/);
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
