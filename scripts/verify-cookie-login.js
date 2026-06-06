#!/usr/bin/env node
/**
 * verify-cookie-login.js — Prove our subscription/paywalled cookies actually
 * pull FULL review text, not just a logged-out teaser.
 *
 * Why this exists (2026-05-29): cookie-health checks only validated cookie
 * presence + client-side expiry dates. A subscription session can rotate/die
 * server-side while the cookie's expiry is still months out — the cookie looks
 * "healthy" but every fetch returns a paywall/registration wall. The Stage went
 * silently logged-out for ~11 days (cookie-health reported "Auth OK 338.4d")
 * and Variety reviews were truncated by an extractor regression — both invisible
 * to expiry-date checks.
 *
 * The reliable signal is end-to-end: fetch a real review and measure the
 * EXTRACTED BODY length. A live session + working extractor yields thousands of
 * chars; a dead session (paywall) or broken extractor yields a few hundred.
 * This one probe catches BOTH failure modes regardless of root cause.
 *
 * Runs the production fetch path (scripts/lib/scraper fetchPage) + the real
 * article extractor, so it mirrors what gather/collect actually get. Intended to
 * run LOCALLY right after `extract-safari-cookies.py` (residential IP, free) so
 * the user sees immediately which outlets are logged in. Exit 1 if any target is
 * below its threshold so it's usable as a gate.
 *
 * Usage:
 *   node scripts/verify-cookie-login.js                 # all targets
 *   node scripts/verify-cookie-login.js --outlet=thestage,variety
 *   node scripts/verify-cookie-login.js --json          # machine-readable
 */

'use strict';

const { fetchPage } = require('./lib/scraper');
const { extractArticleTextFromUrl } = require('./lib/article-extractor');

// Stable review URLs per subscription/paywalled outlet. minBody is the floor
// below which we treat the result as a paywall/extractor failure — real theater
// reviews run 1500+ chars; teasers/walls return a few hundred.
const TARGETS = [
  { outlet: 'nytimes',   url: 'https://www.nytimes.com/2026/04/22/theater/beaches-review-broadway.html', minBody: 1500 },
  { outlet: 'variety',   url: 'https://variety.com/2026/legit/reviews/rocky-horror-show-broadway-review-revival-lacks-shock-fun-luke-evans-1236728429/', minBody: 1500 },
  { outlet: 'thestage',  url: 'https://www.thestage.co.uk/reviews/a-dolls-house-review-at-the-hudson-theatre-new-york-starring-jessica-chastain', minBody: 1200 },
  { outlet: 'wsj',       url: 'https://www.wsj.com/articles/gypsy-review-audra-mcdonalds-turn-on-broadway-ff528df3', minBody: 1500 },
  { outlet: 'newyorker', url: 'https://www.newyorker.com/magazine/2023/03/20/dolls-house-review-broadway-jessica-chastain', minBody: 1500 },
  { outlet: 'wapo',      url: 'https://www.washingtonpost.com/entertainment/theater/2025/04/10/boop-smash-broadway-review/', minBody: 1500 },
  { outlet: 'ft',        url: 'https://www.ft.com/content/681beb68-5155-11df-bed9-00144feab49a', minBody: 1200 },
  // The Times has DataDome-style device verification that challenges plain-HTTPS
  // fetches even with valid cookies; body extraction is unreliable. Probe the
  // homepage and check for the logged-in marker instead.
  { outlet: 'thetimes',  url: 'https://www.thetimes.com/', loggedInMarker: /my\s*account|sign\s*out/i },
];

function getArg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}
const JSON_OUT = process.argv.includes('--json');
const onlyOutlets = (getArg('outlet') || '').split(',').map((s) => s.trim()).filter(Boolean);

async function probe(t) {
  let body = '';
  let htmlLen = 0;
  let html = '';
  let error = null;
  try {
    const r = await fetchPage(t.url, { source: 'verify-cookie-login' });
    html = (r && (r.content || r.html || r.body)) || (typeof r === 'string' ? r : '');
    htmlLen = html.length;
    if (!t.loggedInMarker) body = extractArticleTextFromUrl(html, t.url) || '';
  } catch (e) {
    error = e.message;
  }
  let ok, detail;
  if (t.loggedInMarker) {
    // Marker mode: outlets with anti-bot challenges where body extraction is
    // unreliable. Trust the logged-in marker (e.g. "my account") in the HTML.
    ok = !error && t.loggedInMarker.test(html);
    detail = `marker ${ok ? 'present' : 'absent'} (html ${htmlLen})`;
  } else {
    ok = !error && body.length >= t.minBody;
    detail = `body ${body.length} / need ${t.minBody}`;
  }
  return { outlet: t.outlet, ok, detail, error, url: t.url };
}

(async () => {
  const targets = TARGETS.filter((t) => onlyOutlets.length === 0 || onlyOutlets.includes(t.outlet));
  const results = [];
  for (const t of targets) {
    results.push(await probe(t));
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\n=== Cookie login verification (extracted body length) ===\n');
    for (const r of results) {
      const mark = r.error ? '⚠️  ERROR     ' : r.ok ? '✅ logged-in  ' : '❌ LOGGED-OUT ';
      console.log(`${mark} ${r.outlet.padEnd(11)} ${r.error || r.detail}`);
    }
    const bad = results.filter((r) => !r.ok);
    console.log('');
    if (bad.length) {
      console.log(`❌ ${bad.length} outlet(s) not returning full text: ${bad.map((r) => r.outlet).join(', ')}`);
      console.log('   → Log into those sites in Safari, then re-run:');
      console.log('     python3 scripts/extract-safari-cookies.py --push');
    } else {
      console.log('✅ All probed outlets return full review text.');
    }
  }

  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => {
  console.error('verify-cookie-login failed:', e.stack || e.message);
  process.exit(1);
});
