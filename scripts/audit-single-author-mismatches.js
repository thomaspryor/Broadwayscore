#!/usr/bin/env node
/**
 * audit-single-author-mismatches.js
 *
 * Classify outlet-registry outlets with `defaultCritic` set as:
 *   - single-author       : only the defaultCritic appears in reviews.json
 *   - mostly-staff        : defaultCritic match rate ≥ 85%
 *   - multi-author-candidate : ≥3 distinct critics AND defaultCritic match rate < 60% AND NOT in allow-list
 *   - low-data            : < 5 reviews total — defer
 *   - allow-listed        : in the T1 staff-turnover allow-list — never auto-flag
 *
 * The allow-list is intentional: outlets like the New York Times, Vulture, Variety
 * have had multiple critics over the years (staff turnover), but bylines are
 * authoritative and NOT a rotating-byline pattern. Setting multiAuthor=true on
 * these would break the canonical-T1 critic attribution. (Pre-mortem reviewer
 * finding before this script was written — 2026-05-21 plan-review.)
 *
 * Output: data/audit/outlet-multiauthor-classification.json
 *
 * Usage:
 *   node scripts/audit-single-author-mismatches.js
 *   node scripts/audit-single-author-mismatches.js --json
 *   node scripts/audit-single-author-mismatches.js --apply  (writes multiAuthor:true to confirmed outlets)
 *
 * Sister card to: scripts/audit-bww-rr-critic-mismatches.js (which scans BWW HTML archives).
 * This one scans reviews.json — the empirical record of what critic each review was attributed to.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'audit', 'outlet-multiauthor-classification.json');

// Allow-list — outlets where staff turnover over the years has produced ≥3
// distinct critics but bylines are AUTHORITATIVE (not rotating). Setting
// multiAuthor:true on these would break canonical T1/T2 critic attribution.
// Pre-mortem (2026-05-21) caught this before any code shipped.
const STAFF_TURNOVER_ALLOWLIST = new Set([
  // T1 — flagship critics' picks
  'nytimes', 'vulture', 'variety', 'hollywood-reporter', 'newyorker',
  'wsj', 'washington-post', 'la-times', 'guardian', 'observer',
  'financial-times', 'the-times', 'telegraph', 'evening-standard',
  'bbc-news', 'npr', 'ap', 'associated-press',
  // T2 — major papers with named staff critics
  'time-out', 'timeout', 'timeout-london',
  'theatermania', 'broadwayworld', 'nypost', 'daily-news', 'newsday',
  'boston-globe', 'sfgate', 'chicago-tribune', 'chicago-sun-times',
  'washington-blade', 'washington-times', 'philadelphia-inquirer',
  'star-tribune', 'minneapolis-star-tribune',
  'whatsonstage', 'the-stage', 'london-theatre', 'londontheatre-co-uk',
  'time-out-london', 'time-out-new-york', 'amny',
  // Aggregator / theatre-press outlets with named critics
  'deadline', 'time', 'newsweek', 'forbes', 'bloomberg', 'reuters',
  // Trade press with named critics
  'playbill', 'theatermania', 'new-york-theatre-guide', 'nytg',
  'didtheylikeit', 'show-score', 'talkin-broadway', 'talkinbroadway',
]);

const MULTI_AUTHOR_CRITIC_COUNT_THRESHOLD = 3;       // ≥ N distinct critics
const MULTI_AUTHOR_MATCH_RATE_THRESHOLD = 0.60;      // defaultCritic appears <60% of the time
const LOW_DATA_THRESHOLD = 5;                         // <5 reviews total → defer
const MOSTLY_STAFF_THRESHOLD = 0.85;                  // ≥85% match → keep default

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const apply = args.includes('--apply');

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')).outlets;
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf-8')).reviews;

  // Index reviews by outletId
  const byOutlet = new Map();
  for (const r of reviews) {
    if (!r.outletId) continue;
    const arr = byOutlet.get(r.outletId);
    if (arr) arr.push(r);
    else byOutlet.set(r.outletId, [r]);
  }

  const classification = {
    'allow-listed': [],
    'multi-author-confirmed': [],
    'single-author': [],
    'mostly-staff': [],
    'low-data': [],
    'no-data': [],
  };

  for (const [outletId, entry] of Object.entries(registry)) {
    if (!entry.defaultCritic) continue;

    const defaultCriticNorm = normalize(entry.defaultCritic);
    const outletReviews = byOutlet.get(outletId) || [];
    const distinctCritics = new Map();
    for (const r of outletReviews) {
      const c = normalize(r.criticName);
      if (!c || c === 'unknown' || c === 'unnamed') continue;
      distinctCritics.set(c, (distinctCritics.get(c) || 0) + 1);
    }

    const totalAttributed = [...distinctCritics.values()].reduce((s, n) => s + n, 0);
    const defaultMatches = distinctCritics.get(defaultCriticNorm) || 0;
    const matchRate = totalAttributed > 0 ? defaultMatches / totalAttributed : null;

    const record = {
      outletId,
      defaultCritic: entry.defaultCritic,
      tier: entry.tier,
      totalReviews: outletReviews.length,
      attributedReviews: totalAttributed,
      distinctCritics: distinctCritics.size,
      defaultCriticMatches: defaultMatches,
      matchRate: matchRate != null ? Number(matchRate.toFixed(3)) : null,
      topCritics: [...distinctCritics.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([critic, count]) => ({ critic, count })),
    };

    if (STAFF_TURNOVER_ALLOWLIST.has(outletId)) {
      classification['allow-listed'].push(record);
      continue;
    }

    if (totalAttributed === 0) {
      classification['no-data'].push(record);
      continue;
    }

    if (totalAttributed < LOW_DATA_THRESHOLD) {
      classification['low-data'].push(record);
      continue;
    }

    if (distinctCritics.size === 1) {
      classification['single-author'].push(record);
      continue;
    }

    if (matchRate >= MOSTLY_STAFF_THRESHOLD) {
      classification['mostly-staff'].push(record);
      continue;
    }

    if (
      distinctCritics.size >= MULTI_AUTHOR_CRITIC_COUNT_THRESHOLD &&
      matchRate < MULTI_AUTHOR_MATCH_RATE_THRESHOLD
    ) {
      classification['multi-author-confirmed'].push(record);
      continue;
    }

    // Doesn't meet multi-author threshold; default to mostly-staff bucket
    // (typically 2 critics, or matchRate 0.60-0.85)
    classification['mostly-staff'].push(record);
  }

  // Sort each bucket
  for (const bucket of Object.values(classification)) {
    bucket.sort((a, b) => (b.totalReviews || 0) - (a.totalReviews || 0));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    thresholds: {
      MULTI_AUTHOR_CRITIC_COUNT_THRESHOLD,
      MULTI_AUTHOR_MATCH_RATE_THRESHOLD,
      LOW_DATA_THRESHOLD,
      MOSTLY_STAFF_THRESHOLD,
    },
    allowlistSize: STAFF_TURNOVER_ALLOWLIST.size,
    counts: Object.fromEntries(
      Object.entries(classification).map(([k, v]) => [k, v.length])
    ),
    classification,
  };

  // Write to data/audit
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2) + '\n');

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Human-readable summary
  console.log('=== Outlet single-author-vs-multi-author classification ===\n');
  console.log('Thresholds:');
  console.log(`  multi-author-confirmed: ≥${MULTI_AUTHOR_CRITIC_COUNT_THRESHOLD} distinct critics AND defaultCritic match rate < ${MULTI_AUTHOR_MATCH_RATE_THRESHOLD * 100}%`);
  console.log(`  low-data: < ${LOW_DATA_THRESHOLD} attributed reviews\n`);
  console.log('Counts:');
  for (const [bucket, items] of Object.entries(classification)) {
    console.log(`  ${bucket.padEnd(24)} : ${items.length}`);
  }
  console.log(`\nAllow-list size: ${STAFF_TURNOVER_ALLOWLIST.size} outlets (T1 staff-turnover protection)`);
  console.log(`\nOutput: ${path.relative(ROOT, OUTPUT_PATH)}`);

  console.log('\n=== multi-author-confirmed (will get multiAuthor:true if --apply) ===');
  if (classification['multi-author-confirmed'].length === 0) {
    console.log('  (none)');
  } else {
    for (const r of classification['multi-author-confirmed']) {
      console.log(
        `  ${r.outletId.padEnd(40)} default="${r.defaultCritic}" — ` +
        `${r.distinctCritics} critics, ${(r.matchRate * 100).toFixed(0)}% match, ${r.totalReviews} reviews`
      );
      console.log(`    top: ${r.topCritics.map(c => `${c.critic} (${c.count})`).join(', ')}`);
    }
  }

  if (apply) {
    if (classification['multi-author-confirmed'].length === 0) {
      console.log('\n--apply: nothing to do (no multi-author-confirmed outlets)');
      return;
    }
    console.log('\n=== --apply: setting multiAuthor:true on multi-author-confirmed outlets ===');
    const registryFull = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    let changed = 0;
    for (const r of classification['multi-author-confirmed']) {
      if (registryFull.outlets[r.outletId].multiAuthor === true) continue;
      registryFull.outlets[r.outletId].multiAuthor = true;
      console.log(`  ${r.outletId}: multiAuthor=true (default="${r.defaultCritic}" → bylines now rotate)`);
      changed++;
    }
    if (changed > 0) {
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registryFull, null, 2) + '\n');
      console.log(`\n  Wrote ${changed} updates to ${path.relative(ROOT, REGISTRY_PATH)}`);
      console.log('  REMINDER: per memory/feedback_outlet_registry_dual_repo.md, commit to broadway-scorecard-data FIRST.');
    } else {
      console.log('\n  No changes (all confirmed outlets already have multiAuthor:true).');
    }
  }
}

main();
