#!/usr/bin/env node

/**
 * audit-unknown-outlets.js
 *
 * Counts "resolvable unknown outlets" — review files whose outletId is a real,
 * resolvable id that is NOT present in outlet-registry.json (so it could/should
 * be registered). Inherently-unresolvable ids are skipped: the literal
 * "unknown" (web-search sourcing) and junk/sentence ids with >5 hyphens.
 *
 * This was previously a BLOCKING assertion (`resolvableUnknowns <= 5`) in
 * tests/unit/data-quality-pipeline.test.js. But it asserts on a property of the
 * live corpus that drifts every time a new scraper discovers an outlet not yet
 * in the registry — a no-op code push could fail it. Per the advisory-vs-
 * blocking rule it belongs on the non-blocking check-corpus-drift path (surfaced
 * in the rebuild digest), not in the blocking test.yml gate. See
 * Notion 387637c5-416f-8138 and check-corpus-drift.js.
 *
 * Usage:
 *   node scripts/audit-unknown-outlets.js              # summary, exit 0/1
 *   node scripts/audit-unknown-outlets.js --max=5      # drift threshold (default 5)
 *   node scripts/audit-unknown-outlets.js --strict     # exit 1 on drift (default also 1)
 *   node scripts/audit-unknown-outlets.js --json
 *
 * Exit codes (matches the check-corpus-drift audit contract):
 *   0 — resolvableUnknowns <= max (no drift)
 *   1 — resolvableUnknowns > max (drift)
 *   2 — corpus or registry missing / unreadable (could not run)
 */

const fs = require('fs');
const path = require('path');
const { isRejectedNonReview } = require('./lib/review-guards');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Build the set of valid outlet ids/aliases from the registry, mirroring the
// resolution the rebuild uses (top-level ids + _aliasIndex + per-outlet aliases).
function buildValidOutlets(registry) {
  const valid = new Set(Object.keys(registry.outlets || {}));
  if (registry._aliasIndex) {
    for (const alias of Object.keys(registry._aliasIndex)) {
      if (alias !== '_note') valid.add(alias);
    }
  }
  for (const outlet of Object.values(registry.outlets || {})) {
    if (outlet.aliases) outlet.aliases.forEach((a) => valid.add(a));
  }
  return valid;
}

// Pure: count resolvable unknowns across the review-texts corpus.
// Skips excluded files (duplicateOf/wrongProduction/wrongShow/wrongUrl),
// rejected non-reviews (isRejectedNonReview — ticket-vendor/venue/aggregator
// pages and other garbage the pipeline already excludes from scoring, so
// their outletId never needs a registry entry), and inherently-unresolvable
// ids ("unknown", or >5 hyphens = junk/sentence id).
function countResolvableUnknowns(reviewTextsDir, validOutlets) {
  let resolvableUnknowns = 0;
  let totalFiles = 0;
  const examples = [];

  const showDirs = fs
    .readdirSync(reviewTextsDir)
    .filter((f) => fs.statSync(path.join(reviewTextsDir, f)).isDirectory());

  for (const showDir of showDirs) {
    const files = fs
      .readdirSync(path.join(reviewTextsDir, showDir))
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      totalFiles++;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(reviewTextsDir, showDir, file), 'utf8')
        );
        if (data.duplicateOf || data.wrongProduction || data.wrongShow || data.wrongUrl) continue;
        if (isRejectedNonReview(data)) continue;

        const outletId = (data.outletId || '').toLowerCase();
        const hyphenCount = (outletId.match(/-/g) || []).length;
        if (!outletId || outletId === 'unknown' || hyphenCount > 5) continue;

        if (!validOutlets.has(outletId)) {
          resolvableUnknowns++;
          if (examples.length < 25) examples.push({ showDir, file, outletId });
        }
      } catch (e) {
        // Skip invalid JSON — not this audit's concern.
      }
    }
  }

  return { resolvableUnknowns, totalFiles, examples };
}

function main() {
  const argv = process.argv.slice(2);
  const max = parseMaxArgOrExit(argv, { defaultMax: 5, scriptName: 'audit-unknown-outlets' });
  const asJson = argv.includes('--json');

  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');

  if (!fs.existsSync(reviewTextsDir) || !fs.existsSync(registryPath)) {
    console.error('[audit-unknown-outlets] corpus or registry missing — cannot run.');
    process.exit(2);
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    console.error(`[audit-unknown-outlets] outlet-registry.json unreadable: ${e.message}`);
    process.exit(2);
  }

  const validOutlets = buildValidOutlets(registry);
  const { resolvableUnknowns, totalFiles, examples } = countResolvableUnknowns(
    reviewTextsDir,
    validOutlets
  );

  const drift = resolvableUnknowns > max;

  if (asJson) {
    console.log(JSON.stringify({ resolvableUnknowns, max, totalFiles, drift, examples }, null, 2));
  } else {
    console.log(
      `[audit-unknown-outlets] resolvable unknown outlets: ${resolvableUnknowns} (threshold ${max}) across ${totalFiles} files`
    );
    if (drift) {
      console.log('  Examples (registerable outlet ids absent from outlet-registry.json):');
      for (const ex of examples.slice(0, 15)) {
        console.log(`    ${ex.outletId}  —  ${ex.showDir}/${ex.file}`);
      }
    }
  }

  process.exit(drift ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { buildValidOutlets, countResolvableUnknowns };
