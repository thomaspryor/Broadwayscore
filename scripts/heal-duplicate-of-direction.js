#!/usr/bin/env node
/**
 * heal-duplicate-of-direction.js
 *
 * Driver for scripts/lib/duplicate-direction-heal.js (card #1338). Walks
 * data/review-texts, finds one-directional duplicateOf stamps pointing the
 * wrong way (a named/anchored review stamped duplicateOf an Unknown/
 * unanchored sibling), and reverses them: the wrongly-suppressed file becomes
 * canonical (duplicateOf cleared, duplicateClearReason stamped), and the
 * wrongly-winning file becomes the duplicate (duplicateOf now points at the
 * new canonical).
 *
 * Same write pattern as fix-circular-duplicate-pairs.js: LOAD-MODIFY-SAVE the
 * full object, force:true on both writes (the pair shares a URL, so a
 * non-forced write would immediately re-fire the write-guard's URL-collision
 * detector and re-mark the file a duplicate).
 *
 * Usage:
 *   node scripts/heal-duplicate-of-direction.js                # report (exit 1 if any)
 *   node scripts/heal-duplicate-of-direction.js --json          # JSON report
 *   node scripts/heal-duplicate-of-direction.js --fix            # repair in place
 *   node scripts/heal-duplicate-of-direction.js --show=ID --fix  # scope to one show
 *   REVIEW_TEXTS_DIR=/path node scripts/... --fix                # target a clone
 *
 * Exit codes: 0 = no flips (report) / repaired (--fix); 1 = flips found (report).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { findDirectionFlips } = require('./lib/duplicate-direction-heal');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `heal-duplicate-of-direction.js — Retro-heals wrong-direction duplicateOf stamps (card #1338).

Usage:
  node scripts/heal-duplicate-of-direction.js [options]
  node scripts/heal-duplicate-of-direction.js --help, -h    print this usage and exit

Options:
  --json         machine-readable report
  --fix          repair in place
  --show=ID      scope to a single show directory
`;

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'duplicate-direction-heal.json');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
const showArg = args.find((a) => a.startsWith('--show='));
const SHOW_FILTER = showArg ? showArg.slice('--show='.length) : null;

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_pending')
    .filter((e) => !SHOW_FILTER || e.name === SHOW_FILTER)
    .map((e) => path.join(root, e.name));
}

/** Find all one-directional wrong-direction duplicateOf flips. Returns [{showId, loserFile, winnerFile, reason}]. */
function audit() {
  const results = [];
  for (const showDir of walkShowDirs(REVIEW_TEXTS_DIR)) {
    const showId = path.basename(showDir);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }
    const records = [];
    for (const file of files) {
      try {
        records.push({ file, data: JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8')) });
      } catch { /* unreadable file — skip, other audits catch corrupt JSON */ }
    }
    for (const flip of findDirectionFlips(records)) {
      results.push({ showId, ...flip });
    }
  }
  return results;
}

function fix(flips) {
  let canonicalized = 0, repointed = 0;
  const day = new Date().toISOString().slice(0, 10);
  for (const f of flips) {
    const dir = path.join(REVIEW_TEXTS_DIR, f.showId);
    const newCanonPath = path.join(dir, f.loserFile);
    const newLoserPath = path.join(dir, f.winnerFile);

    // --- The wrongly-suppressed file (loserFile) becomes canonical. ---
    const newCanon = JSON.parse(fs.readFileSync(newCanonPath, 'utf-8'));
    newCanon.duplicateClearReason =
      `heal-duplicate-of-direction.js on ${day}: wrong-direction stamp reversed — this file carries a named/anchored review, ${f.winnerFile} was Unknown/unanchored (${f.reason})`;
    newCanon.duplicateOf = null;
    newCanon.duplicateReason = null;
    // force:true — shares URL with f.winnerFile, so a non-forced write would
    // re-fire the URL-collision detector and immediately re-mark us a duplicate.
    safeWriteReview(newCanonPath, newCanon, { force: true });
    canonicalized++;

    // --- The wrongly-winning file (winnerFile) becomes the duplicate. ---
    const newLoser = JSON.parse(fs.readFileSync(newLoserPath, 'utf-8'));
    newLoser.duplicateOf = f.loserFile;
    newLoser.duplicateReason =
      `heal-duplicate-of-direction.js on ${day}: wrong-direction stamp reversed — ${f.loserFile} carries a named/anchored review this file lacks`;
    newLoser.duplicateClearReason = null; // live duplicate now
    safeWriteReview(newLoserPath, newLoser, { force: true });
    repointed++;
  }
  return { canonicalized, repointed };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const flips = audit();
  if (JSON_OUT) {
    console.log(JSON.stringify({ count: flips.length, flips }, null, 2));
    process.exit(flips.length === 0 ? 0 : 1);
  }
  if (flips.length === 0) {
    console.log('OK: no wrong-direction duplicateOf stamps found');
    process.exit(0);
  }
  console.log(`Found ${flips.length} wrong-direction duplicateOf stamp(s):\n`);
  for (const f of flips) {
    console.log(`  ${f.showId}`);
    console.log(`    now canonical: ${f.loserFile}  (was duplicateOf ${f.winnerFile})`);
    console.log(`    now duplicate: ${f.winnerFile}  → points at ${f.loserFile}`);
  }
  if (FIX) {
    const r = fix(flips);
    try {
      fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
      fs.writeFileSync(AUDIT_PATH, JSON.stringify({
        generated: new Date().toISOString(),
        note: 'Wrong-direction duplicateOf stamps reversed by heal-duplicate-of-direction.js --fix (card #1338).',
        count: flips.length,
        flips,
      }, null, 2) + '\n');
    } catch (e) { console.warn(`[heal-duplicate-of-direction] could not write audit report: ${e.message}`); }
    console.log(`\nCanonicalized ${r.canonicalized}; repointed ${r.repointed} duplicate(s).`);
    console.log('Re-run the rebuild to pick up the corrected direction.');
    process.exit(0);
  }
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { audit, fix, walkShowDirs };
