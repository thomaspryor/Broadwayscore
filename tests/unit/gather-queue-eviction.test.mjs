// BRO-4859: gather-reviews.yml dispatches were silently evicted from a shared
// one-pending-run concurrency group. Covers the FIFO slot gate that replaced the
// group, and the audit that stops another dispatched workflow regressing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { slotDecision, olderActiveRuns } = require(join(root, 'scripts/lib/gather-slot.js'));
const { recordDeferredShows, collectDeferredShows, redispatchPlan } = require(join(root, 'scripts/lib/gather-deferred.js'));
const {
  parseWorkflow,
  loadWorkflows,
  queueEvictionRisks,
  dispatchTargetsIn,
  QUEUE_EVICTION_BASELINE,
} = require(join(root, 'scripts/lib/workflow-dependency-graph.js'));

test('slot gate: starts when fewer than N older runs are active', () => {
  const runs = [
    { id: 10, status: 'in_progress' },
    { id: 20, status: 'completed' },
    { id: 30, status: 'in_progress' }, // me
    { id: 40, status: 'queued' }, // younger: never blocks me
  ];
  assert.deepEqual(slotDecision(runs, 30, 2), { start: true, ahead: [10] });
  assert.equal(slotDecision(runs, 30, 1).start, false);
});

test('slot gate: older waiters block younger runs (FIFO, nothing dropped)', () => {
  const runs = [1, 2, 3, 4].map((id) => ({ id, status: 'in_progress' }));
  const starts = runs.map((r) => slotDecision(runs, r.id, 2).start);
  assert.deepEqual(starts, [true, true, false, false]);
  assert.deepEqual(olderActiveRuns(runs, 4).map((r) => r.id), [1, 2, 3]);
});

test('slot gate: empty run list starts; a bad slot count means 1, never 0', () => {
  assert.equal(slotDecision(null, 5, 2).start, true);
  assert.equal(slotDecision([], 5, 0).start, true);
  assert.equal(slotDecision([{ id: 1, status: 'in_progress' }], 5, 0).start, false);
});

test('slot gate: a run started over 6h ago is treated as hung and ignored', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const runs = [
    { id: 1, status: 'in_progress', startedAt: '2026-10-08T05:00:00Z' }, // 7h: hung
    { id: 2, status: 'in_progress', startedAt: '2026-10-08T11:00:00Z' },
  ];
  assert.deepEqual(slotDecision(runs, 3, 1, now), { start: false, ahead: [2] });
  assert.equal(slotDecision(runs, 3, 2, now).start, true);
});

const wfDir = join(root, '.github', 'workflows');
const DISPATCHER = 'name: D\non:\n  workflow_dispatch: {}\njobs:\n  a:\n    steps:\n      - run: gh workflow run target.yml -f shows=x\n';
const target = (block) =>
  `name: T\non:\n  workflow_dispatch:\n    inputs:\n      shows:\n        type: string\n${block}jobs:\n  a:\n    runs-on: ubuntu-latest\n`;
const risksFor = (block) => {
  const raw = { 'target.yml': target(block), 'd.yml': DISPATCHER };
  return queueEvictionRisks(Object.entries(raw).map(([f, r]) => parseWorkflow(f, r)), raw);
};

test('audit: flags the old gather-reviews shape (static group, cancel false, dispatched)', () => {
  const r = risksFor('concurrency:\n  group: review-texts-backfill-write\n  cancel-in-progress: false\n');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].dispatchers, ['d.yml']);
});

test('audit: per-run group, annotation, or cancel true pass', () => {
  assert.equal(risksFor('concurrency:\n  group: t-${{ github.run_id }}\n  cancel-in-progress: false\n').length, 0);
  assert.equal(
    risksFor('concurrency:\n  # concurrency-queue-ok: debounce\n  group: t\n  cancel-in-progress: false\n').length,
    0,
  );
  assert.equal(risksFor('concurrency:\n  group: t\n  cancel-in-progress: true\n').length, 0);
});

test('audit: script dispatchers count (execSync / REST)', () => {
  assert.deepEqual([...dispatchTargetsIn("execSync('gh workflow run gather-reviews.yml -f shows=a')")], ['gather-reviews.yml']);
  assert.deepEqual([...dispatchTargetsIn('/actions/workflows/foo.yml/dispatches')], ['foo.yml']);
  assert.deepEqual([...dispatchTargetsIn("execFileSync('gh', ['workflow', 'run', 'gather-reviews.yml', '-f', 'shows=a'])")], ['gather-reviews.yml']);
  assert.deepEqual([...dispatchTargetsIn('gh workflow run --ref main gather-reviews.yml -f x=1')], ['gather-reviews.yml']);
  assert.deepEqual([...dispatchTargetsIn('gh workflow run "Gather Review Data" -f shows=x')], ['name:Gather Review Data']);
  assert.deepEqual([...dispatchTargetsIn('gh workflow run x.yml --repo thomaspryor/broadway-scorecard-data')], []);
});

test('audit: a dispatch by display name resolves to the workflow file', () => {
  const raw = {
    'target.yml': target('concurrency:\n  group: t\n  cancel-in-progress: false\n'),
    'd.yml': DISPATCHER.replace('gh workflow run target.yml', 'gh workflow run "T"'),
  };
  const r = queueEvictionRisks(Object.entries(raw).map(([f, x]) => parseWorkflow(f, x)), raw);
  assert.deepEqual(r.map((x) => x.dispatchers), [['d.yml']]);
});

test('repo: gather-reviews.yml is per-run and not flagged; no unbaselined offender', () => {
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  const raw = Object.fromEntries(files.map((f) => [f, readFileSync(join(wfDir, f), 'utf8')]));
  assert.match(raw['gather-reviews.yml'], /^\s+group: gather-reviews-\$\{\{ github\.run_id \}\}$/m);
  assert.match(raw['gather-reviews.yml'], /wait-for-gather-slot\.js/);
  const risks = queueEvictionRisks(loadWorkflows(wfDir), raw);
  assert.ok(!risks.some((r) => r.file === 'gather-reviews.yml'));
  assert.deepEqual(risks.filter((r) => !QUEUE_EVICTION_BASELINE.includes(r.file)), []);
});

test('deferred shows: the remainder replaces the file; merged in order, de-duplicated, junk dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deferred-'));
  try {
    const f = join(dir, 'deferred-shows.txt');
    assert.equal(recordDeferredShows(['a-2026'], undefined), false);
    assert.equal(recordDeferredShows(['a-2026', ' b-2026 ', 'c-2026'], f), true);
    assert.equal(recordDeferredShows(['b-2026', 'c-2026'], f), true); // a-2026 is done
    const merged = collectDeferredShows([readFileSync(f, 'utf8'), 'b-2026,d-2026\n', '$(rm -rf /)\nBad Id\n']);
    assert.deepEqual(merged, ['b-2026', 'c-2026', 'd-2026']);
    assert.equal(recordDeferredShows([], f), false); // all done: file emptied
    assert.equal(readFileSync(f, 'utf8'), '');
    assert.equal(recordDeferredShows(['a-2026'], join(dir, 'missing', 'x.txt')), false); // write fails: no throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo: gather-reviews.js records deferred shows and the workflow re-dispatches them', () => {
  const js = readFileSync(join(root, 'scripts/gather-reviews.js'), 'utf8');
  assert.match(js, /recordDeferredShows\(showIds\);\s*for \(let i = 0; i < showIds\.length/);
  assert.match(js, /recordDeferredShows\(showIds\.slice\(i \+ 1\)\)/);
  const y = readFileSync(join(wfDir, 'gather-reviews.yml'), 'utf8');
  assert.match(y, /GATHER_DEFERRED_FILE: \$\{\{ runner\.temp \}\}\/deferred-shows\.txt/);
  assert.match(y, /name: gather-deferred-\$\{\{ github\.run_id \}\}/);
  // Current attempt only: earlier attempts already re-dispatched their own lists.
  assert.match(y, /pattern: gather-deferred-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/);
  assert.match(y, /collectDeferredShows[\s\S]{0,800}gh workflow run gather-reviews\.yml/);
});

test('deferred shows: a run that deferred everything is not re-dispatched (no loop)', () => {
  assert.deepEqual(redispatchPlan(['b', 'c'], 'a,b,c'), { shows: ['b', 'c'], stalled: false });
  assert.deepEqual(redispatchPlan(['a', 'b'], 'a, b'), { shows: [], stalled: true });
  assert.deepEqual(redispatchPlan([], 'a'), { shows: [], stalled: false });
});
