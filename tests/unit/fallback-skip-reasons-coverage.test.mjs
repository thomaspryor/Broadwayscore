// Every skip label scraper.js passes to onSkip() must be in fallback-attribution's
// SKIP_REASONS. A label missing from the set makes fallbackFromLabel() throw inside
// fetchPage(), so the page fetch fails outright (BRO-6872: 'sb-host-cooldown' was
// emitted but never registered, which broke opening-night lane fetches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { SKIP_REASONS, fallbackFromLabel } = require(path.join(root, 'scripts/lib/fallback-attribution.js'));

test('every onSkip() label in scraper.js is a registered SKIP_REASON', () => {
  const src = readFileSync(path.join(root, 'scripts/lib/scraper.js'), 'utf8');
  const labels = [...src.matchAll(/onSkip\(\s*['"]([a-z0-9-]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(labels.length >= 5, `expected onSkip() calls in scraper.js, found ${labels.length}`);
  const missing = [...new Set(labels)].filter((l) => !SKIP_REASONS.has(l));
  assert.deepEqual(missing, [], `onSkip labels missing from SKIP_REASONS: ${missing.join(', ')}`);
  for (const l of labels) assert.equal(fallbackFromLabel('brightdata', { skipReason: l }), l);
});

test('sb-host-cooldown no longer throws', () => {
  assert.equal(fallbackFromLabel('scrapingbee', { skipReason: 'sb-host-cooldown' }), 'sb-host-cooldown');
});
