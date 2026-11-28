/**
 * BRO-5652: a script that writes a new review fullText into review-texts must
 * stamp textFetchedAt, or isTruncatedScoreNowComplete never sees the complete
 * text that landed after a truncated-text score. Requires the real detector
 * (CLAUDE.md section 15) and runs it on synthetic sources, on real scripts and
 * on the whole scripts/ tree against the advisory baseline (section 19: the
 * baseline holds today's offenders, only a new one fails).
 *
 * Run: node --test tests/unit/text-fetched-at-stamp-audit.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  analyzeStampCoverage, scanUnstampedFullTextWriters, unapprovedUnstampedWriters,
} = require('../../scripts/lib/text-fetched-at-stamp-audit.js');
const baseline = require('../../scripts/lib/text-fetched-at-stamp-baseline.json');
const { creationReached } = require('../../scripts/lib/text-fetched-at-backfill.js');

const offender = (src) => analyzeStampCoverage(src).offender;

describe('analyzeStampCoverage on synthetic writers', () => {
  test('raw write of a freshly fetched body without a stamp is an offender', () => {
    assert.equal(offender(`
      const text = await fetchPage(url);
      data.fullText = text;
      fs.writeFileSync(review.filePath, JSON.stringify(data));
    `), true);
  });
  test('the same writer with a stamp passes', () => {
    assert.equal(offender(`
      const text = await fetchPage(url);
      data.fullText = text;
      data.textFetchedAt = new Date().toISOString();
      fs.writeFileSync(review.filePath, JSON.stringify(data));
    `), false);
  });
  test('guarded writers count as review writes; object literals and shorthand count as fullText writes', () => {
    assert.equal(offender(`const fullText = await scrape(u); safeWriteReview(fp, { ...data, fullText });`), true);
    assert.equal(offender(`createOrMergeReviewFile(id, { url, fields: { fullText: body, contentTier: 'complete' } });`), true);
    assert.equal(offender(`createOrMergeReviewFile(id, { url, fields: { fullText: body, textFetchedAt: now } });`), false);
  });
  test('inline JSON.stringify and Object.assign records still count', () => {
    assert.equal(offender(`fs.writeFileSync(review.filePath, JSON.stringify({ ...data, fullText: text }));`), true);
    assert.equal(offender(`Object.assign(data, { fullText: text }); safeWriteReview(fp, data);`), true);
  });
  test('a shared stamping helper counts as the stamp', () => {
    assert.equal(offender(`const fields = buildManualReviewFields({ fullText: text }); data.fullText = text; safeWriteReview(fp, data);`), false);
  });
  test('a null stamp is not a stamp', () => {
    assert.equal(offender(`data.fullText = body; data.textFetchedAt = null; safeWriteReview(fp, data);`), true);
  });
  test('transforms and copies of a stored body are not new fetches', () => {
    assert.equal(offender(`
      const cleaned = stripNav(data.fullText);
      data.fullText = cleaned;
      data.fullText = data.wrongFullText;
      data.fullText = data.fullText.trim();
      safeWriteReview(fp, data);
    `), false);
  });
  test('a body copied from a freshly fetched record is a new body', () => {
    assert.equal(offender(`const scraped = await fetchReview(u); data.fullText = scraped.fullText; safeWriteReview(fp, data);`), true);
    assert.equal(offender(`const r = await fetchPage(u); review.fullText = r.fullText || null; safeWriteReview(fp, review);`), true);
    assert.equal(offender(`merged.fullText = other.fullText || null; safeWriteReview(fp, merged);`), true);
  });
  test('a local reassigned to a fetch is no longer a stored body', () => {
    assert.equal(offender(`let text = data.fullText; text = await fetchPage(u); data.fullText = text; safeWriteReview(fp, data);`), true);
    assert.equal(offender(`let text = data.fullText; text = text.trim(); data.fullText = text; safeWriteReview(fp, data);`), false);
  });
  test('a self-reassigned holder does not hide another record\'s body', () => {
    assert.equal(offender(`let fields = await scrape(u); fields = { ...fields, url }; existing.fullText = fields.fullText; safeWriteReview(fp, existing);`), true);
  });
  test('a spread record re-cleaning its own body is not a new body', () => {
    assert.equal(offender(`safeWriteReview(fp, { ...data, fullText: data.fullText.trim() });`), false);
  });
  test('a shorthand textFetchedAt bound to null is not a stamp', () => {
    assert.equal(offender(`const textFetchedAt = null; data.fullText = body; safeWriteReview(fp, { ...data, textFetchedAt });`), true);
    assert.equal(offender(`const textFetchedAt = new Date().toISOString(); data.fullText = body; safeWriteReview(fp, { ...data, textFetchedAt });`), false);
  });
  test('clearing fullText, classifier inputs and function-valued keys are not writes', () => {
    assert.equal(offender(`
      data.fullText = null;
      data.fullText = '';
      const verdict = classify({ url, fullText: pageText });
      const gates = { fullText: (d) => isFresh(d) };
      safeWriteReview(fp, data);
    `), false);
  });
  test('a script that never writes review-texts is never an offender', () => {
    assert.equal(offender(`report.fullText = body; fs.writeFileSync(reportPath, JSON.stringify(report));`), false);
  });
  test('comments and strings never count', () => {
    assert.equal(offender(`
      // data.fullText = body;
      const doc = 'data.fullText = body';
      safeWriteReview(fp, data);
    `), false);
  });
});

describe('analyzeStampCoverage on real scripts', () => {
  const real = (rel) => analyzeStampCoverage(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
  test('scrape-reviews.js sets fullText from a scrape, writes the file, never stamps: offender', () => {
    const r = real(['scripts', 'scrape-reviews.js'].join('/'));
    assert.equal(r.writesReviewTexts, true);
    assert.ok(r.fullTextWrites.length > 0);
    assert.equal(r.offender, true);
  });
  test('collect-review-texts.js stamps textFetchedAt: not an offender', () => {
    const r = real('scripts/collect-review-texts.js');
    assert.equal(r.writesReviewTexts, true);
    assert.ok(r.fullTextWrites.length > 0);
    assert.ok(r.stamps.length > 0);
    assert.equal(r.offender, false);
  });
  test('poll-loureviews.js stamps through buildManualReviewFields: not an offender', () => {
    const r = real('scripts/poll-loureviews.js');
    assert.equal(r.writesReviewTexts, true);
    assert.equal(r.offender, false);
  });
  test('clean-timeout-junk.js only rewrites the stored body: not an offender', () => {
    const r = real(['scripts', 'clean-timeout-junk.js'].join('/'));
    assert.equal(r.writesReviewTexts, true);
    assert.deepEqual(r.fullTextWrites, []);
  });
});

describe('scripts/ tree against the baseline', () => {
  test('no new unstamped fullText writer outside the baseline', () => {
    const unexpected = unapprovedUnstampedWriters(scanUnstampedFullTextWriters(root), baseline);
    assert.deepEqual(unexpected, [], unexpected.map((h) => `${h.file}: fullText at line ${h.fullTextLines.join(',')} without textFetchedAt`).join('\n'));
  });
  test('baseline rows name real files and give a reason', () => {
    for (const row of baseline) {
      assert.ok(fs.existsSync(path.join(root, row.file)), row.file);
      assert.ok(row.reason && row.reason.length > 10, row.file);
    }
  });
  test('the guard fires on a new writer in a scratch tree and clears once it stamps', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-audit-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'));
      const file = path.join(tmp, 'scripts', 'new-scraper.js');
      fs.writeFileSync(file, `const body = await fetchPage(u);\nreview.fullText = body;\nsafeWriteReview(review.filePath, review);\n`);
      const hits = unapprovedUnstampedWriters(scanUnstampedFullTextWriters(tmp), baseline);
      assert.deepEqual(hits, [{ file: 'scripts/new-scraper.js', fullTextLines: [2] }]);
      fs.appendFileSync(file, `review.textFetchedAt = new Date().toISOString();\n`);
      assert.deepEqual(unapprovedUnstampedWriters(scanUnstampedFullTextWriters(tmp), baseline), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('creationReached (backfill git walk)', () => {
  const base = { commitCount: 1, depth: 15, versionsRead: 1, addedCommitFound: true };
  test('a full history walk that found the adding commit reached creation', () => {
    assert.equal(creationReached({ ...base, shallow: false }), true);
  });
  test('a shallow clone never counts: its boundary commit only looks like the creation', () => {
    assert.equal(creationReached({ ...base, shallow: true }), false);
  });
  test('a walk cut off by depth, or one that stopped early, did not reach creation', () => {
    assert.equal(creationReached({ ...base, commitCount: 15, versionsRead: 15, shallow: false }), false);
    assert.equal(creationReached({ ...base, commitCount: 3, versionsRead: 2, shallow: false }), false);
    assert.equal(creationReached({ ...base, addedCommitFound: false, shallow: false }), false);
  });
});
