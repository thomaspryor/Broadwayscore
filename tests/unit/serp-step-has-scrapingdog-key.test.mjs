// BRO-6867: every workflow step whose script reaches the shared SERP chain with
// the ScrapingBee key must also have the Scrapingdog key, or every search
// skips Scrapingdog (5 credits) for ScrapingBee (25). Logic lives in
// scripts/lib/serp-step-key-guard.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findAllSerpKeyGaps, findSerpKeyGaps } = require(path.join(ROOT, 'scripts/lib/serp-step-key-guard.js'));

test('every SERP-reaching workflow step with the ScrapingBee key also has the Scrapingdog key', () => {
  const gaps = findAllSerpKeyGaps(ROOT);
  assert.deepEqual(gaps, [], `Add SCRAPINGDOG_API_KEY: \${{ secrets.SCRAPINGDOG_API_KEY }} to:\n${gaps.join('\n')}`);
});

const wf = (env, run) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: s\n        env:\n${env.map((k) => `          ${k}: x`).join('\n')}\n        run: ${run}\n`;

test('flags SB-only steps for each SERP entry point, not SB+SD steps or non-SERP scripts', () => {
  // discoverOfficialUrl (via official-url-discovery), discoverCorrectUrl (Stagedoor), node and tsx forms
  for (const s of ['node scripts/ob-discovery-ticket-links.js', 'node scripts/scrape-stagedoor-critics.js', 'npx tsx scripts/ob-discovery-ticket-links.js']) {
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], s), 't.yml', ROOT).length, 1, s);
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY'], s), 't.yml', ROOT).length, 0, s);
  }
  assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], 'node scripts/check-sb-breaker.js'), 't.yml', ROOT).length, 0);
});
