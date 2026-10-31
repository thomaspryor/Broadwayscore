/**
 * BRO-4525 soft launch: accounts, ratings, the watchlist and the redesigned
 * show page are live on every host, not only the demo subdomain.
 *
 * This is the card's acceptance check. It reads the real getters (CLAUDE.md
 * §15) and fails if either flag drifts back behind the demo gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLAGS_PATH = path.join(HERE, '../../src/config/feature-flags.ts');
const { featureFlags } = await import('../../src/config/feature-flags.ts');

test('userAccounts is on outside the demo host', () => {
  assert.equal(featureFlags.userAccounts, true);
});

test('showPageRedesign is on outside the demo host', () => {
  assert.equal(featureFlags.showPageRedesign, true);
});

test('neither launched flag is still listed in DEMO_FEATURES', () => {
  const src = readFileSync(FLAGS_PATH, 'utf8');
  const m = src.match(/const DEMO_FEATURES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'DEMO_FEATURES declaration not found; update this guard if it moved');
  assert.doesNotMatch(m[1], /'userAccounts'|'showPageRedesign'/);
});
