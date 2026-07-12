/**
 * resolveArchiveRowOutletId — outlet identity for aggregator-archive cache rows.
 *
 * Card 39b637c5-416f-81bb: caches store scrape-era outletIds; collision-era rows
 * carry sunday-telegraph for telegraph.co.uk URLs and re-ingest reproduces the
 * stale mapping. The URL overrides ONLY when the fallback ID claims the URL's
 * domain (stale URL-derived ID) or isn't registered at all — blind URL-first
 * would mis-home WET star rows (whose `url` is the roundup page itself) and
 * Observer week-in-theatre columns published on theguardian.com.
 *
 * Uses the real outlet-registry.json (stable outlets only: telegraph,
 * sunday-telegraph, observer, timeout, timeout-london, daily-mail, express-uk).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { resolveArchiveRowOutletId } = require(resolve(ROOT, 'scripts/lib/archive-outlet-identity.js'));
const { readFileSync } = await import('node:fs');

describe('resolveArchiveRowOutletId', () => {
  test('stale collision-era ID: sunday-telegraph + telegraph.co.uk URL resolves to telegraph', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.telegraph.co.uk/theatre/what-to-see/kill-mockingbird-review/',
      outletLabel: 'The Telegraph',
      cachedOutletId: 'sunday-telegraph',
      sourceOutletId: 'westendtheatre',
    }), 'telegraph');
  });

  test('roundup-page URL never overrides the label (WET star rows)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.westendtheatre.com/339763/news/reviews/shadowlands-reviews/',
      outletLabel: 'Daily Mail',
      cachedOutletId: 'daily-mail',
      sourceOutletId: 'westendtheatre',
    }), 'daily-mail');
  });

  test('registered outlet keeps its ID when URL points at a foreign domain (Observer on theguardian.com)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.theguardian.com/stage/2025/jan/19/the-week-in-theatre-oliver-review',
      outletLabel: 'Observer',
      cachedOutletId: 'observer',
      sourceOutletId: 'westendtheatre',
    }), 'observer');
  });

  test('timeout path-split: /london URL flips timeout to timeout-london', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.timeout.com/london/theatre/the-crucible-4-review',
      outletLabel: 'Time Out',
      cachedOutletId: 'timeout',
      sourceOutletId: 'westendtheatre',
    }), 'timeout-london');
  });

  test('junk/alias cached ID with a resolvable URL canonicalizes (the-express → express-uk)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.express.co.uk/entertainment/theatre/2073053/disney-hercules-musical-london-review',
      outletLabel: 'The Express',
      cachedOutletId: 'the-express',
      sourceOutletId: 'westendtheatre',
    }), 'express-uk');
  });

  test('URL-less row keeps the cached ID (genuine Sunday print reviews)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: '',
      outletLabel: 'Sunday Telegraph',
      cachedOutletId: 'sunday-telegraph',
    }), 'sunday-telegraph');
  });

  test('no cached ID falls back to normalized label', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: '',
      outletLabel: 'The Telegraph',
    }), 'telegraph');
  });

  test('malformed URL falls back to cached ID', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'not a url',
      outletLabel: 'The Telegraph',
      cachedOutletId: 'telegraph',
    }), 'telegraph');
  });
});

describe('WE-aggregator ingestion wiring', () => {
  // Every path that turns an aggregator row into a review identity must go
  // through resolveArchiveRowOutletId. The poller and sweep writers ingest the
  // SAME rows as gather-reviews — a raw `X.outletId || normalizeOutlet(...)`
  // there re-introduces the divergence (ship-check P1, 2026-07-12).
  const WIRED = [
    { file: 'scripts/gather-reviews.js', minCalls: 4, label: 'LBO, WET, TR, TS cache blocks' },
    { file: 'scripts/opening-night-poller.js', minCalls: 4, label: 'poller LBO, WET, TR, TS blocks' },
    { file: 'scripts/scrape-theatre-reviews.js', minCalls: 1, label: 'TR sweep writer' },
    { file: 'scripts/scrape-thestage-roundups.js', minCalls: 1, label: 'TS sweep writer' },
  ];
  for (const w of WIRED) {
    test(`${w.file} routes ${w.label} through resolveArchiveRowOutletId`, () => {
      const contents = readFileSync(resolve(ROOT, w.file), 'utf8');
      assert.match(contents, /require\(['"]\.\/lib\/archive-outlet-identity['"]\)/,
        `${w.file} must import resolveArchiveRowOutletId — removing the wire re-introduces stale/divergent outletIds (card 39b637c5-416f-81bb)`);
      const calls = contents.match(/resolveArchiveRowOutletId\s*\(/g) || [];
      assert.ok(calls.length >= w.minCalls,
        `expected ≥${w.minCalls} resolveArchiveRowOutletId call sites (${w.label}), found ${calls.length}`);
      assert.ok(!/outletId\s*[:=]\s*(?:r|review|lboReview)\.outletId\s*\|\|/.test(contents),
        `${w.file} has a row-ingest site trusting .outletId directly — route it through resolveArchiveRowOutletId`);
    });
  }
});
