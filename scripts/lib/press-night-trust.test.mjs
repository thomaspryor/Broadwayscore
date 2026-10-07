// Colocated tests for the pre-open press-night trust whitelist used by the
// opening-night orchestrator selector. Runs in the scripts/lib/*.test.mjs
// glob batch in test.yml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTrustedPressNightSource } = require('./press-night-trust.js');

test('trusts the original orchestrator whitelist (no regression)', () => {
  for (const src of ['theatremonkey', 'playbill', 'ibdb', 'manual']) {
    assert.equal(isTrustedPressNightSource(src), true, src);
  }
});

test('trusts press-night-grade sources the inline set had drifted away from', () => {
  for (const src of [
    'playbill-production-page',
    'inferred-from-reviews',
    'review-derived-press-night',
    'press-release',
    'press-night-correction-2026-06-29',
    'manual:stuart-king-email-2026-04-27 (production opened October 2017)',
    'manual-original-run',
    'manual-press-opening-reviews-landed',
  ]) {
    assert.equal(isTrustedPressNightSource(src), true, src);
  }
});

test('never trusts preview-date-risk sources (KENREX class / ship-check blocker)', () => {
  for (const src of [
    'todaytix',
    'showscore',
    'review-open-signal',
    'estimated:southwark-playhouse-page+stuart-king-2026-04-03-review',
    'unknown',
    'first-performance-no-press-night',
  ]) {
    assert.equal(isTrustedPressNightSource(src), false, src);
  }
});

test('never trusts freeform descriptive strings or missing sources', () => {
  for (const src of [
    'press night per londontheatre.co.uk show page + review cluster',
    'kenrextheplay.com,playbill',
    'menierchocolatefactory.com',
    'bww-listing',
    'aggregator-roundup',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isTrustedPressNightSource(src), false, String(src));
  }
});

test('whitelist default: an unknown new source string is untrusted', () => {
  assert.equal(isTrustedPressNightSource('some-future-scraper'), false);
});
