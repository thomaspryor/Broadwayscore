#!/usr/bin/env node
/**
 * One-shot: clear 8 wrongProduction FPs on WE long-runners.
 * Identified 2026-04-24 via CV-reasoning probe. CV itself said each is a
 * "valid / genuine / legitimate review" of the correct WE production —
 * flagged only because of venue-name drift (Her→His Majesty's), pre-2021
 * opening-era reviews (the showId has a 2021 suffix but openingDate is
 * 1999/1952), or severely-truncated content that CV couldn't fully verify.
 *
 * Sets wrongProductionOverride:true + reason. PROTECTED_FIELDS must include
 * wrongProductionOverride for this to survive rebase — verified present in
 * scripts/lib/review-write-guard.js PROTECTED_FIELDS 2026-04-24.
 *
 * Run from main (not worktree) so review-texts symlink resolves:
 *   node scripts/clear-we-longrunner-fps-2026-04-24.js --dry-run
 *   node scripts/clear-we-longrunner-fps-2026-04-24.js --apply
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = args.includes('--dry-run') || !apply;

const TARGETS = [
  // [showSlug, filename, note]
  ['the-phantom-of-the-opera-west-end-1986', 'london-theatre--theo-bosanquet.json',
    'FP: CV says "genuine review of Phantom of the Opera at a West End venue"; flagged on Her/His Majesty\'s venue-name drift (renamed Sept 2022)'],
  ['the-phantom-of-the-opera-west-end-1986', 'musical-theatre-review--unknown.json',
    'FP: CV says "legitimate review of The Phantom of the Opera West End production from 2021 at Her Majesty\'s Theatre (now His Majesty\'s)"'],
  ['the-phantom-of-the-opera-west-end-1986', 'telegraph--claire-allfree.json',
    'FP: CV says "genuine review of The Phantom of the Opera at a West End venue"; flagged on Her/His Majesty\'s venue-name drift'],
  ['the-phantom-of-the-opera-west-end-1986', 'west-end-wilma--west-end.json',
    'FP: CV says "valid review of The Phantom of the Opera West End production ... describes the original long-running production"'],
  ['les-miserables-west-end-2021', 'the-sun--dominic-maxwell.json',
    'FP: CV says "valid review of the West End production of Les Misérables at the Sondheim Theatre, with matching cast"; flagged on truncation, not wrong-production'],
  ['the-mousetrap-west-end-2021', 'guardian--arifa-akbar.json',
    'FP: CV says "genuine review of The Mousetrap"; Mousetrap has run continuously since 1952 (Ambassadors→St Martin\'s 1974); same production'],
  ['mamma-mia-west-end-2021', 'variety--matt-wolf.json',
    'FP: CV says "legitimate review of Mamma Mia! at a West End venue"; Mamma Mia has run continuously since 1999 opening referenced in the review content'],
  ['mamma-mia-west-end-2021', 'variety--owen-gleiberman.json',
    'FP: CV says "legitimate review of the West End Mamma Mia! production"; Owen Gleiberman\'s 1999 opening review of the continuously-running production'],
];

// Resolve data/review-texts via main repo path. Worktrees don't carry the
// directory (main has the private-repo-backed files). See memory:
// feedback_worktree_script_data_paths.md.
const MAIN_REPO = '/Users/tompryor/Broadwayscore';
const REVIEW_TEXTS_DIR = path.join(MAIN_REPO, 'data', 'review-texts');

let cleared = 0;
let missing = 0;
let alreadyCleared = 0;
const actions = [];

for (const [slug, file, note] of TARGETS) {
  const fp = path.join(REVIEW_TEXTS_DIR, slug, file);
  if (!fs.existsSync(fp)) {
    missing++;
    console.log(`[MISSING] ${slug}/${file}`);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (d.wrongProductionOverride === true) {
    alreadyCleared++;
    console.log(`[SKIP-already-cleared] ${slug}/${file}`);
    continue;
  }
  if (d.wrongProduction !== true) {
    alreadyCleared++;
    console.log(`[SKIP-not-flagged] ${slug}/${file} wp=${d.wrongProduction}`);
    continue;
  }
  actions.push({ fp, slug, file, note, d });
}

if (dryRun) {
  console.log('\n=== DRY RUN ===');
  console.log(`Would clear: ${actions.length}`);
  console.log(`Missing: ${missing}`);
  console.log(`Already cleared / not flagged: ${alreadyCleared}`);
  for (const { slug, file, note } of actions) {
    console.log(` - ${slug}/${file}`);
    console.log(`     ${note}`);
  }
  console.log('\nRun with --apply to persist.');
  process.exit(0);
}

for (const { fp, slug, file, note, d } of actions) {
  d.wrongProductionOverride = true;
  d.wrongProductionOverrideReason = note;
  d.wrongProductionOverrideSetAt = new Date().toISOString();
  d.wrongProductionOverrideSetBy = 'clear-we-longrunner-fps-2026-04-24';
  // Ensure rebuild sees override by ensuring the protected list carries it
  // (rebuild respects wrongProductionOverride per review-guards.js).
  const json = JSON.stringify(d, null, 2) + '\n';
  fs.writeFileSync(fp, json);
  cleared++;
  console.log(`[CLEARED] ${slug}/${file}`);
}

console.log(`\nCleared ${cleared}, missing ${missing}, already-cleared ${alreadyCleared}`);
