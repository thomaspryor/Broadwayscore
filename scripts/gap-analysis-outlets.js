#!/usr/bin/env node
/**
 * Gap analysis for review text collection.
 * Reports completion rates by outlet, incompleteReason breakdown,
 * and actionable next steps.
 *
 * Usage: node scripts/gap-analysis-outlets.js [--verbose] [--json]
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

const REVIEW_TEXTS_DIR = 'data/review-texts';
const REVIEWS_JSON = 'data/reviews.json';
const FAILED_FETCHES = path.join(REVIEW_TEXTS_DIR, 'failed-fetches.json');

const verbose = process.argv.includes('--verbose');
const jsonOutput = process.argv.includes('--json');

// Outlet tier mapping (matches collect-review-texts.js CONFIG)
const TIER1 = ['nytimes', 'newyorktimes', 'vulture', 'variety', 'washingtonpost', 'wsj', 'newyorker', 'ft.com', 'financialtimes', 'hollywoodreporter'];
const TIER2 = ['theatermania', 'nypost', 'deadline', 'ew.com', 'entertainmentweekly', 'usatoday', 'time.com', 'theguardian', 'observer', 'nydailynews', 'bloomberg'];
const TIER3 = ['broadwayworld', 'playbill', 'theaterly', 'bwayblog', 'stagebuddy', 'theaterlife', 'exeuntmagazine', 'broadwayjournal'];

function getOutletTier(outletId) {
  const id = (outletId || '').toLowerCase();
  if (TIER1.some(t => id.includes(t))) return 1;
  if (TIER2.some(t => id.includes(t))) return 2;
  if (TIER3.some(t => id.includes(t))) return 3;
  return 4;
}

function run() {
  // Load all review-text files
  const reviews = [];
  const shows = listShowDirs(REVIEW_TEXTS_DIR)
    .filter(f => {
      const sp = path.join(REVIEW_TEXTS_DIR, f);
      try { return fs.statSync(sp).isDirectory(); } catch { return false; }
    });

  for (const showId of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        reviews.push({
          showId,
          file,
          outlet: data.outlet || file.split('--')[0],
          outletId: data.outletId || file.split('--')[0],
          tier: getOutletTier(data.outletId || file.split('--')[0]),
          contentTier: data.contentTier || 'unknown',
          incompleteReason: data.incompleteReason || null,
          hasFullText: !!(data.fullText && data.fullText.length > 100),
          fullTextLen: (data.fullText || '').length,
          isFullReview: data.isFullReview || false,
          hasExcerpt: !!(data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt),
          fetchAttempts: data.fetchAttempts || 0,
          url: data.url || null,
          wrongProduction: data.wrongProduction || false,
          wrongShow: data.wrongShow || false,
          fabricated: data.fabricatedEntry || false,
        });
      } catch (e) {
        // skip malformed files
      }
    }
  }

  // Load failed-fetches for cross-reference
  let failedFetches = [];
  try {
    failedFetches = JSON.parse(fs.readFileSync(FAILED_FETCHES, 'utf8'));
  } catch (e) {}
  const failedMap = new Map(failedFetches.map(f => [f.reviewId, f]));

  // Load reviews.json for scoring cross-reference
  let scoredReviews = [];
  try {
    scoredReviews = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8')).reviews || [];
  } catch (e) {}

  // ---- Summary stats ----
  const total = reviews.length;
  const complete = reviews.filter(r => r.contentTier === 'complete').length;
  const excluded = reviews.filter(r => r.wrongProduction || r.wrongShow || r.fabricated).length;
  const active = total - excluded;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  REVIEW TEXT GAP ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total review-text files:  ${total.toLocaleString()}`);
  console.log(`  Excluded (wrong/fab):     ${excluded.toLocaleString()}`);
  console.log(`  Active:                   ${active.toLocaleString()}`);
  console.log(`  Complete (full text):     ${complete.toLocaleString()} (${(complete/active*100).toFixed(1)}%)`);
  console.log(`  In reviews.json (scored): ${scoredReviews.length.toLocaleString()}`);
  console.log('');

  // ---- incompleteReason breakdown ----
  const byReason = {};
  for (const r of reviews) {
    if (r.wrongProduction || r.wrongShow || r.fabricated) continue;
    const reason = r.incompleteReason || (r.contentTier === 'complete' ? 'complete' : 'unclassified');
    if (!byReason[reason]) byReason[reason] = { count: 0, withUrl: 0, inFailedFetches: 0, tiers: [0,0,0,0,0] };
    byReason[reason].count++;
    if (r.url) byReason[reason].withUrl++;
    const rid = `${r.showId}/${r.file}`;
    if (failedMap.has(rid)) byReason[reason].inFailedFetches++;
    byReason[reason].tiers[r.tier]++;
  }

  console.log('  INCOMPLETE REASON BREAKDOWN');
  console.log('  ─────────────────────────────────────────────────────');
  const sortedReasons = Object.entries(byReason).sort((a, b) => b[1].count - a[1].count);
  for (const [reason, data] of sortedReasons) {
    const pct = (data.count / active * 100).toFixed(1);
    const tierStr = `T1:${data.tiers[1]} T2:${data.tiers[2]} T3:${data.tiers[3]} T4:${data.tiers[4]}`;
    console.log(`  ${reason.padEnd(20)} ${String(data.count).padStart(6)}  (${pct.padStart(5)}%)  ${tierStr}`);
    if (verbose && reason !== 'complete') {
      console.log(`    With URL: ${data.withUrl}, In failed-fetches: ${data.inFailedFetches}`);
    }
  }
  console.log('');

  // ---- Outlet completion (top outlets by gap) ----
  const byOutlet = {};
  for (const r of reviews) {
    if (r.wrongProduction || r.wrongShow || r.fabricated) continue;
    const key = r.outlet;
    if (!byOutlet[key]) byOutlet[key] = { total: 0, complete: 0, tier: r.tier, outletId: r.outletId, byReason: {} };
    byOutlet[key].total++;
    if (r.contentTier === 'complete') byOutlet[key].complete++;
    const reason = r.incompleteReason || (r.contentTier === 'complete' ? 'complete' : 'unclassified');
    byOutlet[key].byReason[reason] = (byOutlet[key].byReason[reason] || 0) + 1;
  }

  // Sort by gap size (most incomplete first)
  const sortedOutlets = Object.entries(byOutlet)
    .map(([name, d]) => ({ name, ...d, gap: d.total - d.complete, pct: d.total > 0 ? (d.complete / d.total * 100) : 0 }))
    .sort((a, b) => b.gap - a.gap);

  console.log('  TOP 25 OUTLETS BY GAP (most incomplete first)');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Outlet                          Tier  Complete/Total    %   Gap  Top Reason');
  for (const o of sortedOutlets.slice(0, 25)) {
    const topReason = Object.entries(o.byReason)
      .filter(([r]) => r !== 'complete')
      .sort((a, b) => b[1] - a[1])[0];
    const reasonStr = topReason ? `${topReason[0]}(${topReason[1]})` : '';
    console.log(`  ${o.name.substring(0, 33).padEnd(33)} T${o.tier}  ${String(o.complete).padStart(5)}/${String(o.total).padStart(5)}  ${o.pct.toFixed(0).padStart(3)}%  ${String(o.gap).padStart(4)}  ${reasonStr}`);
  }
  console.log('');

  // ---- Tier 1 outlet detail ----
  const tier1Outlets = sortedOutlets.filter(o => o.tier === 1);
  if (tier1Outlets.length > 0) {
    console.log('  TIER 1 OUTLETS (full detail)');
    console.log('  ─────────────────────────────────────────────────────');
    for (const o of tier1Outlets.sort((a, b) => a.pct - b.pct)) {
      console.log(`  ${o.name.padEnd(30)} ${o.complete}/${o.total} (${o.pct.toFixed(1)}%) — gap: ${o.gap}`);
      for (const [reason, count] of Object.entries(o.byReason).filter(([r]) => r !== 'complete').sort((a, b) => b[1] - a[1])) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    console.log('');
  }

  // ---- Tier 2 outlet detail ----
  const tier2Outlets = sortedOutlets.filter(o => o.tier === 2);
  if (tier2Outlets.length > 0) {
    console.log('  TIER 2 OUTLETS (full detail)');
    console.log('  ─────────────────────────────────────────────────────');
    for (const o of tier2Outlets.sort((a, b) => a.pct - b.pct)) {
      console.log(`  ${o.name.padEnd(30)} ${o.complete}/${o.total} (${o.pct.toFixed(1)}%) — gap: ${o.gap}`);
      if (verbose) {
        for (const [reason, count] of Object.entries(o.byReason).filter(([r]) => r !== 'complete').sort((a, b) => b[1] - a[1])) {
          console.log(`    ${reason}: ${count}`);
        }
      }
    }
    console.log('');
  }

  // ---- not_attempted deep dive ----
  const notAttempted = reviews.filter(r => r.incompleteReason === 'not_attempted' && !r.wrongProduction && !r.wrongShow && !r.fabricated);
  if (notAttempted.length > 0) {
    console.log('  NOT_ATTEMPTED DEEP DIVE');
    console.log('  ─────────────────────────────────────────────────────');
    console.log(`  Total: ${notAttempted.length}`);
    console.log(`  With URL: ${notAttempted.filter(r => r.url).length}`);
    console.log(`  Without URL: ${notAttempted.filter(r => !r.url).length}`);

    // By domain
    const naByDomain = {};
    for (const r of notAttempted) {
      if (!r.url) { naByDomain['NO_URL'] = (naByDomain['NO_URL'] || 0) + 1; continue; }
      try {
        const domain = new URL(r.url).hostname.replace(/^www\./, '');
        naByDomain[domain] = (naByDomain[domain] || 0) + 1;
      } catch { naByDomain['BAD_URL'] = (naByDomain['BAD_URL'] || 0) + 1; }
    }
    console.log('\n  Top domains with not_attempted:');
    for (const [d, c] of Object.entries(naByDomain).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${d}: ${c}`);
    }
    console.log('');
  }

  // ---- Actionable summary ----
  console.log('  ACTIONABLE SUMMARY');
  console.log('  ─────────────────────────────────────────────────────');
  const recoverable = {
    not_attempted: (byReason['not_attempted']?.count || 0),
    partial_text: (byReason['partial_text']?.count || 0),
    scraper_garbage: (byReason['scraper_garbage']?.count || 0),
    bot_blocked: (byReason['bot_blocked']?.count || 0),
    scraper_timeout: (byReason['scraper_timeout']?.count || 0),
  };
  const hard = {
    paywall: (byReason['paywall']?.count || 0),
    url_dead: (byReason['url_dead']?.count || 0),
    wrong_content: (byReason['wrong_content']?.count || 0),
    no_url: (byReason['no_url']?.count || 0),
  };

  const totalRecoverable = Object.values(recoverable).reduce((a, b) => a + b, 0);
  const totalHard = Object.values(hard).reduce((a, b) => a + b, 0);

  console.log(`  Likely recoverable (re-scrape):  ${totalRecoverable}`);
  for (const [k, v] of Object.entries(recoverable).filter(([, v]) => v > 0)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log(`  Hard to recover:                 ${totalHard}`);
  for (const [k, v] of Object.entries(hard).filter(([, v]) => v > 0)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log('');

  // JSON output
  if (jsonOutput) {
    fs.mkdirSync('data/audit', { recursive: true });
    const result = {
      timestamp: new Date().toISOString(),
      summary: { total, excluded, active, complete, completePct: (complete/active*100).toFixed(1), scored: scoredReviews.length },
      byReason: Object.fromEntries(sortedReasons),
      tier1: tier1Outlets.map(o => ({ name: o.name, complete: o.complete, total: o.total, pct: o.pct.toFixed(1), gap: o.gap, byReason: o.byReason })),
      tier2: tier2Outlets.map(o => ({ name: o.name, complete: o.complete, total: o.total, pct: o.pct.toFixed(1), gap: o.gap, byReason: o.byReason })),
      recoverable,
      hard,
    };
    fs.writeFileSync('data/audit/gap-analysis.json', JSON.stringify(result, null, 2));
    console.log('  JSON output written to data/audit/gap-analysis.json');
  }
}

run();
