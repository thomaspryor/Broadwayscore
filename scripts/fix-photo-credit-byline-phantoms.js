#!/usr/bin/env node
/**
 * fix-photo-credit-byline-phantoms.js
 *
 * One-time remediation for the BWW roundup photo-credit byline bug.
 *
 * Root cause (fixed in scripts/lib/bww-roundup-parser.js, 2026-08-01): BWW's
 * articleBody separates entries with a RUN of whitespace, and the critic-name
 * regex's `\s+` word separator spanned it — so the last token before the run
 * (in practice, the PHOTOGRAPHER's surname from "Photo credit: Mark Senior")
 * was absorbed as the next critic's first name. The resulting record carried a
 * mangled byline and, having no URL, could not be collapsed by same-URL dedup —
 * so the same review was counted twice.
 *
 * Live damage found by the corpus sweep (3 files, all BroadwayWorld):
 *   the-comedy-about-spies-west-end-2026  "Senior     Franco Milazzo"
 *   inter-alia-west-end-2026              "Harlan     Clementine Scott"
 *   stranger-things-...-west-end-2023     "Harlan     Alexander Cohen"
 * ("Mark Senior" and "Manuel Harlan" are West End production photographers.)
 *
 * Two shapes, two remedies:
 *   A. Phantom has NO url and a same-outlet twin that DOES  -> the phantom is a
 *      redundant second slot for one review. Point duplicateOf at the twin so
 *      rebuild folds it away.
 *   B. Phantom IS the canonical record (holds the url/text/score) and the clean
 *      twin already points at it -> only the DISPLAY NAME is wrong. Repair
 *      criticName in place. Renaming would collide with the existing clean
 *      filename and risks a self-referential duplicate pointer
 *      (memory/feedback_self_referential_duplicate_pointers.md).
 *
 * Idempotent: re-running finds nothing to do. --dry-run by default.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`Usage: node scripts/fix-photo-credit-byline-phantoms.js [--apply]

Repairs review-text files whose criticName contains a whitespace RUN that
absorbed a photographer surname from a BWW roundup photo credit.

  (no flags)  dry run — report only
  --apply     write the fixes
`);
  process.exit(0);
}

const APPLY = process.argv.includes('--apply');
// WRITES under --apply (safeWriteReview repairs criticName / duplicateOf) —
// see scripts/lib/review-texts-dir.js.
const ROOT = resolveReviewTextsDir();
console.log(`[fix-photo-credit-byline-phantoms] review-texts: ${ROOT}`);

/** Tail after a 2+ whitespace run, when that tail is itself a full name. */
function blockBoundaryTail(name) {
  if (typeof name !== 'string' || !/\s{2,}/.test(name)) return null;
  const tail = name.split(/\s{2,}/).pop().trim();
  return /^\S+(\s+\S+)+$/.test(tail) ? tail : null;
}

function listShowDirs(root) {
  return fs.readdirSync(root).filter(d => {
    try { return fs.statSync(path.join(root, d)).isDirectory() && !d.startsWith('_'); }
    catch { return false; }
  });
}

let scanned = 0;
const actions = [];

for (const show of listShowDirs(ROOT)) {
  const dir = path.join(ROOT, show);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }

  const recs = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (d && typeof d === 'object') recs.push({ f, d });
  }
  scanned += recs.length;

  for (const { f, d } of recs) {
    const clean = blockBoundaryTail(d.criticName);
    if (!clean) continue;

    const twin = recs.find(r =>
      r.f !== f &&
      r.d.outletId === d.outletId &&
      (r.d.criticName || '').trim() === clean
    );

    // Shape A: phantom is the redundant slot (no url) and the twin holds the url.
    if (twin && !d.url && twin.d.url && d.duplicateOf !== twin.f) {
      actions.push({
        show, file: f, kind: 'mark-duplicate', clean,
        patch: {
          duplicateOf: twin.f,
          duplicateReason: 'photo-credit-byline-phantom (bww-roundup-parser whitespace-run bug, fixed 2026-08-01)',
          criticName: clean,
        },
      });
      continue;
    }

    // Shape B: phantom is canonical — repair the display name only.
    actions.push({
      show, file: f, kind: 'rename-byline', clean,
      patch: {
        criticName: clean,
        criticNameCorrectedFrom: d.criticName,
        criticNameCorrectedReason: 'photo-credit-byline-phantom (bww-roundup-parser whitespace-run bug, fixed 2026-08-01)',
      },
    });
  }
}

console.log(`Scanned ${scanned} review files under ${ROOT}`);
console.log(`Phantom bylines needing repair: ${actions.length}\n`);

for (const a of actions) {
  console.log(`[${a.kind}] ${a.show}/${a.file}`);
  console.log(`    -> criticName: ${JSON.stringify(a.clean)}`);
  if (a.patch.duplicateOf) console.log(`    -> duplicateOf: ${a.patch.duplicateOf}`);
}

if (!APPLY) {
  console.log('\nDRY RUN — re-run with --apply to write.');
  process.exit(0);
}

let written = 0;
for (const a of actions) {
  const p = path.join(ROOT, a.show, a.file);
  const existing = JSON.parse(fs.readFileSync(p, 'utf8'));
  const res = safeWriteReview(p, { ...existing, ...a.patch }, { merge: true });
  if (res === false) {
    console.error(`  ✗ write guard refused: ${a.show}/${a.file}`);
    continue;
  }
  written++;
}
console.log(`\nWrote ${written}/${actions.length} file(s).`);
