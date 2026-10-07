// BRO-2717: URL-aware junk detection — listing/PR/venue URLs must not become outletIds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyJunkOutletForUrl, isJunkOutlet } = require('./review-normalization.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

test('name-only isJunkOutlet misses the treadmill outlets (premise)', () => {
  assert.equal(isJunkOutlet('southbank'), false);
  assert.equal(isJunkOutlet('spincyclenyc'), false);
});

test('unregistered outlet on listing / PR / venue URLs is junk', () => {
  for (const [id, url] of [
    ['southbank', 'https://southbank.london/whats-on/dog-man-the-musical'],
    ['spincyclenyc', 'https://www.spincyclenyc.com/index.php/theater/823-bathroom-attendant'],
    ['newvenue', 'https://newvenue.example/whats-on/some-show/'],
    ['someticketer', 'https://someticketer.example/some-musical-tickets'],
  ]) {
    const r = classifyJunkOutletForUrl(id, url, { outletKnown: false });
    assert.equal(r.junk, true, url);
  }
});

test('real review URLs and registered outlets are not junk', () => {
  assert.equal(classifyJunkOutletForUrl('timboatswain', 'https://timboatswain.example/2026/10/review-of-hamlet', { outletKnown: false }).junk, false);
  assert.equal(classifyJunkOutletForUrl('nytimes', 'https://www.nytimes.com/2026/10/01/theater/hamlet-review.html', { outletKnown: false }).junk, false);
  assert.equal(classifyJunkOutletForUrl('somevenue', 'https://x.example/whats-on/y', { outletKnown: true }).junk, false);
  assert.equal(classifyJunkOutletForUrl('unknown', 'https://x.example/review', { outletKnown: true }).junk, true);
});

test('writer refuses unregistered outlet on a listing URL from any source, allows escape hatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2717-'));
  try {
    const url = 'https://brandnewvenue.example/whats-on/dog-man-the-musical';
    const r = createOrMergeReviewFile('dog-man-west-end-2026', {
      outletId: 'brandnewvenue', outlet: 'brandnewvenue', criticName: 'Unknown', url, source: 'gather-reviews',
      fields: { fullText: 'A review. '.repeat(80) },
    }, { reviewTextsDir: dir });
    assert.equal(r.guardRefused, true);
    assert.match(r.reason, /^unregistered-outlet-non-review-url/);
    assert.equal(fs.existsSync(path.join(dir, 'dog-man-west-end-2026')), false);
    const r2 = createOrMergeReviewFile('dog-man-west-end-2026', {
      outletId: 'brandnewvenue', outlet: 'brandnewvenue', criticName: 'Unknown', url, source: 'gather-reviews',
      fields: { fullText: 'A review. '.repeat(80), allowNonReviewUrl: true },
    }, { reviewTextsDir: dir });
    assert.doesNotMatch(String(r2.reason || ''), /unregistered-outlet-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writer leaves aggregator-sourced writes, existing-file merges and bare hosts alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2717b-'));
  const show = 'dog-man-west-end-2026';
  const w = (outletId, url, source) => createOrMergeReviewFile(show, {
    outletId, outlet: outletId, criticName: 'Unknown', url, source,
    fields: { fullText: 'A review. '.repeat(80) },
  }, { reviewTextsDir: dir });
  try {
    assert.doesNotMatch(String(w('newblogx', 'https://www.show-score.com/london-theater/dog-man', 'show-score').reason || ''), /unregistered-outlet-non-review-url/);
    assert.doesNotMatch(String(w('newblogy', 'https://newblogy.example/', 'gather-reviews').reason || ''), /unregistered-outlet-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
