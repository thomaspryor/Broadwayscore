#!/usr/bin/env node
/**
 * One-time cleanup for task #1838 / BRO-90: 14 near-duplicate outlet pairs
 * found by scripts/lib/outlet-alias-collision.js's findOutletAliasCollisions()
 * against the live outlet-registry.json (the-la-times class — a bare id and
 * a "the "-prefixed id/displayName for the same real-world outlet, registered
 * as two separate entries). Each phantom side below has 0 reviews attributed
 * to it in reviews.json (verified before this list was written) — merging is
 * safe because no existing review needs to be re-pointed.
 *
 * Usage:
 *   node scripts/merge-outlet-alias-duplicates.js          # dry run (default)
 *   node scripts/merge-outlet-alias-duplicates.js --apply  # write outlet-registry.json
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
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

function mergeOutlets(registry) {
  const outlets = registry.outlets || registry;
  const results = [];

  for (const [survivorId, phantomId, reason] of MERGE_PAIRS) {
    const survivor = outlets[survivorId];
    const phantom = outlets[phantomId];
    if (!survivor || !phantom) {
      results.push({ survivorId, phantomId, skipped: true, why: 'missing from registry (already merged?)' });
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

    delete outlets[phantomId];
    results.push({ survivorId, phantomId, reason, applied: true });
  }

  return results;
}

function run() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const registry = JSON.parse(raw);

  const results = mergeOutlets(registry);
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
