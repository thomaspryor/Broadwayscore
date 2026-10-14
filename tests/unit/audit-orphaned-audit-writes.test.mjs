// TESTS-VS-DERIVED-DATA-EXEMPT: structural audit of scripts/workflows; shows.json is not read
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../../scripts/lib/orphaned-audit-writes.js');
const { run, keyOf, loadBaseline } = require('../../scripts/audit-orphaned-audit-writes.js');

const WF = (add) => `jobs:\n  a:\n    steps:\n      - run: |\n          node scripts/foo.js\n          ${add}\n          git commit -m x\n`;
const SRC = "fs.writeFileSync(path.join(root,'data','audit','x.json'), '{}')";

test('extracts writes only when a write call exists, ignores comments', () => {
  assert.deepEqual(lib.extractAuditWrites(SRC), ['data/audit/x.json']);
  assert.deepEqual(lib.extractAuditWrites("const p='data/audit/y.json'; fs.readFileSync(p)"), []);
  assert.deepEqual(lib.extractAuditWrites("// data/audit/z.json\nfs.writeFileSync(a,b)"), []);
});

test('git add coverage: exact, dir, glob, catch-all, continuation', () => {
  assert.ok(lib.workflowStages(WF('git add data/audit/x.json'), 'data/audit/x.json'));
  assert.ok(lib.workflowStages(WF('git add data/audit/'), 'data/audit/x.json'));
  assert.ok(lib.workflowStages(WF('git add data/audit/*.json'), 'data/audit/x.json'));
  assert.ok(lib.workflowStages(WF('git add -A'), 'data/audit/x.json'));
  assert.ok(lib.workflowStages(WF('git add data/a.json \\\n data/audit/x.json'), 'data/audit/x.json'));
  assert.ok(!lib.workflowStages(WF('git add data/audit/other.json'), 'data/audit/x.json'));
});

test('flags the BRO-182 shape: invoked, committed, never staged', () => {
  const bad = lib.findOrphanedWrites({ 'scripts/foo.js': SRC }, { 'wf.yml': WF('git add data/shows.json') });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].file, 'data/audit/x.json');
  assert.deepEqual(lib.findOrphanedWrites({ 'scripts/foo.js': SRC }, { 'wf.yml': WF('git add data/audit/x.json') }), []);
});

test('non-committing workflows, gate workflows and exemptions are not flagged', () => {
  const noCommit = 'steps:\n  - run: node scripts/foo.js\n';
  assert.deepEqual(lib.findOrphanedWrites({ 'scripts/foo.js': SRC }, { 'wf.yml': noCommit }), []);
  assert.deepEqual(lib.findOrphanedWrites({ 'scripts/foo.js': SRC }, { 'test.yml': WF('git add x') }), []);
  assert.deepEqual(lib.findOrphanedWrites({ 'scripts/foo.js': SRC }, { 'wf.yml': WF('git add x') }, { 'scripts/foo.js|data/audit/x.json': 'reason' }), []);
});

test('repo has no orphaned audit writes beyond the reviewed baseline', () => {
  const base = loadBaseline();
  const fresh = run().filter((o) => !base.has(keyOf(o))).map(keyOf);
  assert.deepEqual(fresh, [], 'stage the file in the workflow commit step (see BRO-182)');
});

// BRO-5261 retro-review: a fixed gap left in the baseline would silently
// re-excuse the same regression later. Shrink it: --update-baseline.
test('baseline holds no entries that are no longer orphans', () => {
  const live = new Set(run().map(keyOf));
  const stale = [...loadBaseline()].filter((k) => !live.has(k));
  assert.deepEqual(stale, [], 'run node scripts/audit-orphaned-audit-writes.js --update-baseline');
});

test('helper staging, -A with pathspec, ? glob, nested basename (BRO-5261)', () => {
  assert.ok(lib.workflowStages(WF('bash scripts/lib/git-add-existing.sh data/a.json data/audit/x.json'), 'data/audit/x.json'));
  assert.ok(lib.workflowStages(WF('bash scripts/lib/stage-data-changes.sh'), 'data/audit/x.json'));
  assert.ok(!lib.workflowStages(WF('bash scripts/lib/stage-data-changes.sh data/collection-state/'), 'data/audit/x.json'));
  assert.ok(!lib.workflowStages(WF('git add -A data/shows.json'), 'data/audit/x.json'));
  assert.ok(lib.specCovers('data/audit/x?.json', 'data/audit/xy.json'));
  assert.ok(!lib.specCovers('data/audit/x?.json', 'data/audit/.json'));
  assert.ok(!lib.workflowInvokes('run: node scripts/tests/foo.js', 'scripts/foo.js'));
  assert.ok(lib.workflowInvokes('run: node scripts/foo.js', 'scripts/foo.js'));
  assert.deepEqual(lib.extractAuditWrites('fs.writeFileSync(out, s); // was data/audit/old.json'), []);
});
