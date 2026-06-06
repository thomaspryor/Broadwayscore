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
const INCLUDE_DIFF_URL = args.includes('--include-diff-url');
// Optional but recommended: tie every deletion to the independent 2-model
// content verification. Only rows the verifier marked decision='confirmed-to'
// (the review IS about the TO show) are eligible — this is the strongest
// same-article + correct-attribution guarantee and closes the theoretical
// holes in the heuristic same-article checks (filename collision, boilerplate
// overlap FP). ship-check Codex 2026-06-06.
const VERIFIED = flag('verified', '');
let confirmedSet = null;
if (VERIFIED) {
  if (!fs.existsSync(VERIFIED)) { console.error(`--verified file not found: ${VERIFIED}`); process.exit(1); }
  const vf = JSON.parse(fs.readFileSync(VERIFIED, 'utf8')).findings || [];
  confirmedSet = new Set(vf
    .filter(f => f.verifierVerdict && f.verifierVerdict.decision === 'confirmed-to')
    .map(f => `${f.from}|${f.to}|${f.file}`));
  console.log(`Verified gate: ${confirmedSet.size} confirmed-to rows loaded from ${path.basename(VERIFIED)}`);
}
// Candidate source. Default: the apply script's deferred dest-exists lists.
// --candidates-from-whitelist: instead take every confirmed-to row from the
// --verified whitelist (used for the flagged/Class-C set, which the apply
// script's warnings-gate + matcher stale-guard intentionally block — the
// 2-model content verdict is the authority for those, not the matcher). The
// per-row dest-exists + same-article + no-content-loss checks below still
// apply, and dest-not-exists rows are skipped as 'to-missing' (those are moves,
// handled by the apply script, not here).
const FROM_WHITELIST = args.includes('--candidates-from-whitelist');
let candidates;
if (FROM_WHITELIST) {
  if (!confirmedSet) { console.error('--candidates-from-whitelist requires --verified=PATH'); process.exit(1); }
  const vf = JSON.parse(fs.readFileSync(VERIFIED, 'utf8')).findings || [];
  candidates = vf
    .filter(f => f.confirm === true && f.verifierVerdict && f.verifierVerdict.decision === 'confirmed-to')
    .map(f => ({ from: f.from, to: f.to, file: f.file, set: 'verified-whitelist' }));
} else {
  const deferredObj = JSON.parse(fs.readFileSync(DEFERRED, 'utf8'));
  candidates = (deferredObj.orphanDeleteCandidates || []).map(c => ({ ...c, set: 'orphan' }));
  if (INCLUDE_DIFF_URL) candidates = candidates.concat((deferredObj.unresolvedDiffUrl || []).map(c => ({ ...c, set: 'diff-url' })));
}
if (!candidates.length) { console.log('No candidates.'); process.exit(0); }

const textLen = r => String(r.fullText || r.reviewText || '').length;
// Word-shingle overlap (8-grams) — used to confirm two files are the SAME
// review when their URL fields differ (review discovered via roundup-url vs
// direct-url). Returns null when either text is too short to compare.
function textOverlap(a, b) {
  const tok = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const A = tok(a), B = tok(b);
  if (A.length < 8 || B.length < 8) return null;
  const sb = new Set();
  for (let i = 0; i + 8 <= B.length; i++) sb.add(B.slice(i, i + 8).join(' '));
  let hit = 0, tot = 0;
  for (let i = 0; i + 8 <= A.length; i++) { tot++; if (sb.has(A.slice(i, i + 8).join(' '))) hit++; }
  return tot ? Math.round(100 * hit / tot) : 0;
}

console.log(`Mode: ${APPLY ? 'APPLY (deleting)' : 'DRY-RUN'} | review-texts: ${REVIEW_TEXTS_DIR}`);
console.log(`Orphan candidates: ${candidates.length}\n`);

const res = { deleted: 0, deferred: 0, skipped: 0 };
const deferredRows = [];

for (const c of candidates) {
  const fromPath = path.join(REVIEW_TEXTS_DIR, c.from, c.file);
  const toPath = path.join(REVIEW_TEXTS_DIR, c.to, c.file);
  if (!fs.existsSync(fromPath)) { res.skipped++; console.log(`  [SKIP from-missing] ${c.from}/${c.file}`); continue; }
  if (!fs.existsSync(toPath)) { res.skipped++; console.log(`  [SKIP to-missing — TO copy gone, not an orphan] ${c.from}/${c.file}`); continue; }

  if (confirmedSet && !confirmedSet.has(`${c.from}|${c.to}|${c.file}`)) {
    res.deferred++; deferredRows.push({ ...c, reason: 'not a 2-model confirmed-to row — excluded by --verified gate' });
    console.log(`  [DEFER not-verified] ${c.from}/${c.file}`);
    continue;
  }

  const F = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
  const T = JSON.parse(fs.readFileSync(toPath, 'utf8'));

  // Re-confirm same article by requiring a POSITIVE shared-URL signal between
  // FROM and TO across any of the url fields (own url, BWW roundup, PV). A bare
  // empty-text FROM is NOT sufficient proof — two unrelated reviews can share an
  // outlet--critic filename, and an empty FROM next to a wrong-stub TO would
  // otherwise be deleted (ship-check Codex 2026-05-30). No shared URL → defer.
  const urlFields = r => [r.url, r.bwwRoundupUrl, r.playbillVerdictUrl].filter(Boolean);
  const fUrls = urlFields(F), tUrls = urlFields(T);
  const sharedUrl = fUrls.some(u => tUrls.includes(u));
  // Same-article proof, strongest first:
  //   1. a shared URL field, OR
  //   2. high text-shingle overlap (>=85%) when both have text (covers the
  //      roundup-url-vs-direct-url duplicate where URL fields differ), OR
  //   3. an EMPTY FROM stub while TO holds a real review (>300ch) from the same
  //      outlet--critic filename — the FROM is a redundant wrong-show stub.
  const ov = textOverlap(F.fullText || F.reviewText, T.fullText || T.reviewText);
  const sameArticle = sharedUrl
    || (ov != null && ov >= 85)
    || (textLen(F) === 0 && textLen(T) > 300);
  if (!sameArticle) {
    res.deferred++; deferredRows.push({ ...c, reason: `not provably same article (sharedUrl=${sharedUrl}, overlap=${ov}, fromLen=${textLen(F)}, toLen=${textLen(T)})` });
    console.log(`  [DEFER not-same-article] ${c.from}/${c.file} (sharedUrl=${sharedUrl} ov=${ov} F=${textLen(F)} T=${textLen(T)})`);
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
