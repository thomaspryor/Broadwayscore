#!/usr/bin/env node
/**
 * One-time cleanup for task #1838 / BRO-90: 14 near-duplicate outlet pairs
 * found by scripts/lib/outlet-alias-collision.js's findOutletAliasCollisions()
 * against the live outlet-registry.json (the-la-times class — a bare id and
 * a "the "-prefixed id/displayName for the same real-world outlet, registered
 * as two separate entries). Each phantom side below was reported at 0
 * reviews in reviews.json when this list was written — --apply re-verifies
 * that against the reviews.json it's pointed at (see --reviews) and refuses
 * to merge a pair whose phantom side has since gained a review.
 *
 * Usage:
 *   node scripts/merge-outlet-alias-duplicates.js [options]           # dry run (default)
 *   node scripts/merge-outlet-alias-duplicates.js --apply [options]   # write outlet-registry.json
 *
 * Options:
 *   --registry=PATH   path to outlet-registry.json (default: data/outlet-registry.json)
 *   --reviews=PATH     path to reviews.json for the 0-review safety check (default: data/reviews.json)
 */

const fs = require('fs');
const path = require('path');

function argValue(flag, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : fallback;
}

const REGISTRY_PATH = argValue('registry', path.join(__dirname, '..', 'data', 'outlet-registry.json'));
const REVIEWS_PATH = argValue('reviews', path.join(__dirname, '..', 'data', 'reviews.json'));
const apply = process.argv.includes('--apply');

// [survivorId, phantomId, reason]
const MERGE_PAIRS = [
  ['buffalo-news', 'the-buffalo-news', 'survivor has 1 review, phantom has 0'],
  ['chicago-sun-times', 'the-chicago-sun-times', 'survivor has 4 reviews + T2 + domain, phantom has 0'],
  ['the-daily-cardinal', 'daily-cardinal', 'survivor has domain+richer aliases, both have 0 reviews; masthead is "The Daily Cardinal"'],
  ['ethankanfer', 'ethan-kanfer', 'survivor has 1 review + domain, phantom has 0'],
  ['examiner', 'the-examiner', 'survivor has 1 review, phantom has 0'],
  ['frequentbusinesstraveler', 'frequent-business-traveler', 'survivor has 3 reviews + domain, phantom has 0'],
  ['the-globe-and-mail', 'globe-and-mail', 'survivor has 5 reviews + domain + richer aliases, phantom has 0'],
  ['hartford-courant', 'the-hartford-courant', 'survivor has 4 reviews + domain, phantom has 0'],
  ['philadelphia-inquirer', 'inquirer', 'survivor has 43 reviews (T2), phantom has 0'],
  ['the-interested-bystander', 'interested-bystander', 'survivor has 19 reviews + domain, phantom has 0'],
  ['jonathankalb', 'jonathan-kalb', 'survivor has 3 reviews + domain, phantom has 0'],
  ['the-news-herald', 'news-herald', 'both have 0 reviews and no domain; masthead is "The News-Herald" (Willoughby, OH)'],
  ['philippine-daily-inquirer', 'the-philippine-daily-inquirer', 'both have 0 reviews and no domain; masthead does not take "The"'],
  ['timteeman', 'tim-teeman', 'survivor has 2 reviews + domain, phantom has 0'],
];

function countReviewsByOutlet(reviewsPath) {
  const counts = new Map();
  if (!fs.existsSync(reviewsPath)) return counts;
  const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const entries = Array.isArray(reviews) ? reviews : Object.values(reviews).flat();
  for (const r of entries) {
    const outletId = r && (r.outletId || (r.outlet && r.outlet.id));
    if (!outletId) continue;
    counts.set(outletId, (counts.get(outletId) || 0) + 1);
  }
  return counts;
}

function mergeOutlets(registry, reviewCounts) {
  const outlets = registry.outlets || registry;
  const aliasIndex = registry._aliasIndex || {};
  const results = [];

  for (const [survivorId, phantomId, reason] of MERGE_PAIRS) {
    const survivor = outlets[survivorId];
    const phantom = outlets[phantomId];
    if (!survivor || !phantom) {
      results.push({ survivorId, phantomId, skipped: true, why: 'missing from registry (already merged?)' });
      continue;
    }

    const phantomReviewCount = reviewCounts.get(phantomId) || 0;
    if (phantomReviewCount > 0) {
      results.push({
        survivorId, phantomId, skipped: true,
        why: `phantom now has ${phantomReviewCount} review(s) in reviews.json — refusing to merge, needs manual re-pointing`,
      });
      continue;
    }

    const aliasSet = new Set((survivor.aliases || []).map((a) => a.toLowerCase().trim()));
    aliasSet.add(phantomId.toLowerCase());
    if (phantom.displayName) aliasSet.add(phantom.displayName.toLowerCase());
    for (const a of phantom.aliases || []) aliasSet.add(a.toLowerCase().trim());
    survivor.aliases = [...aliasSet];

    // Preserve a phantom's defaultCritic only when the survivor doesn't have one.
    if (!survivor.defaultCritic && phantom.defaultCritic) {
      survivor.defaultCritic = phantom.defaultCritic;
    }

    // Preserve a phantom's domain(s) as domainAliases on the survivor so URL
    // resolution (outletOwnsUrlDomain) doesn't lose a host on merge — none of
    // this run's 14 phantoms carry a domain, but the check keeps the script
    // safe to reuse on a future the-la-times-class pair that does.
    const domainAliasSet = new Set((survivor.domainAliases || []).map((d) => d.toLowerCase().trim()));
    for (const d of [phantom.domain, ...(phantom.domainAliases || [])]) {
      if (d && d.toLowerCase().trim() !== (survivor.domain || '').toLowerCase().trim()) {
        domainAliasSet.add(d.toLowerCase().trim());
      }
    }
    if (domainAliasSet.size > 0) survivor.domainAliases = [...domainAliasSet];

    // Repoint any _aliasIndex entries that pointed at the phantom — otherwise
    // they'd keep resolving to a canonical id that no longer exists in
    // registry.outlets once the phantom entry is deleted below.
    for (const [alias, targetId] of Object.entries(aliasIndex)) {
      if (targetId === phantomId) aliasIndex[alias] = survivorId;
    }

    delete outlets[phantomId];
    results.push({ survivorId, phantomId, reason, applied: true });
  }

  return results;
}

function run() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const registry = JSON.parse(raw);
  const reviewCounts = countReviewsByOutlet(REVIEWS_PATH);

  const results = mergeOutlets(registry, reviewCounts);
  for (const r of results) {
    if (r.skipped) {
      console.log(`  [skip] ${r.survivorId} <- ${r.phantomId}: ${r.why}`);
    } else {
      console.log(`  [merge] ${r.phantomId} -> ${r.survivorId} (${r.reason})`);
    }
  }

  if (apply) {
    if (registry._meta) {
      registry._meta.lastUpdated = new Date().toISOString();
      registry._meta.lastChange = 'task #1838: merge 14 near-duplicate outlet pairs found by outlet-alias-collision.js (the-la-times class)';
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    console.log(`\nWrote ${REGISTRY_PATH}`);
  } else {
    console.log('\nDry run — pass --apply to write changes.');
  }
}

run();
