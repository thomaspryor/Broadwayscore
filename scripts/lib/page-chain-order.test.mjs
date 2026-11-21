// Tests for pageChainOrder — the pure provider-ordering decision behind
// fetchPage's fallback chain (BRO-3009 S1-T7, mirrors serp-chain-order.test.mjs).
// Requires the REAL function per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pageChainOrder } = require('./scraper.js');

const BASE = {
  hasCookies: false,
  preferPlaywright: false,
  isBroadwayWorld: false,
  isPublicSite: false,
  skips: new Set(),
  useScrapingdog: true,
  hasBdToken: true,
  sbAllowed: true,
};

test('default flags: SD -> BD -> SB -> Playwright(last); no cookies, no playwright-first', () => {
  assert.deepEqual(pageChainOrder(BASE), ['scrapingdog', 'brightdata', 'scrapingbee', 'playwright-last']);
});

test('cookies present and not preferPlaywright: cookies-plain leads (real gate: cookieDomain && !preferPlaywright)', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, hasCookies: true }),
    ['cookies-plain', 'scrapingdog', 'brightdata', 'scrapingbee', 'playwright-last']
  );
});

test('cookies present but preferPlaywright true: cookies-plain is EXCLUDED (real code gates on !preferPlaywright)', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, hasCookies: true, preferPlaywright: true }),
    ['playwright-first', 'scrapingdog', 'brightdata', 'scrapingbee']
  );
});

test('preferPlaywright: playwright-first leads, no playwright-last (already tried)', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, preferPlaywright: true }),
    ['playwright-first', 'scrapingdog', 'brightdata', 'scrapingbee']
  );
});

test('isPublicSite: playwright-first leads, no playwright-last', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, isPublicSite: true }),
    ['playwright-first', 'scrapingdog', 'brightdata', 'scrapingbee']
  );
});

test('isBroadwayWorld: playwright-first leads, no playwright-last', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, isBroadwayWorld: true }),
    ['playwright-first', 'scrapingdog', 'brightdata', 'scrapingbee']
  );
});

test('domain-tier-skip on playwright: neither playwright-first nor playwright-last appear, even with preferPlaywright', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, preferPlaywright: true, skips: new Set(['playwright']) }),
    ['scrapingdog', 'brightdata', 'scrapingbee']
  );
});

test('domain-tier-skip on cookies-plain specifically: SD leads even with cookies present', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, hasCookies: true, skips: new Set(['cookies-plain']) }),
    ['scrapingdog', 'brightdata', 'scrapingbee', 'playwright-last']
  );
});

test('scrapingdog disabled (no key / budget exceeded / quota exceeded, pre-computed by caller): skips SD', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, useScrapingdog: false }),
    ['brightdata', 'scrapingbee', 'playwright-last']
  );
});

test('domain-tier-skip on scrapingdog: same effect as disabled', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, skips: new Set(['scrapingdog']) }),
    ['brightdata', 'scrapingbee', 'playwright-last']
  );
});

test('no Bright Data token: skips BD', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, hasBdToken: false }),
    ['scrapingdog', 'scrapingbee', 'playwright-last']
  );
});

test('SB not allowed (no key / credits low / budget exceeded / page exhausted, pre-computed by caller): skips SB', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, sbAllowed: false }),
    ['scrapingdog', 'brightdata', 'playwright-last']
  );
});

test('all three providers disabled: only playwright-last remains', () => {
  assert.deepEqual(
    pageChainOrder({ ...BASE, useScrapingdog: false, hasBdToken: false, sbAllowed: false }),
    ['playwright-last']
  );
});

test('all providers and playwright skipped: empty chain (fetchPage throws "All scraping methods failed")', () => {
  assert.deepEqual(
    pageChainOrder({
      ...BASE,
      useScrapingdog: false,
      hasBdToken: false,
      sbAllowed: false,
      skips: new Set(['playwright']),
    }),
    []
  );
});
