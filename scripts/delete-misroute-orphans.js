#!/usr/bin/env node
/**
 * Delete redundant misrouted review COPIES (the dest-exists orphan sub-task).
 *
 * Input: the deferred file written by apply-slug-misroute-whitelist.js, whose
 * `orphanDeleteCandidates` are rows where the matcher's TO show ALREADY holds a
 * copy of this review (the FROM copy is a redundant duplicate sitting on the
 * WRONG show). These were already content-verified (2-model) as belonging to
 * the TO show, so the FROM copy is genuinely misrouted.
 *
 * SAFETY RULE — only delete the FROM copy when there is NO content loss:
 *   delete iff TO copy exists AND length(TO.fullText) >= length(FROM.fullText).
 * If the FROM copy is the LONGER/better one (TO is a stub), we do NOT delete —
 * that is a keep-better / merge decision for a human, not a blind unlink.
 *
 * Uses safeUnlinkReview (honors _locked, cascade-clears duplicateOf refs). The
 * llm-scores sidecar is a gitignored cache the rebuild does not read, so it is
 * left in place; deleting the review-texts file is what corrects the live site.
 *
 * Dry-run default. Pass --apply to actually delete. Run inside the gated
 * runbook (disable crons -> snapshot tag -> --apply -> push -> rebuild).
 */

const fs = require('fs');
const path = require('path');
const { safeUnlinkReview } = require('./lib/review-write-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const flag = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DEFERRED = flag('deferred', path.join(process.env.HOME || '', 'Documents/claude-outputs/apply-slug-misroute-deferred.json'));
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(process.env.HOME || '/tmp', 'broadway-review-texts');

if (!fs.existsSync(DEFERRED)) { console.error(`Deferred file not found: ${DEFERRED}`); process.exit(1); }
const candidates = (JSON.parse(fs.readFileSync(DEFERRED, 'utf8')).orphanDeleteCandidates) || [];
if (!candidates.length) { console.log('No orphan-delete candidates.'); process.exit(0); }

const textLen = r => String(r.fullText || r.reviewText || '').length;

console.log(`Mode: ${APPLY ? 'APPLY (deleting)' : 'DRY-RUN'} | review-texts: ${REVIEW_TEXTS_DIR}`);
console.log(`Orphan candidates: ${candidates.length}\n`);

const res = { deleted: 0, deferred: 0, skipped: 0 };
const deferredRows = [];

for (const c of candidates) {
  const fromPath = path.join(REVIEW_TEXTS_DIR, c.from, c.file);
  const toPath = path.join(REVIEW_TEXTS_DIR, c.to, c.file);
  if (!fs.existsSync(fromPath)) { res.skipped++; console.log(`  [SKIP from-missing] ${c.from}/${c.file}`); continue; }
  if (!fs.existsSync(toPath)) { res.skipped++; console.log(`  [SKIP to-missing — TO copy gone, not an orphan] ${c.from}/${c.file}`); continue; }

  const F = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
  const T = JSON.parse(fs.readFileSync(toPath, 'utf8'));

  // Re-confirm same article by requiring a POSITIVE shared-URL signal between
  // FROM and TO across any of the url fields (own url, BWW roundup, PV). A bare
  // empty-text FROM is NOT sufficient proof — two unrelated reviews can share an
  // outlet--critic filename, and an empty FROM next to a wrong-stub TO would
  // otherwise be deleted (ship-check Codex 2026-05-30). No shared URL → defer.
  const urlFields = r => [r.url, r.bwwRoundupUrl, r.playbillVerdictUrl].filter(Boolean);
  const fUrls = urlFields(F), tUrls = urlFields(T);
  const sameArticle = fUrls.some(u => tUrls.includes(u));
  if (!sameArticle) {
    res.deferred++; deferredRows.push({ ...c, reason: 'no shared URL between FROM and TO — verify same article manually' });
    console.log(`  [DEFER no-shared-url] ${c.from}/${c.file} (FROM ${textLen(F)}ch; no url field matches TO)`);
    continue;
  }

  // No-content-loss rule: TO must be at least as complete as FROM.
  if (textLen(F) > textLen(T)) {
    res.deferred++; deferredRows.push({ ...c, reason: `FROM longer (${textLen(F)}) than TO (${textLen(T)}) — keep-better/merge, do not blind-delete` });
    console.log(`  [DEFER from-better] ${c.from}/${c.file} (FROM ${textLen(F)} > TO ${textLen(T)})`);
    continue;
  }

  if (!APPLY) {
    res.deleted++;
    console.log(`  [WOULD-DELETE] ${c.from}/${c.file}  (dup of ${c.to}/, TO ${textLen(T)}ch >= FROM ${textLen(F)}ch)`);
    continue;
  }

  const r = safeUnlinkReview(fromPath);
  if (r.wrote && r.unlinked) { res.deleted++; console.log(`  [DELETED] ${c.from}/${c.file}  (redundant; correct copy stays in ${c.to}/)`); }
  else { res.skipped++; console.log(`  [SKIP ${r.skipped || 'unknown'}] ${c.from}/${c.file}`); }
}

console.log(`\n=== Summary ===`);
console.log(`  ${APPLY ? 'Deleted' : 'Would delete'}: ${res.deleted}`);
console.log(`  Deferred (human): ${res.deferred}`);
console.log(`  Skipped: ${res.skipped}`);
if (deferredRows.length) {
  const out = path.join(path.dirname(DEFERRED), 'orphan-delete-deferred.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), deferred: deferredRows }, null, 2));
  console.log(`  Deferred rows -> ${out}`);
}
if (!APPLY) console.log('\nDry-run. Re-run with --apply to delete.');
