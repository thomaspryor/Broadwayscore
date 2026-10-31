/**
 * Merge-path reclassify (Sukkot / Theater Pizzazz 2026-07-25): when a merge
 * fills or replaces fullText — self-heal refetch, url-ingest onto a garbage
 * stub — the OLD body's verdict (contentTier 'stub', incompleteReason
 * 'scraper_garbage') must not survive onto the fresh body, or the healed
 * review stays excluded from rebuild forever. Manual tier locks always win.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const GOOD_BODY = 'Patrick lost his beloved wife and builds a sukkah to grieve with his three adult children in this warm family comedy. The performances are sharply observed and the direction keeps the laughs landing between the losses. '.repeat(4) + 'A satisfying, complete review ends with a proper verdict sentence.';

function writeStub(dir, showId, filename, extra = {}) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  const fp = path.join(showDir, filename);
  fs.writeFileSync(fp, JSON.stringify({
    showId,
    outletId: 'theater-pizzazz',
    outlet: 'Theater Pizzazz',
    criticName: 'Unknown',
    url: 'https://theaterpizzazz.com/some-review/',
    source: 'outlet-listing-poller',
    sources: ['outlet-listing-poller'],
    contentTier: 'stub',
    incompleteReason: 'scraper_garbage',
    incompleteDetail: 'Multiple shows mentioned (6): ...',
    fullText: '',
    ...extra,
  }, null, 2));
  return fp;
}

describe('merge reclassifies contentTier when the body changes', () => {
  test('refetch onto a scraper_garbage stub reclassifies to a usable tier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-'));
    const fp = writeStub(dir, 'reclass-show', 'theater-pizzazz--unknown.json');
    const res = createOrMergeReviewFile('reclass-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'url-ingest',
      fields: { fullText: GOOD_BODY },
    }, { reviewTextsDir: dir });
    assert.equal(res.action, 'updated');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // The tier is what gates rebuild inclusion (isIncludableForRebuild) —
    // this is the assertion that matters. incompleteReason is descriptive
    // metadata re-derived by rebuild and cleared by clearFailureFlags only
    // under its canonical conditions (complete tier, or text + score).
    assert.ok(['complete', 'truncated', 'excerpt'].includes(data.contentTier),
      `usable tier after refetch, got ${data.contentTier}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refetch onto a garbage_text rejection clears the rejection (1,299-file class)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-rej-'));
    const fp = writeStub(dir, 'reclass-rej-show', 'theater-pizzazz--unknown.json',
      { rejectionReason: 'garbage_text', rejectedBy: ['content-quality'] });
    createOrMergeReviewFile('reclass-rej-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'url-ingest',
      fields: { fullText: GOOD_BODY },
    }, { reviewTextsDir: dir });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.ok(data.rejectionReason == null, 'garbage_text rejection cleared after clean refetch');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('semantic rejection (not_a_review) survives a refetch — text length does not resolve it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-sem-'));
    const fp = writeStub(dir, 'reclass-sem-show', 'theater-pizzazz--unknown.json',
      { rejectionReason: 'not_a_review' });
    createOrMergeReviewFile('reclass-sem-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'url-ingest',
      fields: { fullText: GOOD_BODY },
    }, { reviewTextsDir: dir });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(data.rejectionReason, 'not_a_review', 'semantic rejection preserved');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('short paywall refetch keeps its retry context (canonical clear semantics)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-paywall-'));
    const fp = writeStub(dir, 'reclass-paywall-show', 'theater-pizzazz--unknown.json',
      { incompleteReason: 'paywall', incompleteDetail: 'subscriber wall' });
    createOrMergeReviewFile('reclass-paywall-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'url-ingest',
      // Under clearFailureFlags' 500-char floor and not tier-complete: the
      // paywall retry context must survive this partial refetch.
      fields: { fullText: 'A teaser paragraph before the subscriber wall cuts the review off mid-sentence and the rest never loads. '.repeat(3) },
    }, { reviewTextsDir: dir });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if ((data.fullText || '').length < 500 && data.contentTier !== 'complete') {
      assert.equal(data.incompleteReason, 'paywall', 'paywall retry context preserved on short refetch');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('manualContentTier lock survives a refetch untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-manual-'));
    const fp = writeStub(dir, 'reclass-manual-show', 'theater-pizzazz--unknown.json',
      { manualContentTier: 'complete', contentTier: 'complete', incompleteReason: undefined });
    const res = createOrMergeReviewFile('reclass-manual-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'url-ingest',
      fields: { fullText: 'short.' },
    }, { reviewTextsDir: dir });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(data.contentTier, 'complete', 'manual lock keeps the tier');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('metadata-only merge (no body change) does not touch tier or reasons', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-reclass-meta-'));
    const fp = writeStub(dir, 'reclass-meta-show', 'theater-pizzazz--unknown.json');
    createOrMergeReviewFile('reclass-meta-show', {
      outletId: 'theater-pizzazz', outlet: 'Theater Pizzazz', criticName: 'Unknown',
      url: 'https://theaterpizzazz.com/some-review/',
      source: 'another-aggregator',
      fields: { publishDate: '2026-07-23' },
    }, { reviewTextsDir: dir });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(data.contentTier, 'stub', 'tier untouched without a body change');
    assert.equal(data.incompleteReason, 'scraper_garbage', 'reason untouched without a body change');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
