import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { commercialGrossesCandidate, compareGrossesRows, compareCostParsers } = require('../../scripts/lib/commercial-grosses-shadow');
const { shadowGrosses } = require('../../scripts/update-commercial-data');
const { extractWeeklyFinancialsFromPost } = require('../../scripts/lib/reddit-grosses');

const text = [
  '***Example***\\- *$1.2 million gross, 81.5% capacity, $123.45 atp*',
  'Gross Less-Fees: $1M; Weekly Operating Cost: \\~$650-\\~$700k/week; Estimated Profit (Loss): $0-($100k)',
  'Estimated percentage recouped: 10%-30%',
  'Additional context.',
].join('\n');
const posts = Array.from({ length: 8 }, (_, i) => ({
  id: `post-${i}`, title: 'Grosses Analysis', created_utc: 1700000000 + i * 7 * 86400, selftext: text,
}));

test('maps current headings, escaped costs and financial ranges to the commercial shape', () => {
  assert.deepEqual(commercialGrossesCandidate(text), [{
    showName: 'Example', weeklyGross: 1200000, capacity: 81.5, atp: 123.45,
    grossLessFees: 1000000, estimatedWeeklyCost: 675000, estimatedProfitLoss: -50000,
    estimatedRecoupmentPct: [10, 30], commentary: 'Additional context.',
  }]);
  const [weekly] = extractWeeklyFinancialsFromPost(text);
  assert.equal(Object.hasOwn(weekly, 'commentary'), false, 'existing weekly callers retain their shape');
});

test('keeps zero profits and maps an open loss to its known bound, with null missing fields', () => {
  const rows = commercialGrossesCandidate('***Zero*** - $500k gross\nEstimated Profit (Loss): $0\n***Loss*** - $500k gross\nEstimated Profit (Loss): ($100k+)');
  assert.equal(rows[0].estimatedProfitLoss, 0);
  assert.equal(rows[1].estimatedProfitLoss, -100000);
  assert.equal(rows[1].estimatedWeeklyCost, null);
  assert.equal(rows[1].estimatedRecoupmentPct, null);
  assert.equal(rows[1].capacity, null);
  assert.equal(rows[1].atp, null);
});

test('reports missing shows, numeric differences and duplicates without copying commentary', () => {
  const result = compareGrossesRows([
    { showName: 'Example', estimatedWeeklyCost: 650000, commentary: 'Private baseline prose' },
    { showName: 'Before only' },
  ], [
    { showName: 'example', estimatedWeeklyCost: 675000 },
    { showName: 'After only' }, { showName: 'After only' },
  ]);
  assert.deepEqual(result.onlyBefore, ['Before only']);
  assert.deepEqual(result.onlyAfter, ['After only', 'After only']);
  assert.equal(result.duplicatesAfter, 1);
  assert.deepEqual(result.differences, [{ showName: 'example', field: 'estimatedWeeklyCost', before: 650000, after: 675000 }]);
  assert.deepEqual(result.commentaryDifferences, [{ showName: 'example', beforeHasText: true, afterHasText: false }]);
  assert.equal(JSON.stringify(result).includes('Private baseline prose'), false);
});

test('cost shadow preserves existing matches and reports only newly readable costs', () => {
  const costs = compareCostParsers([{ id: 'p', selftext: text + '\n***Plain***\nWeekly Operating Cost: $900k' }]);
  assert.equal(costs.beforeRows, 1);
  assert.equal(costs.afterRows, 2);
  assert.deepEqual(costs.added, [{ postId: 'p', showName: 'Example', cost: 675000 }]);
  assert.deepEqual(costs.changed, []);
  assert.deepEqual(costs.removed, []);
});

test('uses cached Sonnet results for exactly the latest 8 posts with no baseline calls', async () => {
  const archive = [...posts, { ...posts[0], id: 'older', created_utc: posts[0].created_utc - 7 * 86400 }]
    .map(post => ({ ...post, sonnetRows: commercialGrossesCandidate(post.selftext) }));
  const report = await shadowGrosses(archive, () => { throw new Error('baseline must not run'); });
  assert.equal(report.sonnetComparisonComplete, true);
  assert.equal(report.weeks.length, 8);
  assert.equal(report.weeks[0].postId, 'post-7');
  assert.equal(report.weeks.some(week => week.postId === 'older'), false);
  for (const week of report.weeks) {
    assert.deepEqual(week.differences, []);
    assert.equal(week.baselineSource, 'cached-sonnet');
    assert.equal(week.wouldUseSonnetFallback, true);
    assert.deepEqual(week.rangesAndFlags[0].profit, { low: -100000, high: 0 });
  }
});

test('cannot claim Sonnet parity from an empty baseline or fewer than 8 posts', async () => {
  const report = await shadowGrosses(posts, async () => []);
  assert.equal(report.sonnetComparisonComplete, false);
  assert.equal(report.weeks[0].baselineSource, 'legacy-regex');
  assert.deepEqual(report.weeks[0].onlyAfter, ['Example']);
  const emptyCache = await shadowGrosses(posts.map(post => ({ ...post, sonnetRows: [] })));
  assert.equal(emptyCache.sonnetComparisonComplete, false);
  await assert.rejects(shadowGrosses(posts.slice(0, 7)), /at least 8/);
  await assert.rejects(shadowGrosses(Array(8).fill(posts[0])), /at least 8/);
});

test('CLI shadow mode returns before commercial writers and fails incomplete comparisons', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-grosses-shadow-'));
  const commercialPath = path.resolve('data/commercial.json');
  const before = fs.existsSync(commercialPath) ? fs.readFileSync(commercialPath) : null;
  try {
    const input = path.join(scratch, 'posts.json');
    fs.writeFileSync(input, JSON.stringify(posts));
    const env = { ...process.env, ANTHROPIC_API_KEY: '' };
    const incomplete = spawnSync(process.execPath, ['scripts/update-commercial-data.js', `--shadow-grosses=${input}`], { env, encoding: 'utf8' });
    assert.equal(incomplete.status, 2, incomplete.stderr);
    assert.match(incomplete.stdout, /"sonnetComparisonComplete": false/);
    assert.doesNotMatch(incomplete.stdout, /Mode: LIVE|Changes applied:/);
    fs.writeFileSync(input, JSON.stringify(posts.map(post => ({ ...post, sonnetRows: commercialGrossesCandidate(post.selftext) }))));
    const complete = spawnSync(process.execPath, ['scripts/update-commercial-data.js', `--shadow-grosses=${input}`], { env, encoding: 'utf8' });
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /"sonnetComparisonComplete": true/);
    const malformed = spawnSync(process.execPath, ['scripts/update-commercial-data.js', '--shadow-grosses'], { env, encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Use --shadow-grosses=FILE/);
    if (before) assert.deepEqual(fs.readFileSync(commercialPath), before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
