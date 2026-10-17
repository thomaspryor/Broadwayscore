#!/usr/bin/env node
/**
 * S1-T1 (Scraping cost v3, card 3b1637c5): live Scrapingdog parity test for
 * didtheylikeit.com and theatre.reviews — the two hosts opening-night-poller
 * pays for twice (SD attempt, then a Bright Data unlocker call on the SD
 * failure) per the 2026-08-03 cost investigation. Decides whether
 * domain-tier-skip.json should skip:true these hosts for scrapingdog.
 *
 * URL sampling mirrors the poller's real traffic mix, not just known-good
 * archive URLs:
 *   - didtheylikeit.com: real /shows/{slug}/ URLs pulled from
 *     data/aggregator-summary.json (confirmed DTLI review pages).
 *   - theatre.reviews: only 9 confirmed roundup URLs exist corpus-wide (TR
 *     publishes far fewer roundups than shows we poll), so the sample is
 *     padded with bounded-construction candidates using the SAME slug
 *     algorithm as scripts/lib/tr-roundup-discover.js against a spread of
 *     WE/OWE show titles — this reproduces the poller's real 404-heavy guess
 *     traffic, not an inflated success rate from cherry-picked hits.
 *
 * Fetch shape per URL: fetchWithScrapingdog() plain tier (current prod
 * params), then — only on failure — once more with stealthMode:true (the
 * heavier anti-bot bypass tier SD's own 400 body recommends for WAF hosts).
 * A Bright Data control fetch runs alongside so the report also shows what a
 * skip:true flip would fall through to.
 *
 * Usage: node scripts/sd-parity-test.js [--limit=30]
 * Requires SCRAPINGDOG_API_KEY (+ BRIGHTDATA_TOKEN for the control column).
 */

const fs = require('fs');
const path = require('path');
const { fetchWithScrapingdog, fetchWithBrightData, verifyFetchedUrl } = require('./lib/scraper');
const { foldDiacritics } = require('./lib/title-match');

const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '30', 10);
const HOST_FILTER = (process.argv.find((a) => a.startsWith('--host=')) || '').split('=')[1] || null;
const OUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'sd-parity-2026-08.json');

function classify(result, url) {
  if (!result) return { ok: false, reason: 'no_response' };
  const html = result.content || '';
  if (html.length < 1000) return { ok: false, reason: 'too_short' };
  const v = verifyFetchedUrl(html, url);
  if (!v.verified) return { ok: false, reason: v.reason || 'wrong_page' };
  return { ok: true };
}

function trSlug(title) {
  return foldDiacritics(title).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function collectDtliUrls(limit) {
  const summaryPath = path.join(__dirname, '..', 'data', 'aggregator-summary.json');
  const raw = fs.readFileSync(summaryPath, 'utf8');
  const matches = raw.match(/https:\/\/didtheylikeit\.com\/shows\/[a-z0-9-]+\/?/g) || [];
  const unique = [...new Set(matches)];
  // Deterministic spread rather than the first N (which cluster by insertion order).
  const step = Math.max(1, Math.floor(unique.length / limit));
  const sample = [];
  for (let i = 0; i < unique.length && sample.length < limit; i += step) sample.push(unique[i]);
  return sample;
}

function collectTrUrls(limit) {
  const dataDir = path.join(__dirname, '..', 'data');
  const confirmed = new Set();
  for (const file of ['aggregator-summary.json', 'show-score.json', 'text-coverage-report.json']) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, file), 'utf8');
      (raw.match(/https:\/\/theatre\.reviews\/reviews-roundup\/[a-z0-9-]+\/?/g) || []).forEach((u) => confirmed.add(u));
    } catch { /* file may not exist */ }
  }
  const urls = [...confirmed];
  if (urls.length >= limit) return urls.slice(0, limit);

  // Pad with bounded-construction candidates (real poller behavior) from a
  // spread of WE/OWE shows across the catalogue, most-recent-opening first —
  // matches which shows the poller is actually polling.
  const shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
  const list = (Array.isArray(shows) ? shows : shows.shows)
    .filter((s) => s.category === 'west-end' || s.category === 'off-west-end')
    .sort((a, b) => new Date(b.openingDate || 0) - new Date(a.openingDate || 0));
  const seen = new Set(urls.map((u) => u.split('/reviews-roundup/')[1]));
  for (const show of list) {
    if (urls.length >= limit) break;
    const slug = trSlug(show.title);
    const candidate = `https://theatre.reviews/reviews-roundup/${slug}-reviews/`;
    const key = candidate.split('/reviews-roundup/')[1];
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(candidate);
  }
  return urls;
}

async function testUrl(url) {
  const plain = await fetchWithScrapingdog(url, {});
  const plainVerdict = classify(plain, url);
  let stealth = null;
  let stealthVerdict = null;
  if (!plainVerdict.ok) {
    stealth = await fetchWithScrapingdog(url, { stealthMode: true });
    stealthVerdict = classify(stealth, url);
  }
  const bd = await fetchWithBrightData(url);
  const bdVerdict = classify(bd, url);
  return {
    url,
    sdPlain: plainVerdict,
    sdStealth: stealthVerdict,
    sdOk: plainVerdict.ok || !!(stealthVerdict && stealthVerdict.ok),
    bd: bdVerdict,
  };
}

(async () => {
  if (!process.env.SCRAPINGDOG_API_KEY) {
    console.error('SCRAPINGDOG_API_KEY not set — cannot run parity test.');
    process.exit(1);
  }

  let hosts = {
    'didtheylikeit.com': collectDtliUrls(LIMIT),
    'theatre.reviews': collectTrUrls(LIMIT),
  };
  if (HOST_FILTER) hosts = { [HOST_FILTER]: hosts[HOST_FILTER] };

  // Merge with any prior partial report so a --host= rerun (or a resumed run
  // after an interruption) doesn't clobber already-collected host data.
  let report = { ranAt: new Date().toISOString(), hosts: {} };
  try {
    const prior = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    if (prior && prior.hosts) report.hosts = prior.hosts;
  } catch { /* no prior report */ }

  for (const [host, urls] of Object.entries(hosts)) {
    console.log(`\n=== ${host}: ${urls.length} URLs ===`);
    const results = [];
    for (const url of urls) {
      const r = await testUrl(url);
      results.push(r);
      console.log(`${r.sdOk ? '✓' : '✗'} ${url}  [sd:${r.sdPlain.ok ? 'plain' : (r.sdStealth && r.sdStealth.ok ? 'stealth' : r.sdPlain.reason)}] [bd:${r.bd.ok ? 'ok' : r.bd.reason}]`);

      // Persist after every URL, not just every host — a kill/timeout
      // mid-run must not lose already-collected data (lost a full
      // theatre.reviews run to this during S1-T1's first attempt).
      const attemptsSoFar = results.length;
      const sdOkSoFar = results.filter((x) => x.sdOk).length;
      const bdOkSoFar = results.filter((x) => x.bd.ok).length;
      report.hosts[host] = {
        attempts: attemptsSoFar,
        sdOk: sdOkSoFar,
        bdOk: bdOkSoFar,
        successRate: attemptsSoFar ? sdOkSoFar / attemptsSoFar : 0,
        results,
      };
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    }
    const { attempts, sdOk, bdOk, successRate } = report.hosts[host];
    console.log(`— ${host}: SD ${sdOk}/${attempts} (${(successRate * 100).toFixed(0)}%), BD ${bdOk}/${attempts} —`);
  }

  console.log(`\nReport written: ${OUT_PATH}`);

  console.log('\n— Decision bar (approved plan) —');
  for (const [host, data] of Object.entries(report.hosts)) {
    const pct = (data.successRate * 100).toFixed(0);
    let verdict;
    if (data.successRate < 0.30) verdict = 'skip:true (SD)';
    else if (data.successRate >= 0.80) verdict = 'keep SD, fix params';
    else verdict = 'AMBIGUOUS — surface to owner';
    console.log(`${host}: ${pct}% → ${verdict}`);
  }
})();
