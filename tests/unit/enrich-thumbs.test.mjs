/**
 * Unit tests for thumb enrichers (DTLI + BWW RR).
 *
 * Both enrichers MUST:
 *   - Merge dtliThumb / bwwThumb onto existing review files (never overwrite scores)
 *   - Set url only when the existing file has none
 *   - Not fabricate files for unmatched extractor rows
 *   - No-op when extractor returns nothing
 *
 * Card: 34c637c5-416f-8147-b7de-dcc260d0a151
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { enrichDtliThumbsForShow } = require('../../scripts/enrich-dtli-thumbs.js');
const { enrichBwwThumbsForShow } = require('../../scripts/enrich-bww-thumbs.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function mkTmpShowDir(showId) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-thumbs-'));
  const rel = path.join('data', 'review-texts', showId);
  const abs = path.join(ROOT, rel);
  // Save caller's existing dir if any, redirect via a symlink side-channel —
  // but test harness just uses real file writes inside the real repo path and cleans up.
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  return { abs, tmp };
}

function writeReview(showDir, filename, obj) {
  fs.writeFileSync(path.join(showDir, filename), JSON.stringify(obj, null, 2));
}

function readReview(showDir, filename) {
  return JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf-8'));
}

function cleanupShowDir(abs) {
  try {
    for (const f of fs.readdirSync(abs)) fs.unlinkSync(path.join(abs, f));
    fs.rmdirSync(abs);
  } catch { /* ignore */ }
}

describe('enrichDtliThumbsForShow', () => {
  test('sets dtliThumb on an existing review file without overwriting score', async () => {
    const showId = 'test-enrich-dtli-' + Date.now();
    const { abs: showDir } = mkTmpShowDir(showId);
    try {
      writeReview(showDir, 'nytimes--jesse-green.json', {
        showId, outletId: 'nytimes', outlet: 'The New York Times',
        criticName: 'Jesse Green',
        url: 'https://nytimes.com/2026/04/22/theater/beaches-review-broadway.html',
        llmScore: { score: 78 }, fullText: 'x'.repeat(500),
      });

      // Synthetic DTLI HTML: one review-item block that matches the NYT file.
      const html = `
        <div class="review-item">
          <div class="review_image"><div>The New York Times</div></div>
          <h2 class="review-item-critic-name"><a href="#">Jesse<br/>Green</a></h2>
          <h3 class="review-item-date">April 22, 2026</h3>
          <p class="paragraph">Strong opening number, mid-act slump.</p>
          <img alt="BigThumbs_Up" />
          <a href="https://nytimes.com/2026/04/22/theater/beaches-review-broadway.html" class="button-pink review-item-button">Read full review</a>
        </div>`;
      const fakeFetchPage = async () => ({ content: html, format: 'html' });

      const result = await enrichDtliThumbsForShow(showId, {
        url: 'https://didtheylikeit.com/shows/beaches/',
        fetchPage: fakeFetchPage,
      });

      assert.strictEqual(result.extracted, 1);
      assert.strictEqual(result.enrichedThumb, 1);
      const after = readReview(showDir, 'nytimes--jesse-green.json');
      assert.strictEqual(after.dtliThumb, 'Up', 'dtliThumb should be set from DTLI extraction');
      assert.strictEqual(after.llmScore.score, 78, 'LLM score must be untouched');
      assert.strictEqual(after.fullText.length, 500, 'fullText must be untouched');
    } finally {
      cleanupShowDir(showDir);
    }
  });

  test('does not overwrite an existing url', async () => {
    const showId = 'test-enrich-dtli-url-' + Date.now();
    const { abs: showDir } = mkTmpShowDir(showId);
    try {
      writeReview(showDir, 'nytimes--jesse-green.json', {
        showId, outletId: 'nytimes', outlet: 'The New York Times',
        criticName: 'Jesse Green',
        url: 'https://nytimes.com/original-url.html',
      });
      const html = `
        <div class="review-item">
          <div class="review_image"><div>The New York Times</div></div>
          <h2 class="review-item-critic-name"><a href="#">Jesse<br/>Green</a></h2>
          <h3 class="review-item-date">April 22, 2026</h3>
          <p class="paragraph">Some review excerpt content here that passes the length gate.</p>
          <img alt="BigThumbs_Meh" />
          <a href="https://nytimes.com/dtli-suggested-url.html" class="button-pink review-item-button">Read full review</a>
        </div>`;
      const fakeFetchPage = async () => ({ content: html, format: 'html' });

      await enrichDtliThumbsForShow(showId, {
        url: 'https://didtheylikeit.com/shows/beaches/',
        fetchPage: fakeFetchPage,
      });

      const after = readReview(showDir, 'nytimes--jesse-green.json');
      assert.strictEqual(after.url, 'https://nytimes.com/original-url.html', 'existing url must be preserved');
      assert.strictEqual(after.dtliThumb, 'Meh');
    } finally {
      cleanupShowDir(showDir);
    }
  });

  test('no-op when DTLI returns zero reviews', async () => {
    const showId = 'test-enrich-dtli-empty-' + Date.now();
    const { abs: showDir } = mkTmpShowDir(showId);
    try {
      writeReview(showDir, 'nytimes--jesse-green.json', {
        showId, outletId: 'nytimes', criticName: 'Jesse Green', fullText: 'existing',
      });
      const fakeFetchPage = async () => ({ content: '<html></html>', format: 'html' });
      const result = await enrichDtliThumbsForShow(showId, {
        url: 'https://didtheylikeit.com/shows/beaches/',
        fetchPage: fakeFetchPage,
      });
      assert.strictEqual(result.enrichedThumb, 0);
      assert.strictEqual(result.enrichedUrl, 0);
      const after = readReview(showDir, 'nytimes--jesse-green.json');
      assert.strictEqual(after.dtliThumb, undefined);
    } finally {
      cleanupShowDir(showDir);
    }
  });
});

describe('enrichBwwThumbsForShow', () => {
  test('sets bwwThumb on an existing review file without overwriting score', async () => {
    const showId = 'test-enrich-bww-' + Date.now();
    const { abs: showDir } = mkTmpShowDir(showId);
    try {
      writeReview(showDir, 'nytimes--jesse-green.json', {
        showId, outletId: 'nytimes', outlet: 'The New York Times',
        criticName: 'Jesse Green',
        url: 'https://nytimes.com/existing.html',
        llmScore: { score: 82 },
      });

      // Inject a fake extractBWWRoundupReviews to avoid loading the real
      // gather-reviews.js (which has many transitive deps like playwright).
      const fakeExtract = () => ([
        {
          showId, outletId: 'nytimes', outlet: 'The New York Times',
          criticName: 'Jesse Green',
          bwwThumb: 'Up',
          url: 'https://nytimes.com/bww-suggested.html',
        },
      ]);
      const fakeFetchPage = async () => ({ content: '<html>bww rr</html>', format: 'html' });

      const result = await enrichBwwThumbsForShow(showId, {
        url: 'https://broadwayworld.com/article/Review-Roundup-BEACHES-20260422',
        title: 'Beaches, A New Musical',
        fetchPage: fakeFetchPage,
        extractBWWRoundupReviews: fakeExtract,
      });

      assert.strictEqual(result.enrichedThumb, 1);
      const after = readReview(showDir, 'nytimes--jesse-green.json');
      assert.strictEqual(after.bwwThumb, 'Up');
      assert.strictEqual(after.url, 'https://nytimes.com/existing.html', 'existing URL preserved');
      assert.strictEqual(after.llmScore.score, 82, 'LLM score untouched');
    } finally {
      cleanupShowDir(showDir);
    }
  });

  test('does not create a file for unmatched critic', async () => {
    const showId = 'test-enrich-bww-nomatch-' + Date.now();
    const { abs: showDir } = mkTmpShowDir(showId);
    try {
      // No existing review files.
      const fakeExtract = () => ([{
        showId, outletId: 'nytimes', criticName: 'Jesse Green', bwwThumb: 'Up',
      }]);
      const fakeFetchPage = async () => ({ content: '<html>bww rr</html>', format: 'html' });

      const result = await enrichBwwThumbsForShow(showId, {
        url: 'https://broadwayworld.com/article/X',
        title: 'Beaches, A New Musical',
        fetchPage: fakeFetchPage,
        extractBWWRoundupReviews: fakeExtract,
      });

      assert.strictEqual(result.enrichedThumb, 0);
      assert.strictEqual(result.skippedMissing, 1);
      const files = fs.readdirSync(showDir);
      assert.strictEqual(files.length, 0, 'No files should be created');
    } finally {
      cleanupShowDir(showDir);
    }
  });
});
