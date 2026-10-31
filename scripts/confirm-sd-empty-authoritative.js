#!/usr/bin/env node
/**
 * confirm-sd-empty-authoritative.js — live confirmation probe for task #213.
 *
 * Verifies the empty-authoritative fix in url-discovery.js's _serpWithChain:
 * a Scrapingdog SERP call that SUCCEEDS with 0 organic results should be
 * accepted (provider: 'scrapingdog-empty') by default, but must still fall
 * through to BD/SB when emptyAuthoritative:false (the opening-night-poller.js
 * flow, where empty can mean "not published yet" rather than a genuine zero).
 * Log analysis (2026-07-19/20, 10 CI runs) showed 88% of BD SERP calls were
 * preceded by exactly the case this fix now short-circuits.
 *
 * NOTE: this is NOT preferSpeed — a codebase-review pass found
 * opening-night-poller.js calls with preferSpeed:false, so the exemption is
 * wired as its own explicit option (see shouldAcceptEmptyScrapingdogSerp).
 *
 * Dispatched via scrapingdog-account-usage.yml (mode=confirm-empty-authoritative)
 * since SCRAPINGDOG_API_KEY only exists as a CI secret. Cost: ~5-8 SD SERP
 * calls (~5cr each) plus whatever BD/SB calls the (expected) fallback cases
 * make — well under the plan's 20-50 live-probe budget.
 */

process.env.SCRAPER_USE_SCRAPINGDOG = '1';

const { serpQuery } = require('./lib/url-discovery');

// A query near-guaranteed to have 0 organic Google results — the empty-
// authoritative candidate. A generic query near-guaranteed to have results —
// the non-empty control. Both run under default (emptyAuthoritative=true) and
// opted-out (emptyAuthoritative=false, opening-night-poller.js's mode).
const NONSENSE_QUERY = 'zzqxvbroadwayscorecardnonexistentquerystring987654321';
const CONTROL_QUERY = 'broadway theater reviews';

async function run() {
  const results = [];

  for (const emptyAuthoritative of [true, false]) {
    for (const [label, query] of [['empty-candidate', NONSENSE_QUERY], ['control-nonempty', CONTROL_QUERY]]) {
      const { results: hits, provider } = await serpQuery(query, { emptyAuthoritative });
      results.push({ emptyAuthoritative, label, provider, hitCount: Array.isArray(hits) ? hits.length : null });
    }
  }

  console.log(JSON.stringify(results, null, 2));

  const empty_default = results.find(r => r.emptyAuthoritative && r.label === 'empty-candidate');
  const empty_optedOut = results.find(r => !r.emptyAuthoritative && r.label === 'empty-candidate');
  const control_default = results.find(r => r.emptyAuthoritative && r.label === 'control-nonempty');

  const checks = [
    { name: 'default (emptyAuthoritative=true): empty query accepted as scrapingdog-empty (no BD/SB)', pass: empty_default?.provider === 'scrapingdog-empty' },
    { name: 'emptyAuthoritative=false: empty query does NOT stop at scrapingdog-empty', pass: empty_optedOut?.provider !== 'scrapingdog-empty' },
    { name: 'default: control query returns real hits via scrapingdog', pass: control_default?.provider === 'scrapingdog' && control_default?.hitCount > 0 },
  ];

  console.log('\n--- Verdict ---');
  let allPass = true;
  for (const c of checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name}`);
    if (!c.pass) allPass = false;
  }
  if (!allPass) process.exit(1);
}

run().catch(err => { console.error('confirm probe crashed:', err.message); process.exit(1); });
