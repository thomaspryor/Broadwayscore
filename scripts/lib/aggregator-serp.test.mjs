// BRO-764: guard for per-show aggregator SERP spend. The audit lives in docs/aggregator-serp-cost-audit.md.
// Every scrape script that issues a per-show SERP must be listed here with the mechanism that bounds it, so a
// new aggregator scraper cannot add an unbounded per-show search without someone writing down why it is safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isClosedShowEligibleForBatchDiscovery, REGIONAL_RETRY_WINDOW_DAYS } = require('./discovery-eligibility.js');

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const DAY = 86400000;
const NOW = Date.parse('2026-10-06T00:00:00Z');

// bound: how the script's per-show SERP volume is capped.
//   batch-gate      closed shows (bar a 90-day regional window) are dropped from batch runs (discovery-eligibility.js)
//   targeted-only   SERP runs only for shows named with --shows, never in a batch sweep
//   mode            the sweep takes an explicit --mode and refuses the unbounded mode in CI
//   window          the candidate set is bounded by an age window in the script itself
//   per-query       a fixed handful of queries per run, not per show
const INVENTORY = {
  'scrape-bww-reviews.js': { bound: 'batch-gate' },
  'scrape-playbill-verdict.js': { bound: 'batch-gate' },
  'scrape-nyc-theatre-roundups.js': { bound: 'batch-gate' },
  'scrape-london-box-office-roundups.js': { bound: 'targeted-only' },
  'scrape-recoupment-announcements.js': { bound: 'window' },
  'scrape-stagedoor-critics.js': { bound: 'mode' },
  'sweep-we-aggregators.js': { bound: 'mode' },
  'scrape-off-broadway-alliance.js': { bound: 'per-query' },
  'scrape-cast-changes.js': { bound: 'window' },
};

const read = (f) => fs.readFileSync(path.join(SCRIPTS, f), 'utf8');

test('every scrape script that issues a SERP is in the audit inventory', () => {
  const found = fs.readdirSync(SCRIPTS)
    .filter((f) => /^(scrape-|sweep-).*\.js$/.test(f))
    .filter((f) => /\b(serpQuery|discoverCorrectUrl)\(/.test(read(f)));
  const missing = found.filter((f) => !INVENTORY[f]);
  assert.deepEqual(missing, [], `new per-show SERP script(s) not in the BRO-764 inventory: add each to INVENTORY here and to docs/aggregator-serp-cost-audit.md with how its volume is bounded`);
  const stale = Object.keys(INVENTORY).filter((f) => !found.includes(f));
  assert.deepEqual(stale, [], 'inventory lists a script that no longer issues SERP queries; remove it');
});

test('every batch-gate scraper really applies the closed-show gate in its batch filter', () => {
  for (const [file, { bound }] of Object.entries(INVENTORY)) {
    if (bound !== 'batch-gate') continue;
    const src = read(file);
    assert.match(src, /require\('\.\/lib\/discovery-eligibility'\)/, `${file} imports the gate`);
    const uses = src.match(/isClosedShowEligibleForBatchDiscovery\(/g) || [];
    assert.ok(uses.length >= 1, `${file} calls isClosedShowEligibleForBatchDiscovery in its batch filter`);
  }
});

test('targeted-only SERP stays behind the --shows flag', () => {
  const src = read('scrape-london-box-office-roundups.js');
  const at = src.indexOf('await serpQuery(');
  assert.ok(at > 0);
  assert.match(src.slice(Math.max(0, at - 1500), at), /if \(targetShowIds && SCRAPINGBEE_KEY\)/, 'the LBO SERP loop is inside the targeted-mode branch');
});

test('batch gate: closed shows never qualify, except regional shows inside the post-close window', () => {
  const closedAgo = (days, category) => ({ status: 'closed', category, closingDate: new Date(NOW - days * DAY).toISOString().slice(0, 10) });
  assert.equal(isClosedShowEligibleForBatchDiscovery(closedAgo(1, 'broadway'), NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery(closedAgo(400, 'off-broadway'), NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery(closedAgo(30, 'west-end'), NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery(closedAgo(REGIONAL_RETRY_WINDOW_DAYS - 1, 'regional'), NOW), true);
  assert.equal(isClosedShowEligibleForBatchDiscovery(closedAgo(REGIONAL_RETRY_WINDOW_DAYS + 1, 'regional'), NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional' }, NOW), true, 'regional with no closing date gets one shot');
  for (const status of ['open', 'upcoming', 'previews']) assert.equal(isClosedShowEligibleForBatchDiscovery({ status, category: 'broadway' }, NOW), true);
});

test('the gate is stricter than the 180-day rule the card proposed: no closed non-regional show is ever batch-searched', () => {
  const old = { status: 'closed', category: 'broadway', closingDate: new Date(NOW - 181 * DAY).toISOString().slice(0, 10) };
  const recent = { ...old, closingDate: new Date(NOW - 2 * DAY).toISOString().slice(0, 10) };
  assert.equal(isClosedShowEligibleForBatchDiscovery(old, NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery(recent, NOW), false);
});
