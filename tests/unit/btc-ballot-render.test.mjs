/**
 * Beat the Critics — results ballot pick row markup guard
 *
 * BRO-1299: the E2E results-ballot test asserted on a brittle structural CSS
 * selector (.flex.items-center.justify-between.py-1.5) that broke when the
 * compact-ballot redesign (656ad41493) changed the markup. This guards the
 * stable data-testid instead so future restyles don't silently break the E2E
 * selector again.
 *
 * Run: node --test tests/unit/btc-ballot-render.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CLIENT_PATH = join(ROOT, 'src/app/beat-the-critics/BeatTheCriticsClient.tsx');

test('results ballot pick row renders with data-testid="ballot-pick-row"', () => {
  const content = readFileSync(CLIENT_PATH, 'utf8');

  assert.ok(
    content.includes('data-testid="ballot-pick-row"'),
    'BeatTheCriticsClient.tsx must render the results ballot pick row with data-testid="ballot-pick-row" ' +
    '(tests/e2e/beat-the-critics.spec.ts asserts on this testid, not on structural CSS classes)'
  );

  // The testid must sit on the same element as the per-category pick row map,
  // not on an unrelated container — keep it anchored to the tierPicks.map() line.
  const pickRowLineMatch = content.match(/tierPicks\.map\(cat => \(<div key=\{cat\.title\}[^>]*>/);
  assert.ok(pickRowLineMatch, 'Expected to find the tierPicks.map pick-row element');
  assert.ok(
    pickRowLineMatch[0].includes('data-testid="ballot-pick-row"'),
    'data-testid="ballot-pick-row" must be on the per-category pick row element itself'
  );
});
