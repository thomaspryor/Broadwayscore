/**
 * Regression test for the fingerprint swap-to-default-critic behavior in
 * scripts/rebuild-all-reviews.js.
 *
 * Scenario: a single-author outlet (has outlet.defaultCritic) ends up with
 * two review files for the same article:
 *   File A (first-written): criticName="Guest Blogger"    text="X..."
 *   File B (second-written): criticName="<defaultCritic>" text="X..."   (same text)
 *
 * Session 3 URL-dedup + static CRITIC_CANONICAL_MAP don't catch this when
 * URLs differ (cross-aggregator case) and the wrong name isn't in the map.
 * Current fingerprint dedup would KEEP file A (wrong critic) and drop file B.
 *
 * Fix: when the OUTLET has defaultCritic and file B's critic matches it while
 * A's doesn't, SWAP — keep B (correct critic), drop A.
 *
 * The swap logic is inline in rebuild-all-reviews.js around the
 * `seenFingerprintsByOutlet` block. We mirror it here to avoid coupling the
 * test to the rebuild loop entry point. If rebuild's logic diverges from the
 * simulation, we have a follow-up card to extract dedup-predicates.js
 * (34c637c5-416f-81b1-b245-e9bfbaeb25ae).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeCritic: normalizeCriticCanonical } = require('../../scripts/lib/review-normalization.js');

function simulateFingerprintDedupWithSwap(files, outletRegistry) {
  const seen = new Map();
  const kept = [];
  const dropped = [];
  const swapped = [];

  for (const f of files) {
    const key = `${f.outletId}|${f.fingerprint}`;
    const outletEntry = outletRegistry[f.outletId];
    const defaultCritic = outletEntry && outletEntry.defaultCritic;
    const defaultCriticKey = defaultCritic ? normalizeCriticCanonical(defaultCritic) : null;
    const incomingCriticKey = normalizeCriticCanonical(f.criticName || 'unknown');

    if (seen.has(key)) {
      const winner = seen.get(key);
      if (
        defaultCriticKey &&
        incomingCriticKey === defaultCriticKey &&
        winner.criticKey &&
        winner.criticKey !== defaultCriticKey
      ) {
        // SWAP
        swapped.push({ dropped: winner.file, kept: f.file });
        dropped.push(winner.file);
        kept.splice(kept.indexOf(winner.file), 1);
        kept.push(f.file);
        seen.set(key, { file: f.file, criticKey: incomingCriticKey });
      } else {
        dropped.push(f.file);
      }
    } else {
      seen.set(key, { file: f.file, criticKey: incomingCriticKey });
      kept.push(f.file);
    }
  }
  return { kept, dropped, swapped };
}

describe('fingerprint swap-to-default-critic', () => {
  const registry = {
    'cote-notices': { defaultCritic: 'David Cote' },
    'nytimes': {}, // multi-critic — no defaultCritic
  };

  test('single-author outlet: swap when incoming critic matches defaultCritic', () => {
    const files = [
      { file: 'cote-notices--guest-blogger.json', outletId: 'cote-notices', criticName: 'Guest Blogger', fingerprint: 'abc123' },
      { file: 'cote-notices--david-cote.json', outletId: 'cote-notices', criticName: 'David Cote', fingerprint: 'abc123' },
    ];
    const r = simulateFingerprintDedupWithSwap(files, registry);
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(r.kept[0], 'cote-notices--david-cote.json',
      'Swap must keep the correctly-attributed file');
    assert.strictEqual(r.dropped[0], 'cote-notices--guest-blogger.json');
    assert.strictEqual(r.swapped.length, 1);
  });

  test('single-author outlet: NO swap when incoming critic is also wrong', () => {
    const files = [
      { file: 'cote-notices--jane-doe.json', outletId: 'cote-notices', criticName: 'Jane Doe', fingerprint: 'abc123' },
      { file: 'cote-notices--john-smith.json', outletId: 'cote-notices', criticName: 'John Smith', fingerprint: 'abc123' },
    ];
    const r = simulateFingerprintDedupWithSwap(files, registry);
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(r.kept[0], 'cote-notices--jane-doe.json',
      'Neither matches defaultCritic — keep first-in (existing behavior)');
    assert.strictEqual(r.swapped.length, 0);
  });

  test('single-author outlet: NO swap when winner is already correct', () => {
    const files = [
      { file: 'cote-notices--david-cote.json', outletId: 'cote-notices', criticName: 'David Cote', fingerprint: 'abc123' },
      { file: 'cote-notices--guest-blogger.json', outletId: 'cote-notices', criticName: 'Guest Blogger', fingerprint: 'abc123' },
    ];
    const r = simulateFingerprintDedupWithSwap(files, registry);
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(r.kept[0], 'cote-notices--david-cote.json');
    assert.strictEqual(r.swapped.length, 0,
      'Winner was already correct — no swap needed');
  });

  test('multi-critic outlet: NO swap (existing behavior preserved)', () => {
    const files = [
      { file: 'nytimes--ben-brantley.json', outletId: 'nytimes', criticName: 'Ben Brantley', fingerprint: 'xyz789' },
      { file: 'nytimes--charles-isherwood.json', outletId: 'nytimes', criticName: 'Charles Isherwood', fingerprint: 'xyz789' },
    ];
    const r = simulateFingerprintDedupWithSwap(files, registry);
    // Without defaultCritic, first-in wins per current fingerprint dedup.
    assert.strictEqual(r.kept[0], 'nytimes--ben-brantley.json');
    assert.strictEqual(r.swapped.length, 0,
      'Multi-critic outlet has no defaultCritic — swap logic must not fire');
  });

  test('single-author outlet: three files, first+second wrong, third correct → correct one wins', () => {
    const files = [
      { file: 'cote-notices--first.json', outletId: 'cote-notices', criticName: 'First Wrong', fingerprint: 'abc123' },
      { file: 'cote-notices--second.json', outletId: 'cote-notices', criticName: 'Second Wrong', fingerprint: 'abc123' },
      { file: 'cote-notices--david-cote.json', outletId: 'cote-notices', criticName: 'David Cote', fingerprint: 'abc123' },
    ];
    const r = simulateFingerprintDedupWithSwap(files, registry);
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(r.kept[0], 'cote-notices--david-cote.json');
    // second.json was dropped as a normal fingerprint dup (no swap — both wrong)
    // third.json caused the swap: first.json was dropped as swap-loser
    assert.strictEqual(r.swapped.length, 1);
    assert.strictEqual(r.swapped[0].kept, 'cote-notices--david-cote.json');
  });
});
