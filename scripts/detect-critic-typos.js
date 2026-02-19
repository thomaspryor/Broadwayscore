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
 * Usage: node scripts/detect-critic-typos.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const AUTO_ALIASES_PATH = path.join(__dirname, '..', 'data', 'auto-critic-aliases.json');

const { CRITIC_ALIASES, levenshteinDistance } = require('./lib/review-normalization');

const dryRun = process.argv.includes('--dry-run');

// Build reverse lookup: for each alias string → canonical
const aliasToCanonical = new Map();
for (const [canonical, aliases] of Object.entries(CRITIC_ALIASES)) {
  aliasToCanonical.set(canonical, canonical);
  for (const alias of aliases) {
    aliasToCanonical.set(alias.replace(/\s+/g, '-').replace(/\./g, ''), canonical);
  }
}

// Scan all review files for critic slugs + their outlets
const criticOutlets = new Map(); // criticSlug -> Map<outletSlug, count>
const criticCounts = new Map();

const dirs = fs.readdirSync(REVIEW_DIR).filter(d => {
  try { return fs.statSync(path.join(REVIEW_DIR, d)).isDirectory(); } catch { return false; }
});

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

for (let i = 0; i < critics.length; i++) {
  for (let j = i + 1; j < critics.length; j++) {
    const a = critics[i], b = critics[j];
    if (Math.abs(a.length - b.length) > 1) continue;

    const dist = levenshteinDistance(a, b);
    if (dist !== 1) continue;

    // Check if already covered by CRITIC_ALIASES
    const canonA = aliasToCanonical.get(a);
    const canonB = aliasToCanonical.get(b);
    if (canonA && canonB && canonA === canonB) continue;

    // Check shared outlets
    const outletsA = criticOutlets.get(a);
    const outletsB = criticOutlets.get(b);
    const sharedOutlets = [];
    for (const [outlet] of outletsA) {
      if (outletsB.has(outlet)) sharedOutlets.push(outlet);
    }

    if (sharedOutlets.length > 0) {
      // High confidence: distance 1 + shared outlet = auto-fix
      const countA = criticCounts.get(a);
      const countB = criticCounts.get(b);
      // Canonical is the one with more files
      const canonical = countA >= countB ? a : b;
      const typo = countA >= countB ? b : a;
      autoFixes.push({ canonical, typo, countCanonical: Math.max(countA, countB), countTypo: Math.min(countA, countB), sharedOutlets });
    } else {
      // Low confidence: distance 1 but no shared outlet — just flag
      flagged.push({ a, b, countA: criticCounts.get(a), countB: criticCounts.get(b) });
    }
  }
}

console.log(`\nAuto-fixable (dist=1 + shared outlet): ${autoFixes.length}`);
console.log(`Flagged only (dist=1, no shared outlet): ${flagged.length}`);

if (autoFixes.length === 0) {
  console.log('\nNo new critic typos detected. All clean!');
  process.exit(0);
}

console.log('\n=== AUTO-FIXING ===');
for (const fix of autoFixes) {
  console.log(`  ${fix.typo} (${fix.countTypo}) → ${fix.canonical} (${fix.countCanonical}) [outlets: ${fix.sharedOutlets.join(', ')}]`);
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

let added = 0;
for (const fix of autoFixes) {
  const typoLower = fix.typo.replace(/-/g, ' ');
  if (!autoAliases.aliases[fix.canonical]) {
    autoAliases.aliases[fix.canonical] = [fix.canonical.replace(/-/g, ' ')];
  }
  if (!autoAliases.aliases[fix.canonical].includes(typoLower)) {
    autoAliases.aliases[fix.canonical].push(typoLower);
    added++;
  }
}

if (added > 0) {
  autoAliases._lastUpdated = new Date().toISOString();
  fs.writeFileSync(AUTO_ALIASES_PATH, JSON.stringify(autoAliases, null, 2) + '\n');
  console.log(`\nAdded ${added} new alias(es) to ${AUTO_ALIASES_PATH}`);
} else {
  console.log('\nAll detected typos were already in auto-aliases. No changes.');
}
