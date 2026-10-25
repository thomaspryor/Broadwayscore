import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyChurnCoverage, hasMergeDriver, isExempt } = require('./churn-merge-coverage.js');
// Requiring the CLI is side-effect-free (main() is guarded by require.main===module).
const { parseArgs } = require('../audit-churn-merge-coverage.js');

const f = (path, churn, mergeAttr = 'unspecified', coverageAttr = 'unspecified') => ({
  path,
  churn,
  mergeAttr,
  coverageAttr,
});

test('flags a high-churn tracked file with no merge driver and no exemption', () => {
  const r = classifyChurnCoverage({ files: [f('data/collection-state/progress.json', 531)], minChurn: 30 });
  assert.equal(r.summary.flaggedCount, 1);
  assert.equal(r.flagged[0].path, 'data/collection-state/progress.json');
  assert.equal(r.flagged[0].churn, 531);
  // The verdict object never leaks the raw attribute fields into flagged entries.
  assert.deepEqual(Object.keys(r.flagged[0]).sort(), ['churn', 'path']);
});

test('a real merge driver covers the file (no human conflict)', () => {
  for (const driver of ['ours', 'union', 'binary']) {
    const r = classifyChurnCoverage({ files: [f('data/audit/x.json', 200, driver)], minChurn: 30 });
    assert.equal(r.summary.coveredCount, 1, `${driver} should count as covered`);
    assert.equal(r.summary.flaggedCount, 0);
    assert.equal(r.covered[0].mergeAttr, driver);
  }
});

test('merge-coverage=exempt suppresses the flag when there is no driver', () => {
  const r = classifyChurnCoverage({ files: [f('public/data/shows/a.json', 65, 'unspecified', 'exempt')], minChurn: 30 });
  assert.equal(r.summary.exemptCount, 1);
  assert.equal(r.summary.flaggedCount, 0);
  assert.equal(r.exempt[0].path, 'public/data/shows/a.json');
});

test('a real driver wins over an exempt mark (driver means no conflict regardless)', () => {
  const r = classifyChurnCoverage({ files: [f('data/x.json', 100, 'ours', 'exempt')], minChurn: 30 });
  assert.equal(r.summary.coveredCount, 1);
  assert.equal(r.summary.exemptCount, 0);
  assert.equal(r.summary.flaggedCount, 0);
});

test('files below the churn floor are ignored entirely', () => {
  const r = classifyChurnCoverage({ files: [f('data/low.json', 29), f('data/hi.json', 30)], minChurn: 30 });
  assert.equal(r.summary.highChurnTracked, 1);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].path, 'data/hi.json');
});

test("'unset' (explicit -merge) is treated as no driver", () => {
  assert.equal(hasMergeDriver('unset'), false);
  assert.equal(hasMergeDriver('unspecified'), false);
  assert.equal(hasMergeDriver('ours'), true);
  const r = classifyChurnCoverage({ files: [f('data/x.json', 50, 'unset')], minChurn: 30 });
  assert.equal(r.summary.flaggedCount, 1);
});

test('isExempt only matches the exact exempt token', () => {
  assert.equal(isExempt('exempt'), true);
  assert.equal(isExempt('exempted'), false);
  assert.equal(isExempt('unspecified'), false);
  assert.equal(isExempt(undefined), false);
});

test('results are sorted by churn descending, then path', () => {
  const r = classifyChurnCoverage({
    files: [f('b.json', 40), f('a.json', 100), f('c.json', 40)],
    minChurn: 30,
  });
  assert.deepEqual(r.flagged.map((x) => x.path), ['a.json', 'b.json', 'c.json']);
});

test('malformed entries are skipped, not thrown on', () => {
  const r = classifyChurnCoverage({ files: [null, {}, { path: 5 }, f('ok.json', 50)], minChurn: 30 });
  assert.equal(r.summary.highChurnTracked, 1);
  assert.equal(r.flagged[0].path, 'ok.json');
});

test('mixed realistic set partitions correctly', () => {
  const r = classifyChurnCoverage({
    files: [
      f('data/collection-state/live-progress.json', 546, 'ours'), // covered after fix
      f('public/data/mobile-shows.json', 78, 'unspecified', 'exempt'), // served → exempt
      f('data/llm-scoring-runs.json', 64, 'unspecified', 'exempt'), // accumulate → exempt
      f('data/new-bot-state.json', 90), // a future uncovered file → flagged
      f('data/quiet.json', 5), // below floor → ignored
    ],
    minChurn: 30,
  });
  assert.equal(r.summary.coveredCount, 1);
  assert.equal(r.summary.exemptCount, 2);
  assert.equal(r.summary.flaggedCount, 1);
  assert.equal(r.flagged[0].path, 'data/new-bot-state.json');
});

test('parseArgs: defaults, numeric coercion, and =-containing values survive', () => {
  const d = parseArgs([]);
  assert.equal(d.days, 3);
  assert.equal(d.minChurn, 30);
  assert.equal(d.json, false);

  const c = parseArgs(['--days=7', '--min-churn=20', '--json']);
  assert.equal(c.days, 7);
  assert.equal(c.minChurn, 20);
  assert.equal(c.json, true);

  // The regression this guards: split('=')[1] would truncate at the 2nd '='.
  const o = parseArgs(['--audit-out=/tmp/a=b/x.json']);
  assert.ok(o.auditOut.endsWith('/tmp/a=b/x.json'));
});

test('throws on bad inputs (programmer error, not data)', () => {
  assert.throws(() => classifyChurnCoverage({ files: 'nope', minChurn: 30 }), TypeError);
  assert.throws(() => classifyChurnCoverage({ files: [], minChurn: NaN }), TypeError);
});
