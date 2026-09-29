#!/usr/bin/env node
/**
 * Auto-detect critic name typos via Levenshtein similarity.
 *
 * Finds distance-1 critic slug pairs that share at least one outlet,
 * which are virtually always typos. Adds confirmed pairs to
 * data/auto-critic-aliases.json so they're merged into CRITIC_ALIASES
 * at load time and caught by both write-time and cleanup-time normalization.
 *
 * Safety: only auto-fixes distance-1 same-outlet pairs. Distance-2 or
 * no-shared-outlet pairs are logged but not auto-fixed.
 *
 * Canonical choice (audit S7-T5, scripts/lib/critic-alias-picker.js): a
 * candidate already in the alias table resolves to ITS canonical — the picker
 * never writes a canonical that is itself an alias elsewhere; then the
 * registry spelling (outlet-registry defaultCritic / critic-registry key);
 * then file count. Pairs that differ only in a digit are never typos.
 *
 * Usage: node scripts/detect-critic-typos.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

// REVIEW_TEXTS_DIR lets a test point the scan at a fixture tree (audit S7-T5).
const REVIEW_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const AUTO_ALIASES_PATH = path.join(__dirname, '..', 'data', 'auto-critic-aliases.json');

const { CRITIC_ALIASES, levenshteinDistance, loadOutletRegistry, loadCriticRegistry } = require('./lib/review-normalization');
const { buildAliasIndex, buildRegistrySpellings, buildOutletSlugs, pickCanonical, recordAlias } = require('./lib/critic-alias-picker');

const dryRun = process.argv.includes('--dry-run');

// Reverse lookup (alias string → canonical), with alias-of-another-canonical
// keys and two-way conflicts resolved by the picker rather than by iteration order.
const aliasIndex = buildAliasIndex(CRITIC_ALIASES);
const outletRegistry = loadOutletRegistry();
const registrySpellings = buildRegistrySpellings({
  outletRegistry,
  criticRegistry: loadCriticRegistry(),
});
const outletSlugs = buildOutletSlugs(outletRegistry);

// Scan all review files for critic slugs + their outlets
const criticOutlets = new Map(); // criticSlug -> Map<outletSlug, count>
const criticCounts = new Map();

const dirs = listShowDirs(REVIEW_DIR);

for (const showId of dirs) {
  const files = fs.readdirSync(path.join(REVIEW_DIR, showId))
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  for (const file of files) {
    const base = file.replace('.json', '');
    const idx = base.indexOf('--');
    if (idx === -1) continue;
    const outlet = base.substring(0, idx);
    const critic = base.substring(idx + 2);
    if (!critic || critic === 'unknown' || critic.length < 3) continue;

    criticCounts.set(critic, (criticCounts.get(critic) || 0) + 1);
    if (!criticOutlets.has(critic)) criticOutlets.set(critic, new Map());
    const outlets = criticOutlets.get(critic);
    outlets.set(outlet, (outlets.get(outlet) || 0) + 1);
  }
}

const critics = Array.from(criticCounts.keys()).sort();
console.log(`Scanned ${critics.length} unique critic slugs`);

// Find distance-1 pairs that share an outlet and aren't already aliased
const autoFixes = [];
const flagged = [];
const skipped = [];

for (let i = 0; i < critics.length; i++) {
  for (let j = i + 1; j < critics.length; j++) {
    const a = critics[i], b = critics[j];
    if (Math.abs(a.length - b.length) > 1) continue;

    const dist = levenshteinDistance(a, b);
    if (dist !== 1) continue;

    const countA = criticCounts.get(a);
    const countB = criticCounts.get(b);
    const pick = pickCanonical({ a, b, countA, countB, aliasIndex, registrySpellings, outletSlugs });
    // Already covered by CRITIC_ALIASES (same canonical) — nothing to report.
    if (pick.skip && pick.silent) continue;

    // Check shared outlets
    const outletsA = criticOutlets.get(a);
    const outletsB = criticOutlets.get(b);
    const sharedOutlets = [];
    for (const [outlet] of outletsA) {
      if (outletsB.has(outlet)) sharedOutlets.push(outlet);
    }

    if (sharedOutlets.length === 0) {
      // Low confidence: distance 1 but no shared outlet — just flag
      flagged.push({ a, b, countA, countB });
    } else if (pick.skip) {
      // High-confidence pair the picker refuses to decide (digit-only
      // difference, conflicting alias-table entries) — a human resolves it.
      skipped.push({ a, b, countA, countB, reason: pick.reason, sharedOutlets });
    } else {
      // High confidence: distance 1 + shared outlet = auto-fix
      const { canonical, typo } = pick;
      autoFixes.push({
        canonical, typo, reason: pick.reason,
        countCanonical: canonical === a ? countA : countB,
        countTypo: typo === a ? countA : countB,
        sharedOutlets,
      });
    }
  }
}

console.log(`\nAuto-fixable (dist=1 + shared outlet): ${autoFixes.length}`);
console.log(`Flagged only (dist=1, no shared outlet): ${flagged.length}`);
console.log(`Skipped by the picker (dist=1 + shared outlet, needs a human): ${skipped.length}`);
for (const s of skipped) {
  console.log(`  ${s.a} (${s.countA}) ~ ${s.b} (${s.countB}) — ${s.reason} [outlets: ${s.sharedOutlets.join(', ')}]`);
}

if (autoFixes.length === 0) {
  console.log('\nNo new critic typos detected. All clean!');
  process.exit(0);
}

console.log('\n=== AUTO-FIXING ===');
for (const fix of autoFixes) {
  console.log(`  ${fix.typo} (${fix.countTypo}) → ${fix.canonical} (${fix.countCanonical}) [outlets: ${fix.sharedOutlets.join(', ')}] (${fix.reason})`);
}

if (flagged.length > 0) {
  console.log('\n=== FLAGGED (not auto-fixed) ===');
  for (const f of flagged) {
    console.log(`  ${f.a} (${f.countA}) ~ ${f.b} (${f.countB})`);
  }
}

if (dryRun) {
  console.log('\n*** DRY RUN — no changes made ***');
  process.exit(0);
}

// Load existing auto-aliases file
let autoAliases;
try {
  autoAliases = JSON.parse(fs.readFileSync(AUTO_ALIASES_PATH, 'utf8'));
} catch {
  autoAliases = { aliases: {} };
}

if (!autoAliases.aliases || typeof autoAliases.aliases !== 'object') autoAliases.aliases = {};

let added = 0;
for (const fix of autoFixes) {
  // recordAlias never creates a key that is an alias of another key and never
  // re-claims a typo string another key already owns (audit S7-T5).
  const result = recordAlias(autoAliases.aliases, fix.canonical, fix.typo);
  if (result.added) {
    added++;
    if (result.target !== fix.canonical) {
      console.log(`  (routed ${fix.typo} → ${result.target}: ${fix.canonical} is an alias of it)`);
    }
  } else if (result.reason && result.reason !== 'already present') {
    console.log(`  (not recorded ${fix.typo} → ${fix.canonical}: ${result.reason})`);
  }
}

if (added > 0) {
  autoAliases._lastUpdated = new Date().toISOString();
  fs.writeFileSync(AUTO_ALIASES_PATH, JSON.stringify(autoAliases, null, 2) + '\n');
  console.log(`\nAdded ${added} new alias(es) to ${AUTO_ALIASES_PATH}`);
} else {
  console.log('\nAll detected typos were already in auto-aliases. No changes.');
}
