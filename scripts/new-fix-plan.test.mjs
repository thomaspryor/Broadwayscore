import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { actionsFromArgs, completeActions, buildPlans, splitName, executedPlanFiles } = require('./new-fix-plan.js');
const { planShapeProblems } = require('./lib/pending-fix-plan-checks.js');

// BRO-5892: the hand-written-plan traps BRO-5853 hit, filled in by the generator.
const shows = () => ({ shows: [{ id: 'a-2026', venue: 'Old', runtime: '2h' }] });

test('flags parse into actions; VALUE is JSON or a bare string', () => {
  const acts = actionsFromArgs(['--edit=a-2026.runtime=2h 10m', '--edit=a-2026.isRevival=true', '--commercial-edit=a.notes="n"', '--review-edit=a-2026/nyt--x.json:criticName="Y"', '--id=bro-1']);
  assert.deepEqual(acts.map((a) => [a.type, a.file, a.showId || a.showSlug, a.field, a.newValue]), [
    ['data-edit', 'shows.json', 'a-2026', 'runtime', '2h 10m'],
    ['data-edit', 'shows.json', 'a-2026', 'isRevival', true],
    ['data-edit', 'commercial.json', 'a', 'notes', 'n'],
    ['review-field-edit', 'a-2026/nyt--x.json', undefined, 'criticName', 'Y'],
  ]);
  assert.throws(() => actionsFromArgs(['--edit=nofield']));
});

test('oldValue comes from current data and chains through earlier edits and stamps', () => {
  const data = shows();
  const { actions, problems } = completeActions([
    { type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'venue', newValue: 'Mid' },
    { type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'venue', newValue: 'New' },
    { type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'openingDate', newValue: '2026-01-02' },
    { type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'openingDateSource', newValue: 'playbill' },
    { type: 'review-field-edit', file: 'data/review-texts/a-2026/x.json', field: 'criticName', newValue: 'B' },
    { type: 'review-field-edit', file: 'a-2026/x.json', field: 'criticName', newValue: 'C' },
    { type: 'review-file-op', operation: 'delete', sourcePath: 'data/review-texts/a-2026/y.json' },
  ], { loadData: () => data, readReview: () => ({ criticName: 'A' }) });
  assert.deepEqual(problems, []);
  assert.deepEqual(actions.map((a) => a.oldValue), ['Old', 'Mid', null, 'human-correction', 'A', 'B', undefined]);
  assert.equal(actions[4].file, 'a-2026/x.json');
  assert.equal(actions[6].sourcePath, 'a-2026/y.json');
  assert.deepEqual(Object.keys(actions[0]).slice(0, 6), ['type', 'file', 'showId', 'field', 'oldValue', 'newValue']);
});

test('refused edits are reported, not written', () => {
  const { problems } = completeActions([
    { type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'tags', newValue: [] },
    { type: 'data-edit', file: 'shows.json', showId: 'missing', field: 'venue', newValue: 'x' },
    { type: 'review-field-edit', file: 'a/none.json', field: 'criticName', newValue: 'x' },
  ], { loadData: shows, readReview: () => null });
  assert.equal(problems.length, 3);
});

test('a value whose JSON type differs from the current one is refused; quoting keeps a string; review paths stay inside', () => {
  const [num] = actionsFromArgs(['--edit=a-2026.runtime=150']);
  assert.equal(num.newValue, 150);
  const bad = completeActions([num], { loadData: shows, readReview: () => null });
  assert.match(bad.problems[0], /runtime would change from string to number.*runtime='"150"'/);
  const [str] = actionsFromArgs(['--edit=a-2026.runtime="150"']);
  assert.deepEqual(completeActions([str], { loadData: shows, readReview: () => null }).problems, []);
  // null and a field that was null take any type.
  assert.deepEqual(completeActions([{ type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'venue', newValue: null }], { loadData: shows, readReview: () => null }).problems, []);
  const review = completeActions([{ type: 'review-field-edit', file: '../../etc/x.json', field: 'criticName', newValue: 'x' }], { loadData: shows, readReview: () => ({}) });
  assert.match(review.problems[0], /inside the review texts/);
});

test('plans split at the cap with -b/-c names, issueNumber = name, and pass the land checks', () => {
  const acts = Array.from({ length: 5 }, (_, i) => ({ type: 'data-edit', file: 'commercial.json', showSlug: 's', field: 'notes', oldValue: i, newValue: i + 1 }));
  const plans = buildPlans('bro-7', 'sum', acts, { max: 2, uuid: () => 'u' });
  assert.deepEqual(plans.map((p) => p.name), ['bro-7', 'bro-7-b', 'bro-7-c']);
  assert.deepEqual(plans.map((p) => p.plan.plan.actions.length), [2, 2, 1]);
  for (const p of plans) {
    assert.equal(p.plan.issueNumber, p.name);
    assert.equal(p.plan.status, 'pending');
    assert.deepEqual(planShapeProblems(`${p.name}.json`, p.plan), []);
  }
  assert.equal(splitName('bro-7', 0), 'bro-7');
});

test('an executed plan is never a --force overwrite target (BRO-4490)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfp-'));
  const write = (n, status) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify({ status })); return f; };
  const applied = write('bro-1.json', 'applied');
  const pending = write('bro-2.json', 'pending');
  const failed = write('bro-4.json', 'validation-failed');
  const partial = write('bro-5.json', 'partial');
  const broken = path.join(dir, 'bro-3.json'); fs.writeFileSync(broken, '{not json');
  assert.deepEqual(executedPlanFiles([applied, pending, broken, failed, partial]), [applied, partial]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a review-file move without destPath is refused (BRO-6481: destinationPath was silently accepted)', () => {
  const noop = { loadData: () => ({}), readReview: () => null };
  const bad = completeActions([{ type: 'review-file-op', operation: 'move', sourcePath: 'a-2026/x.json', destinationPath: 'b-2026/x.json' }], noop);
  assert.match(bad.problems.join('\n'), /move needs destPath/);
  const good = completeActions([{ type: 'review-file-op', operation: 'move', sourcePath: 'data/review-texts/a-2026/x.json', destPath: 'data/review-texts/b-2026/x.json' }], noop);
  assert.deepEqual(good.problems, []);
  assert.equal(good.actions[0].destPath, 'b-2026/x.json');
});

test('buildPlans keeps one show\'s actions in one plan', async () => {
  const { createRequire } = await import('node:module');
  const { buildPlans } = createRequire(import.meta.url)('./new-fix-plan.js');
  const acts = [];
  for (let s = 0; s < 9; s++) for (const f of ['previewsStartDate', 'openingDate', 'openingDateSource']) acts.push({ type: 'data-edit', file: 'shows.json', showId: `s${s}`, field: f, newValue: 'x' });
  const plans = buildPlans('bro-1', 'x', acts, { max: 25 });
  const where = {};
  for (const p of plans) for (const a of p.plan.plan.actions) (where[a.showId] = where[a.showId] || new Set()).add(p.name);
  assert.ok(plans.length >= 2);
  assert.ok(Object.values(where).every((v) => v.size === 1));
  assert.ok(plans.every((p) => p.plan.plan.actions.length <= 25));
});
