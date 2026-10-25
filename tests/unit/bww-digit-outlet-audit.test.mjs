import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditDigitOutletFields, auditBwwDigitOutlets } = require('../../scripts/lib/bww-digit-outlet-audit');
const { parseArticleBodyReviews } = require('../../scripts/lib/bww-roundup-parser');
const clean = 'A beautifully staged production with an outstanding ensemble.';
const byline = 'Matthew Wexler, 1 Minute Critic:';
const body = `Jesse Green, The New York Times: ${clean} ${byline} A delight. Adam Feldman, Time Out: Excellent.`;
const pairs = parseArticleBodyReviews(body);

test('reports both stale fields using the landed parser, without mutating the record', () => {
  const record = { outlet: 'The New York Times', criticName: 'Jesse Green',
    bwwExcerpt: `${clean} ${byline} A delight.`, fullText: `${clean} ${byline} A delight.` };
  const before = structuredClone(record);
  const findings = auditDigitOutletFields(pairs, record);
  assert.deepEqual(findings.map(f => f.field), ['bwwExcerpt', 'fullText']);
  assert.ok(findings.every(f => f.cleanLength === clean.length && f.reason === 'swallowed-digit-outlet'));
  assert.deepEqual(record, before);
});

test('excludes clean quotes, full roundup articles and unrelated full reviews', () => {
  for (const record of [
    { outletId: 'nytimes', bwwExcerpt: clean, fullText: 'An independently scraped full review.' },
    { outletId: 'broadwayworld', fullText: body },
    { outletId: 'nytimes', fullText: `A full article mentions ${byline} without copying the archived prefix.` },
    { outletId: 'nytimes', bwwExcerpt: `${clean} Some unrelated added text.` },
    { outletId: 'nytimes', bwwExcerpt: `${clean} 10 Downing Street: a setting.` },
  ]) assert.deepEqual(auditDigitOutletFields(pairs, record), []);
});

test('finds a truncated byline and an unknown stored critic using source text', () => {
  const findings = auditDigitOutletFields(pairs, { outletId: 'nytimes', criticName: 'Unknown',
    bwwExcerpt: `${clean} Matthew Wexler, 1 Mi...` });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'truncated-digit-outlet-byline');
  assert.deepEqual(auditDigitOutletFields(pairs, { outletId: 'nytimes', bwwExcerpt: `${clean} M...` }), []);
});

test('handles entity and whitespace normalization and other digit-leading outlets', () => {
  const other = parseArticleBodyReviews('Jesse Green, The New York Times: Poise & polish. Jane Smith, 20 Something Theatre: A winner.');
  assert.equal(auditDigitOutletFields(other, { outletId: 'nytimes',
    bwwExcerpt: 'Poise &amp; polish.\nJane Smith, 20 Something Theatre: A winner.' }).length, 1);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bww-digit-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveDir = path.join(root, 'archive');
  const reviewDir = path.join(root, 'reviews');
  fs.mkdirSync(archiveDir);
  fs.mkdirSync(path.join(reviewDir, 'example'), { recursive: true });
  const file = path.join(reviewDir, 'example', 'nytimes--jesse-green.json');
  const record = { outletId: 'nytimes', bwwExcerpt: `${clean} ${byline} A delight.` };
  fs.writeFileSync(file, JSON.stringify(record));
  return { archiveDir, reviewDir, file, record };
}

function writeArchive(f, ld) {
  fs.writeFileSync(path.join(f.archiveDir, 'example.html'),
    `<script data-example="yes" type='application/ld+json'>${JSON.stringify(ld)}</script>`);
}

test('sweeps arrays, graphs and multiple JSON-LD blocks once per field; never prints review text', t => {
  const f = fixture(t);
  writeArchive(f, [{ '@graph': [{ articleBody: body }, { articleBody: body }] }]);
  fs.appendFileSync(path.join(f.archiveDir, 'example.html'),
    `<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>`);
  const before = fs.readFileSync(f.file, 'utf8');
  const report = auditBwwDigitOutlets(f);
  assert.equal(report.archivesScanned, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.affectedFiles, 1);
  assert.deepEqual(report.affectedShows, ['example']);
  assert.equal(report.findings[0].file, 'example/nytimes--jesse-green.json');
  assert.equal(JSON.stringify(report).includes(clean), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('reports rejected archives, bad JSON and missing review directories for manual review', t => {
  const f = fixture(t);
  writeArchive(f, { articleBody: body });
  const report = auditBwwDigitOutlets({ ...f, checkArchive: () => ({ reason: 'wrong-production' }) });
  assert.equal(report.findings.length, 0);
  assert.equal(report.manualReview[0].reason, 'wrong-production');
  fs.writeFileSync(path.join(f.archiveDir, 'bad.html'), '<script type="application/ld+json">{bad</script>');
  fs.writeFileSync(path.join(f.archiveDir, 'missing.html'), `<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>`);
  fs.writeFileSync(f.file, '{bad');
  fs.writeFileSync(path.join(f.reviewDir, 'example', 'null-review.json'), 'null');
  const reasons = auditBwwDigitOutlets(f).manualReview.map(x => x.reason);
  assert.ok(reasons.includes('unreadable-article-body'));
  assert.ok(reasons.includes('missing-review-directory'));
  assert.ok(reasons.includes('unreadable-review'));
});

test('compact spelling is surfaced for manual review even when the parser cannot split it', t => {
  const f = fixture(t);
  writeArchive(f, { articleBody: body.replace('1 Minute Critic', '1minutecritic') });
  assert.ok(auditBwwDigitOutlets(f).manualReview.some(x => x.reason === 'compact-digit-outlet-spelling'));
});

test('missing archive directory fails closed', t => {
  const f = fixture(t);
  assert.throws(() => auditBwwDigitOutlets({ ...f, archiveDir: path.join(f.archiveDir, 'absent') }), /ENOENT/);
});
