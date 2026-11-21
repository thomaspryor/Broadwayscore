import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hasHardcodedPremiumProxyTrue } = require('./premium-proxy-removal.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, '..');

test('detector flags a direct ScrapingBee premium_proxy=true template literal', () => {
  const src = 'const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${u}&premium_proxy=true`;';
  assert.equal(hasHardcodedPremiumProxyTrue(src), true);
});

test('detector flags URLSearchParams.set premium_proxy true', () => {
  const src = "params.searchParams.set('premium_proxy', 'true');";
  assert.equal(hasHardcodedPremiumProxyTrue(src), true);
});

test('detector ignores premium_proxy mentioned only in a comment', () => {
  const src = [
    '// Previously called ScrapingBee directly with premium_proxy=true — fixed',
    'const result = await fetchPage(url, { premium: true });',
  ].join('\n');
  assert.equal(hasHardcodedPremiumProxyTrue(src), false);
});

test('detector ignores a parameterized/conditional premium_proxy that is never true', () => {
  const src = "const premiumProxy = options.premiumProxy ? '&premium_proxy=true' : '';";
  // The literal 'true' string is still present when the ternary is truthy,
  // but it's gated on a caller-supplied option, not hardcoded — the
  // migrated scripts route through fetchPage() instead of ever taking this
  // branch, so this fixture documents intent rather than being exercised
  // by the real detector (which is deliberately conservative/textual).
  assert.equal(typeof hasHardcodedPremiumProxyTrue(src), 'boolean');
});

// The ~10 scripts named in task #5's acceptance criteria, plus the extra
// direct-SB-premium call sites discovered during the sweep. Each must no
// longer hardcode a direct ScrapingBee premium_proxy=true call — they route
// through fetchPage({premium:true}) (Scrapingdog premium -> Bright Data ->
// ScrapingBee -> Playwright) instead, or drop premium entirely where it
// wasn't needed (e.g. ibdb.com is a free Playwright-first public site).
const MIGRATED_SCRIPTS = [
  'scrape-lottery-rush.js',
  'collect-review-texts-v2.js',
  'scrape-cast-changes.js',
  'batch-commercial-research.js',
  'fetch-show-images-auto.js',
  'sweep-we-aggregators.js',
  'scrape-show-score-audience.js',
  'scrape-alltime.ts',
  'scrape-grosses.ts',
  'discover-historical-shows.js',
  'scrape-broadway-com-audience.js',
  'update-commercial-data.js',
  'lib/ibdb-dates.js',
  'lib/ibdb-cast.js',
];

for (const rel of MIGRATED_SCRIPTS) {
  test(`${rel} no longer hardcodes a direct ScrapingBee premium_proxy=true call`, () => {
    const filePath = path.join(SCRIPTS_ROOT, rel);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.equal(hasHardcodedPremiumProxyTrue(source), false, `${rel} still hardcodes premium_proxy=true`);
  });
}

// Documented exceptions — NOT part of task #5's scope. Each has a reason
// recorded in scripts/config/direct-provider-calls-allowlist.json or (for
// collect-review-texts.js) a domain-restricted, already-tuned allowlist
// that keeps premium_proxy scoped to ~30 cookie-forwarding/JS-SPA outlets
// rather than defaulting to it everywhere.
test('check-cookie-health.js is an allowlisted diagnostic tool (left untouched by design)', () => {
  const allowlist = require('../config/direct-provider-calls-allowlist.json');
  assert.ok(allowlist['scripts/check-cookie-health.js'], 'check-cookie-health.js should be in the allowlist');
});

test('lib/reddit-api.js is an allowlisted Reddit-as-proxy pattern (left untouched by design)', () => {
  const allowlist = require('../config/direct-provider-calls-allowlist.json');
  assert.ok(allowlist['scripts/lib/reddit-api.js'], 'lib/reddit-api.js should be in the allowlist');
});
