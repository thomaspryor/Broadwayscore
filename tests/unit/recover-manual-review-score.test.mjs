/**
 * Tests for scripts/lib/recover-manual-review-score.js — opportunistic
 * score recovery for ingest-manual-review.js.
 *
 * Driver: Rocky Horror 2026-04-23 opening night surfaced both NYSR critics
 * (Verini, Sommers) landing originalScore=null because the manual paste
 * dropped the article header that holds the ★★☆☆☆ rating. The collect
 * pipeline already runs extractScore on raw HTML — verified live against
 * the Verini URL, returns 2/5. Manual ingest never sees HTML, hence this
 * recovery path.
 *
 * Fixture: tests/fixtures/star-ratings/nysr-rhs-2026.html captured live
 * 2026-04-25 from Verini's RHS review page.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

const {
  recoverFromText,
  recoverFromUrl,
  _hasDedicatedExtractor,
} = require(resolve(ROOT, 'scripts/lib/recover-manual-review-score.js'));

const NYSR_HTML = readFileSync(
  resolve(ROOT, 'tests/fixtures/star-ratings/nysr-rhs-2026.html'),
  'utf8'
);

describe('_hasDedicatedExtractor', () => {
  test('returns true for outlets with dedicated extractor (nysr)', () => {
    assert.equal(_hasDedicatedExtractor('nysr'), true);
    assert.equal(_hasDedicatedExtractor('NYSR'), true);
    assert.equal(_hasDedicatedExtractor('timeout'), true);
    assert.equal(_hasDedicatedExtractor('guardian'), true);
  });

  test('returns false for noScoreExtractor outlets (variety, nytimes)', () => {
    assert.equal(_hasDedicatedExtractor('variety'), false);
    assert.equal(_hasDedicatedExtractor('nytimes'), false);
    assert.equal(_hasDedicatedExtractor('vulture'), false);
  });

  test('returns false for unknown outlets', () => {
    assert.equal(_hasDedicatedExtractor(''), false);
    assert.equal(_hasDedicatedExtractor(null), false);
    assert.equal(_hasDedicatedExtractor('not-a-real-outlet'), false);
  });
});

describe('recoverFromText', () => {
  test('returns null for body-only NYSR paste (stars stripped from header)', () => {
    // This is the actual fullText pasted into Verini's file — body only.
    const body = "Rocky Horror lives – in The Rocky Horror Picture Show, that is, made on a shoestring in 1975. A Frankenstein spoof mixed with transvestism, kinky sex and threatening space aliens, it was released to tepid reviews and barely registered at the box office.";
    assert.equal(recoverFromText(body, 'nysr'), null);
  });

  test('extracts X/5 stars when paste includes them in first 15%', () => {
    const text = '★★★☆☆ Mixed verdict. ' + 'Lorem ipsum '.repeat(200);
    const r = recoverFromText(text, 'nysr');
    assert.ok(r, 'should extract');
    assert.equal(r.normalizedScore, 60);
    assert.equal(r.originalScore, '3/5 stars');
  });

  test('returns null on empty input', () => {
    assert.equal(recoverFromText('', 'nysr'), null);
    assert.equal(recoverFromText(null, 'nysr'), null);
    assert.equal(recoverFromText('text', ''), null);
  });
});

describe('recoverFromUrl with injected fetcher', () => {
  test('extracts ★★☆☆☆ = 40 from NYSR Verini RHS HTML fixture', async () => {
    const fakeFetch = async (url) => ({ content: NYSR_HTML, format: 'html' });
    const r = await recoverFromUrl(
      'https://nystagereview.com/2026/04/23/the-rocky-horror-show-lets-not-do-the-time-warp-again-and-say-we-did/',
      'nysr',
      { fetchPage: fakeFetch }
    );
    assert.ok(r, 'should extract a score from real NYSR HTML');
    assert.equal(r.normalizedScore, 40);
    assert.equal(r.originalScore, '2/5 stars');
    assert.equal(r.source, 'unicode-stars');
  });

  test('returns null for noScoreExtractor outlets — no fetch attempted', async () => {
    let fetchCalled = false;
    const fakeFetch = async () => { fetchCalled = true; return { content: 'x' }; };
    const r = await recoverFromUrl('https://nytimes.com/x', 'nytimes', { fetchPage: fakeFetch });
    assert.equal(r, null);
    assert.equal(fetchCalled, false, 'should skip fetch for noScoreExtractor');
  });

  test('returns null when fetch throws — does not propagate', async () => {
    const fakeFetch = async () => { throw new Error('network down'); };
    const r = await recoverFromUrl('https://nystagereview.com/x', 'nysr', {
      fetchPage: fakeFetch,
      log: () => {},
    });
    assert.equal(r, null);
  });

  test('returns null when fetch returns no html', async () => {
    const fakeFetch = async () => ({ content: '', format: 'html' });
    const r = await recoverFromUrl('https://nystagereview.com/x', 'nysr', {
      fetchPage: fakeFetch,
      log: () => {},
    });
    assert.equal(r, null);
  });

  test('returns null when extractor finds nothing in non-rating HTML', async () => {
    const fakeFetch = async () => ({ content: '<html><body>no stars here</body></html>' });
    const r = await recoverFromUrl('https://nystagereview.com/x', 'nysr', {
      fetchPage: fakeFetch,
      log: () => {},
    });
    assert.equal(r, null);
  });

  test('returns null for missing url or outletId', async () => {
    assert.equal(await recoverFromUrl('', 'nysr'), null);
    assert.equal(await recoverFromUrl('https://x.com', ''), null);
  });
});
