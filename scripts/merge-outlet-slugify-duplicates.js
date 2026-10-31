#!/usr/bin/env node
/**
 * One-time cleanup for task #1844: 8 near-duplicate outlet pairs found by
 * scripts/lib/outlet-alias-collision.js's findOutletAliasCollisions()
 * against the live outlet-registry.json after extending it to the
 * slugify()/concatenated class (a hyphenated masthead registration and a
 * bare-domain-style concatenated registration for the same real outlet —
 * theater-news-online/theaternewsonline, the-la-times/latimes's sibling bug
 * via a different normalizeOutlet() fallback path). Each phantom side below
 * was reported at 0 reviews in reviews.json when this list was written —
 * --apply re-verifies that against the reviews.json it's pointed at (see
 * --reviews) and refuses to merge a pair whose phantom side has since
 * gained a review.
 *
 * Usage:
 *   node scripts/merge-outlet-slugify-duplicates.js [options]           # dry run (default)
 *   node scripts/merge-outlet-slugify-duplicates.js --apply [options]   # write outlet-registry.json
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
  ['theater-news-online', 'theaternewsonline', 'survivor has 31 reviews + richer aliases, phantom has 0'],
  ['dallasvoice', 'dallas-voice', 'survivor has 1 review + domain, phantom has 0'],
  ['theonlycritic', 'the-only-critic', 'survivor has 1 review + domain, phantom has 0'],
  ['adriandimanlig', 'adrian-dim-anlig', 'survivor has 6 reviews + domain, phantom has 0'],
  ['new-york-city-theatre', 'newyorkcitytheatre', 'survivor has domain + richer aliases, both have 0 reviews; masthead is "New York City Theatre"'],
  ['outinjersey', 'out-in-jersey', 'survivor has 1 review + domain, phantom has 0'],
  ['new-city-stage', 'newcitystage', 'survivor has richer aliases (critic-specific), both have 0 reviews; phantom\'s domain preserved as domainAlias'],
  ['jewishnews', 'the-jewish-news', 'survivor has 2 reviews + domain, phantom has 0'],
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
    // resolution (outletOwnsUrlDomain) doesn't lose a host on merge.
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
      registry._meta.lastChange = 'task #1844: merge 8 near-duplicate outlet pairs found by outlet-alias-collision.js (hyphen/concatenated class)';
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    console.log(`\nWrote ${REGISTRY_PATH}`);
  } else {
    console.log('\nDry run — pass --apply to write changes.');
  }
}

run();
