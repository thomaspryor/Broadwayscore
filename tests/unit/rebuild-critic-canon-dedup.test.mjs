/**
 * Regression test for the P0 bug ship-check caught after Session 3 shipped:
 *
 * My URL canonicalization fix (#12) collapses Rocky Horror's
 * /p/rocky-horror-show + ?triedRedirect=true into the same dedup key.
 * But the multi-critic-URL allow-through at rebuild-all-reviews.js:2892
 * lets files with DIFFERENT named critics through — so "David Cote" and
 * "David Finkle" at same URL at cote-notices BOTH survive.
 *
 * Fix: run critic canonicalization AT REBUILD TIME (not just gather time),
 * so existing review files written before the gather-side canon landed get
 * their critic name corrected BEFORE the dedup check runs.
 *
 * This test simulates the rebuild-all-reviews.js dedup path in-memory and
 * asserts that after canonicalization the duplicate is correctly caught.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { canonicalizeUrlForDedup } = require('../../scripts/lib/review-guards.js');
const { canonicalizeCritic } = require('../../scripts/lib/critic-canonicalization.js');

// Mirrors scripts/rebuild-all-reviews.js normalizeOutletCanonical + URL dedup logic.
function normalizeOutletCanonical(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Simulate rebuild-all-reviews.js per-show URL dedup path for the given set of
 * review-text-style objects. Returns { kept, deduped, allowedMultiCritic } arrays.
 * Assumes caller has already filtered out wrongProduction/duplicateOf files, as
 * rebuild does in an earlier pass.
 */
function simulateRebuildUrlDedup(reviewDatas) {
  const seenUrlsByOutlet = new Map();
  const kept = [];
  const deduped = [];
  const allowedMultiCritic = [];

  for (const orig of reviewDatas) {
    const d = { ...orig };
    const oid = normalizeOutletCanonical(d.outletId || d.outlet);
    // Apply critic canonicalization BEFORE dedup (the fix).
    if (d.criticName) {
      const canon = canonicalizeCritic(oid, d.criticName);
      if (canon.canonicalized) d.criticName = canon.name;
    }
    const normalizedUrl = canonicalizeUrlForDedup(d.url);
    const key = `${oid}|${normalizedUrl}`;
    const critic = (d.criticName || '').toLowerCase().trim();

    if (seenUrlsByOutlet.has(key)) {
      const winner = seenUrlsByOutlet.get(key);
      const bothNamed = critic && critic !== 'unknown' && winner.critic && winner.critic !== 'unknown';
      const different = bothNamed && critic !== winner.critic;
      if (different) allowedMultiCritic.push(d);
      else deduped.push(d);
    } else {
      seenUrlsByOutlet.set(key, { critic, criticName: d.criticName });
      kept.push(d);
    }
  }
  return { kept, deduped, allowedMultiCritic };
}

describe('rebuild-time dedup — Cote Notices Rocky Horror repro', () => {
  test('two files at cote-notices with same URL modulo ?triedRedirect + different critic names → DEDUPED', () => {
    const coteUrl = 'https://davidcote1.substack.com/p/the-rocky-horror-show-our-lust-is';
    const davidCoteFile = {
      outletId: 'cote-notices',
      criticName: 'David Cote',
      url: coteUrl,
    };
    const davidFinkleFile = {
      outletId: 'cote-notices',
      criticName: 'David Finkle', // wrong attribution from BWW RR
      url: coteUrl + '?triedRedirect=true',
    };
    const { kept, deduped, allowedMultiCritic } = simulateRebuildUrlDedup(
      [davidCoteFile, davidFinkleFile]
    );
    assert.strictEqual(kept.length, 1,
      'Exactly one file should survive dedup');
    assert.strictEqual(kept[0].criticName, 'David Cote');
    assert.strictEqual(deduped.length, 1,
      'The Finkle duplicate must be deduped (NOT allowed through multi-critic)');
    assert.strictEqual(allowedMultiCritic.length, 0,
      `The multi-critic-URL allow must NOT fire for cote-notices Finkle/Cote pair — ` +
      `that was the Rocky Horror 2026-04-23 bug. Got: ${JSON.stringify(allowedMultiCritic)}`);
  });

  test('legitimate multi-critic case (different critics at a real multi-critic outlet) still allowed through', () => {
    const nytUrl = 'https://nytimes.com/2026/04/01/theater/review-roundup.html';
    // Two real NYT critics at the same URL — legitimate multi-critic page
    const shaw = {
      outletId: 'nytimes',
      criticName: 'Helen Shaw',
      url: nytUrl,
    };
    const green = {
      outletId: 'nytimes',
      criticName: 'Jesse Green',
      url: nytUrl + '?utm_source=twitter', // tracking param on second — still same URL
    };
    const { kept, allowedMultiCritic } = simulateRebuildUrlDedup([shaw, green]);
    assert.strictEqual(kept.length, 1, 'first kept');
    assert.strictEqual(allowedMultiCritic.length, 1,
      'The multi-critic allow-through MUST still fire for legitimate multi-critic cases — ' +
      'we only want it suppressed when critic-canonicalization collapses the critic names');
    assert.strictEqual(allowedMultiCritic[0].criticName, 'Jesse Green');
  });
});
