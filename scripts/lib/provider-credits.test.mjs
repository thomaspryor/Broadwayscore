// Tests for provider-credits.js — the per-provider, per-mode credit table
// (BRO-3009 S1-T1). Requires the REAL function per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { creditsFor, assertFiniteCost } = require('./provider-credits.js');

test('scrapingdog credit table matches the live mode ternary in fetchWithScrapingdog (scraper.js)', () => {
  assert.equal(creditsFor('sd', 'page'), 1);
  assert.equal(creditsFor('sd', 'render'), 5);
  assert.equal(creditsFor('sd', 'premium'), 10);
  assert.equal(creditsFor('sd', 'stealth'), 10);
  assert.equal(creditsFor('sd', 'serp'), 5);
});

test('scrapingbee credit table matches fetchWithScrapingBee (scraper.js): page/render/premium', () => {
  assert.equal(creditsFor('sb', 'page'), 1);
  assert.equal(creditsFor('sb', 'render'), 5);
  assert.equal(creditsFor('sb', 'premium'), 10);
});

test('scrapingbee credit table matches collect-review-texts.js\'s proxyType: standard/premium_proxy/stealth_proxy', () => {
  assert.equal(creditsFor('sb', 'standard'), 1);
  assert.equal(creditsFor('sb', 'premium_proxy'), 10);
  assert.equal(creditsFor('sb', 'stealth_proxy'), 75);
});

test('scrapingbee credit table matches url-discovery.js SERP calls', () => {
  assert.equal(creditsFor('sb', 'serp'), 25);
  assert.equal(creditsFor('sb', 'serp-news'), 25);
  assert.equal(creditsFor('sb', 'serp-images'), 25);
});

test('an unknown mode throws instead of returning undefined', () => {
  assert.throws(() => creditsFor('sb', 'dynamic'));
  assert.throws(() => creditsFor('sd', 'unknown_mode'));
});

test('an unknown provider throws (including the full provider name, not the short code)', () => {
  assert.throws(() => creditsFor('scrapingbee', 'standard'));
  assert.throws(() => creditsFor('browserbase', 'plain'));
});

test('assertFiniteCost passes finite numbers through unchanged, including zero', () => {
  assert.equal(assertFiniteCost(5, 'test'), 5);
  assert.equal(assertFiniteCost(0, 'test'), 0);
});

test('assertFiniteCost throws on NaN/undefined/Infinity — the exact "NaN > budget is false" hazard', () => {
  assert.throws(() => assertFiniteCost(NaN, 'test'));
  assert.throws(() => assertFiniteCost(undefined, 'test'));
  assert.throws(() => assertFiniteCost(Infinity, 'test'));
});

test('assertFiniteCost throws on negative numbers — a running total could silently shrink below real spend', () => {
  assert.throws(() => assertFiniteCost(-1, 'test'));
  assert.equal(assertFiniteCost(-0, 'test'), -0);
});
