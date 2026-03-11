#!/usr/bin/env node
/**
 * evaluate-brightdata-serp.js
 *
 * Compare ScrapingBee Google SERP vs BrightData SERP API quality.
 * Runs N real queries through both, compares result overlap and quality.
 *
 * Usage: node scripts/evaluate-brightdata-serp.js [--queries=20]
 *
 * Env: SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN
 */

const fs = require('fs');
const path = require('path');

const QUERIES_ARG = process.argv.find(a => a.startsWith('--queries='));
const NUM_QUERIES = QUERIES_ARG ? parseInt(QUERIES_ARG.split('=')[1]) : 20;

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;

if (!SCRAPINGBEE_KEY) console.warn('⚠ SCRAPINGBEE_API_KEY not set — skipping ScrapingBee');
if (!BRIGHTDATA_TOKEN) console.warn('⚠ BRIGHTDATA_TOKEN not set — skipping BrightData');
if (!SCRAPINGBEE_KEY && !BRIGHTDATA_TOKEN) {
  console.error('Need at least one API key');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build test queries from real shows
function buildTestQueries() {
  const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const shows = showsData.shows || Object.values(showsData);
  const openShows = shows.filter(s => s.status === 'open' && s.openingDate);

  // Pick a mix of show types for realistic queries
  const selected = openShows.slice(0, Math.min(NUM_QUERIES, openShows.length));

  const queries = [];
  for (const show of selected) {
    const title = show.title || show.name;
    const year = new Date(show.openingDate).getFullYear();
    // Typical discover-opening-night-reviews.js query pattern
    queries.push({
      label: `${title} (nytimes)`,
      query: `site:nytimes.com "${title}" review ${year}`,
    });
  }
  return queries;
}

async function searchScrapingBee(query) {
  const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(query)}&nb_results=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`ScrapingBee ${res.status}`);
  const data = await res.json();
  return (data.organic_results || data.results || []).map(r => ({
    url: (r.url || r.link || '').toLowerCase(),
    title: r.title || '',
  }));
}

const BD_CUSTOMER = process.env.BRIGHTDATA_CUSTOMER || 'hl_a2c64a47';
const BD_ZONE = process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1';

async function searchBrightData(query) {
  // Step 1: Submit async request
  const submitRes = await fetch(
    `https://api.brightdata.com/serp/req?customer=${BD_CUSTOMER}&zone=${BD_ZONE}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
      },
      body: JSON.stringify({ query: { q: query, gl: 'us' } }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!submitRes.ok) throw new Error(`BrightData submit ${submitRes.status}`);
  const submitData = await submitRes.json();
  const responseId = submitData.response_id;
  if (!responseId) throw new Error('No response_id');

  // Step 2: Poll for results (max 20s)
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const pollRes = await fetch(
      `https://api.brightdata.com/serp/get_result?response_id=${responseId}`,
      {
        headers: { 'Authorization': `Bearer ${BRIGHTDATA_TOKEN}` },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (pollRes.status === 202) continue;
    if (!pollRes.ok) throw new Error(`BrightData poll ${pollRes.status}`);
    const data = await pollRes.json();
    if (data.organic) {
      return data.organic.slice(0, 5).map(r => ({
        url: (r.link || r.url || '').toLowerCase(),
        title: r.title || '',
      }));
    }
    if (data.response_id) continue;
    return [];
  }
  throw new Error('BrightData timeout (20s)');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch { return url; }
}

async function main() {
  const queries = buildTestQueries();
  console.log(`Running ${queries.length} comparison queries...\n`);

  const results = [];
  let sbCredits = 0;

  for (let i = 0; i < queries.length; i++) {
    const { label, query } = queries[i];
    console.log(`[${i + 1}/${queries.length}] ${label}`);

    let sbResults = null;
    let bdResults = null;

    // ScrapingBee
    if (SCRAPINGBEE_KEY) {
      try {
        sbResults = await searchScrapingBee(query);
        sbCredits += 25;
        console.log(`  SB: ${sbResults.length} results`);
      } catch (err) {
        console.log(`  SB: ERROR - ${err.message}`);
      }
    }

    await sleep(500);

    // BrightData
    if (BRIGHTDATA_TOKEN) {
      try {
        bdResults = await searchBrightData(query);
        console.log(`  BD: ${bdResults.length} results`);
      } catch (err) {
        console.log(`  BD: ERROR - ${err.message}`);
      }
    }

    // Compare
    if (sbResults && bdResults) {
      const sbUrls = new Set(sbResults.map(r => normalizeUrl(r.url)));
      const bdUrls = new Set(bdResults.map(r => normalizeUrl(r.url)));
      const overlap = [...sbUrls].filter(u => bdUrls.has(u)).length;
      const total = new Set([...sbUrls, ...bdUrls]).size;
      const overlapPct = total > 0 ? Math.round(overlap / total * 100) : 0;
      console.log(`  Overlap: ${overlap}/${total} URLs (${overlapPct}%)`);

      results.push({
        label, query,
        sbCount: sbResults.length,
        bdCount: bdResults.length,
        overlap, total, overlapPct,
        sbUrls: [...sbUrls],
        bdUrls: [...bdUrls],
      });
    } else if (sbResults) {
      results.push({ label, query, sbCount: sbResults.length, bdCount: 0, overlap: 0, overlapPct: 0 });
    } else if (bdResults) {
      results.push({ label, query, sbCount: 0, bdCount: bdResults.length, overlap: 0, overlapPct: 0 });
    }

    await sleep(1500); // Rate limit
  }

  // Summary
  console.log('\n=== COMPARISON SUMMARY ===\n');

  const withBoth = results.filter(r => r.sbCount > 0 && r.bdCount > 0);
  if (withBoth.length > 0) {
    const avgOverlap = Math.round(withBoth.reduce((s, r) => s + r.overlapPct, 0) / withBoth.length);
    const avgSbCount = (withBoth.reduce((s, r) => s + r.sbCount, 0) / withBoth.length).toFixed(1);
    const avgBdCount = (withBoth.reduce((s, r) => s + r.bdCount, 0) / withBoth.length).toFixed(1);

    console.log(`Queries compared: ${withBoth.length}`);
    console.log(`Avg ScrapingBee results: ${avgSbCount}`);
    console.log(`Avg BrightData results: ${avgBdCount}`);
    console.log(`Avg URL overlap: ${avgOverlap}%`);

    // Check if BD finds results when SB does
    const sbHasResults = withBoth.filter(r => r.sbCount > 0);
    const bdAlsoHas = sbHasResults.filter(r => r.bdCount > 0);
    console.log(`\nWhen SB finds results, BD also finds: ${bdAlsoHas.length}/${sbHasResults.length} (${Math.round(bdAlsoHas.length / sbHasResults.length * 100)}%)`);

    // Quality: does BD find the SAME top result?
    const topMatchCount = withBoth.filter(r => {
      if (!r.sbUrls || !r.bdUrls || r.sbUrls.length === 0 || r.bdUrls.length === 0) return false;
      return r.bdUrls.includes(r.sbUrls[0]);
    }).length;
    console.log(`BD contains SB's #1 result: ${topMatchCount}/${withBoth.length} (${Math.round(topMatchCount / withBoth.length * 100)}%)`);
  }

  const sbErrors = results.filter(r => r.sbCount === 0 && r.bdCount > 0);
  const bdErrors = results.filter(r => r.sbCount > 0 && r.bdCount === 0);
  console.log(`\nSB-only failures: ${sbErrors.length}`);
  console.log(`BD-only failures: ${bdErrors.length}`);

  console.log(`\nScrapingBee credits used: ${sbCredits} (${sbCredits * 25} at 25/query)`);
  console.log(`BrightData estimated cost: $${(results.length * 0.0015).toFixed(3)} (at $1.50/1K)`);

  // Verdict
  console.log('\n=== VERDICT ===\n');
  if (withBoth.length >= 5) {
    const avgOverlap = Math.round(withBoth.reduce((s, r) => s + r.overlapPct, 0) / withBoth.length);
    if (avgOverlap >= 60) {
      console.log('✅ BrightData SERP quality is GOOD — suitable as fallback');
      console.log('   Recommendation: Use as overflow fallback when ScrapingBee credits exhaust');
    } else if (avgOverlap >= 40) {
      console.log('⚠️  BrightData SERP quality is MODERATE — usable but lower overlap');
      console.log('   Recommendation: Use as fallback with awareness of quality gap');
    } else {
      console.log('❌ BrightData SERP quality is LOW — significant result differences');
      console.log('   Recommendation: Investigate before using as fallback');
    }
  } else {
    console.log('⚠️  Not enough comparison data for a verdict');
  }

  // Save results
  const outPath = '/tmp/serp-comparison.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
