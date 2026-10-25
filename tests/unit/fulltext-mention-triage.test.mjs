import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { classifyUnmatchedReview, summarizeFulltextHits } = require('../../scripts/lib/opening-night-checks/fulltext-mention-triage.js');
const check = require('../../scripts/lib/opening-night-checks/fulltext-mentions-show.check.js');
const { runLifetimeSweep } = require('../../scripts/lib/opening-night-checks/lifetime-sweep-runner.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('triage uses explicit metadata and keeps uncertain records unresolved', () => {
  const cases = [
    [{ wrongProduction: true, contentTier: 'excerpt' }, 230, 'wrong-production'],
    [{ wrongShow: true }, 500, 'wrong-production'],
    [{ isRoundupArticle: true, contentTier: 'truncated' }, 500, 'roundup'],
    [{ contentTier: 'complete' }, 79, 'stub'],
    [{ contentTier: 'excerpt', textQuality: 'full' }, 230, 'excerpt'],
    [{ contentTier: 'truncated' }, 1000, 'truncated'],
    [{ contentTier: 'stub' }, 100, 'stub'],
    [{ textQuality: 'partial' }, 1000, 'truncated'],
    [{ textQuality: 'excerpt' }, 200, 'excerpt'],
    [{ textQuality: 'stub' }, 100, 'stub'],
    [{ contentTier: 'complete', textQuality: 'truncated' }, 1000, 'unresolved'],
    [{ contentTier: 'invalid' }, 300, 'unresolved'],
    [{ wrongProduction: false, wrongShow: false, isRoundupArticle: false }, 300, 'unresolved'],
    // A URL, an old explanation, a title-missing flag, and CV guesses are not
    // proof of a wrong production or an active roundup verdict.
    [{ url: 'https://example.invalid/other-show-review', roundupArticleReason: 'old verdict', textIssues: ['show title not found'], contentVerification: { wrongProduction: true } }, 1000, 'unresolved'],
    [{}, 80, 'unresolved'],
  ];
  for (const [record, length, bucket] of cases) {
    const before = structuredClone(record);
    const result = classifyUnmatchedReview(record, length);
    assert.equal(result.bucket, bucket, JSON.stringify(record));
    assert.equal(result.requiresArticleReview, true);
    assert.ok(result.nextStep);
    assert.deepEqual(record, before);
  }
});

test('public triage output contains only identifiers and allowlisted evidence', () => {
  const privateText = 'PRIVATE ARTICLE BODY OR VERIFIER REASONING';
  const result = classifyUnmatchedReview({ contentTier: privateText, textQuality: privateText,
    fullText: privateText, contentTierReason: privateText, wrongProductionReason: privateText }, 1000);
  const report = summarizeFulltextHits([{ showId: 'fixture', violations: [
    { filename: 'a.json', outletId: 'outlet', url: privateText, criticName: privateText, triage: result },
  ] }]);
  assert.ok(!JSON.stringify(report).includes(privateText));
  assert.ok(!JSON.stringify(report).includes('review-field-edit'));
  assert.equal(report.triage.total, 1);
});

test('outlet draft plans account for every violation and support older snapshots', () => {
  const excerpt = classifyUnmatchedReview({ contentTier: 'excerpt' }, 230);
  const report = summarizeFulltextHits([
    { showId: 'z', violations: [{ filename: 'z.json', outletId: 'b', triage: excerpt }] },
    { showId: 'a', violations: [{ filename: 'a.json', outletId: 'b', triage: excerpt },
      { filename: 'c.json', outletId: 'a' }, { filename: 'd.json' }] },
  ]).triage;
  assert.equal(report.total, 4);
  assert.deepEqual(report.counts, { excerpt: 2, unresolved: 2 });
  assert.deepEqual(report.outletPlans.map(p => p.outletId), ['a', 'b', 'unknown']);
  assert.deepEqual(report.outletPlans[1].candidates.map(c => c.file), ['a/a.json', 'z/z.json']);
  assert.equal(report.outletPlans.reduce((n, p) => n + p.total, 0), report.total);
  assert.deepEqual(summarizeFulltextHits([]).triage, { total: 0, counts: {}, outletPlans: [] });
});

function corpus(t) {
  const dir = fs.mkdtempSync(path.join(root, '.bro-3634-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const show = { id: 'synthetic-title-2026', title: 'Synthetic Title', openingDate: '2026-01-01' };
  const showDir = path.join(dir, 'review-texts', show.id);
  fs.mkdirSync(showDir, { recursive: true });
  const records = [
    { contentTier: 'excerpt', fullText: 'A deliberately anonymous excerpt about the acting. '.repeat(3) },
    { contentTier: 'truncated', fullText: 'A lengthy assessment that omits the production name. '.repeat(15) },
    { wrongProduction: true, fullText: 'A report on an entirely different production. '.repeat(10) },
    { fullText: 'Synthetic Title has an excellent cast.' },
    { fullText: 'Synthetic Title has an excellent cast and a memorable score. '.repeat(3) },
  ].map((data, i) => ({ ...data, url: `https://example.invalid/article/${i}`, outletId: `outlet-${i % 2}` }));
  for (const [i, record] of records.entries()) fs.writeFileSync(path.join(showDir, `${i}.json`), JSON.stringify(record));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: [show] }));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: records.map(r => ({ showId: show.id, url: r.url })) }));
  return { dir, show, records, context: { reviewTextsRoot: path.join(dir, 'review-texts'), reviewsDoc: { [show.id]: records } } };
}

test('the real detector adds hints without waiving mismatches, excerpts, or short warnings', t => {
  const { show, context, records } = corpus(t);
  const before = JSON.stringify(records);
  const result = check.run(show, context);
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'error');
  assert.deepEqual(result.details.violations.map(v => v.triage.bucket), ['excerpt', 'truncated', 'wrong-production']);
  // The detector intentionally warns for any <80-char source, even one that
  // names the title. Triage must preserve that existing behavior too.
  assert.equal(result.details.shortWarnings.length, 1);
  assert.equal(result.details.shortWarnings[0].triage.bucket, 'stub');
  assert.equal(JSON.stringify(records), before);
});

test('the existing sweep serializes outlet plans and preserves its failure exit', t => {
  const { dir } = corpus(t);
  const logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  const exit = runLifetimeSweep({
    checkModule: check, scriptName: 'audit-fulltext-mentions-show-lifetime.js',
    taskRef: 'BRO-3634', snapshotBasename: 'not-written.json', summarizeHits: summarizeFulltextHits,
    argv: ['--json', '--no-snapshot', `--shows-path=${dir}/shows.json`,
      `--reviews-path=${dir}/reviews.json`, `--review-texts-dir=${dir}/review-texts`],
  });
  assert.equal(exit, 1);
  const output = JSON.parse(logs[0]);
  assert.equal(output.totalViolations, 3);
  assert.equal(output.triage.total, output.totalViolations);
  assert.deepEqual(output.triage.counts, { excerpt: 1, truncated: 1, 'wrong-production': 1 });
  assert.equal(output.triage.outletPlans.length, 2);
});
