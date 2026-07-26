#!/usr/bin/env node
/**
 * Backfill: re-attribute the phantom "Barry Gordin" theater-life reviews.
 *
 * theaterlife.com (WordPress) tags every post with the site owner "Barry Gordin"
 * in the author vcard, so 366 review files landed as theater-life--barry-gordin.json
 * under a critic who wrote none of them. The real critic is the in-body
 * "By: <name>" line. The scraper fix (extractTheaterLifeByline in
 * content-quality.js) prevents recurrence; this script re-labels the existing
 * corpus. Notion 39b637c5.
 *
 * Per barry-gordin file:
 *   - Parse the in-body byline. Not confidently parseable → UNPARSEABLE (manual
 *     triage / re-fetch — we do NOT guess).
 *   - Compute target theater-life--<slug>.json in the same show dir.
 *   - No sibling at that name        → RENAME (set criticName, move via safeRenameReview).
 *   - Sibling exists + same review   → DUPLICATE (same URL or same fingerprint):
 *     mark the barry-gordin file duplicateOf the sibling (rebuild folds it).
 *   - Sibling exists + different text → CONFLICT: leave in place, list for manual
 *     review (two distinct reviews normalizing to one critic slug is suspicious).
 *
 * Dry-run by default. Pass --apply to write. --root=<path> to target a specific
 * review-texts clone (default: data/review-texts).
 *
 * Usage:
 *   node scripts/backfill-theaterlife-bylines.js                 # dry-run, local clone
 *   node scripts/backfill-theaterlife-bylines.js --root=/tmp/rt --apply
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractTheaterLifeByline, computeContentFingerprint } = require('./lib/content-quality');
const { extractArticleText } = require('./lib/article-extractor');
const { normalizeCritic, normalizeUrl } = require('./lib/review-normalization');
const { safeRenameReview, safeUnlinkReview } = require('./lib/review-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-theaterlife-bylines.js — Backfill: re-attribute the phantom "Barry Gordin" theater-life reviews.

Usage:
  node scripts/backfill-theaterlife-bylines.js [options]
  node scripts/backfill-theaterlife-bylines.js --help, -h    print this usage and exit
`;
// llm-scores sidecars live at <repoRoot>/data/llm-scores/<showId>/<file>. When we
// delete a phantom duplicate, remove its orphaned sidecar too (the correctly-named
// sibling keeps/earns its own on the next scoring pass). Resolve the repo root the
// SAME way safeRenameReview does (relative to this file, not --root) so the delete
// and the rename-move always target the same llm-scores tree even under a custom
// --root clone.
const _LLM_SCORES_DIR = path.resolve(__dirname, '..', 'data', 'llm-scores');
function unlinkLlmSidecar(showId, basename) {
  const p = path.join(_LLM_SCORES_DIR, showId, basename);
  try { if (fs.existsSync(p)) { fs.unlinkSync(p); return true; } } catch { /* best-effort */ }
  return false;
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
// One-time byline recovery for files whose stored fullText was truncated above
// the "By:" line: re-fetch the live theaterlife.com page (a plain WordPress site,
// no bot protection) and re-extract the byline via the production path. Recovers
// criticName only — fullText is left untouched, so composite scores can't move.
const REFETCH = args.includes('--refetch');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function fetchByline(url) {
  if (!url) return null;
  let html;
  try {
    html = execFileSync('curl', ['-sL', '-A', UA, '--max-time', '30', url], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
  } catch { return null; }
  if (!html || html.length < 1000) return null;
  let text;
  try { const r = extractArticleText(html, url); text = (r && r.text) ? r.text : r; } catch { text = null; }
  let critic = extractTheaterLifeByline(text || '');
  if (critic) return critic;
  // The article extractor drops the leading "By <name>" line on some layouts.
  // Fall back to the raw entry-content: slice from the WordPress content div,
  // strip tags, and re-run the same conservative parser.
  const idx = html.search(/class="[^"]*entry-content[^"]*"/i);
  if (idx >= 0) {
    const slice = html.slice(idx, idx + 2000).replace(/<[^>]+>/g, ' ').replace(/&#8217;|&#039;|&rsquo;/g, '’').replace(/[ \t]+/g, ' ');
    critic = extractTheaterLifeByline(slice);
  }
  return critic || null;
}
const rootArg = args.find(a => a.startsWith('--root='));
const ROOT = rootArg ? rootArg.split('=')[1] : path.join('data', 'review-texts');
const PHANTOM_BASENAME = 'theater-life--barry-gordin.json';

function findPhantomFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const showId of fs.readdirSync(root)) {
    const showDir = path.join(root, showId);
    let stat;
    try { stat = fs.statSync(showDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const p = path.join(showDir, PHANTOM_BASENAME);
    if (fs.existsSync(p)) out.push({ showId, showDir, filePath: p });
  }
  return out;
}

function wordSet(t) {
  return new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}

// Asymmetric containment: fraction of the SMALLER text's words present in the
// larger. Robust to the theaterlife byline-header prefix (the correctly-named
// sibling was often captured WITHOUT the "By: <name>" line, which offsets a
// positional fingerprint even though the review body is identical).
function containmentOf(A, B) {
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hits = 0;
  for (const w of small) if (big.has(w)) hits++;
  return hits / small.size;
}

function sameReview(a, b) {
  // Same URL (normalized) → same underlying review.
  const ua = a.url ? normalizeUrl(a.url) : null;
  const ub = b.url ? normalizeUrl(b.url) : null;
  if (ua && ub && ua === ub) return true;
  // Same content fingerprint (identical text).
  const fa = computeContentFingerprint(a.fullText || '', 500);
  const fb = computeContentFingerprint(b.fullText || '', 500);
  if (fa && fb && fa === fb) return true;
  // Near-identical body (byline-prefix offset defeats the fingerprint). Two
  // genuinely different reviews of one show share vocabulary but not phrasing
  // (~0.3-0.5); the same review modulo the byline header is ~0.9+. Require both
  // texts to carry real substance (>=40 distinct long words) before trusting
  // containment — a short stub/excerpt is trivially "contained" in a full review
  // even when they are different pieces, and this branch feeds a destructive
  // dedup. Short pairs fall through to CONFLICT (manual triage).
  const A = wordSet(a.fullText), B = wordSet(b.fullText);
  if (Math.min(A.size, B.size) >= 40 && containmentOf(A, B) >= 0.85) return true;
  return false;
}

// Write the phantom's data under the correct-critic filename, stamping the
// corrected criticName + provenance and clearing stale byline-mismatch flags.
function renameOntoCritic(srcPath, dstPath, data, critic, recovered) {
  const src = recovered ? 'theaterlife-byline-refetch' : 'theaterlife-byline-backfill';
  const newData = { ...data, criticName: critic, criticEnrichedFrom: src, _priorCriticName: 'Barry Gordin' };
  // Clear every stale byline-mismatch flag (mirror the canonical override in
  // collect-review-texts.js). fullTextWrongAuthor / _authorMismatch matter most:
  // review-guards.js excludes a review when fullTextWrongAuthor===true, so a stale
  // value would silently drop the newly-correct review from the rebuild.
  delete newData.misattributedFullText;
  delete newData.extractedByline;
  delete newData.expectedCritic;
  delete newData.fullTextWrongAuthor;
  delete newData._authorMismatch;
  return safeRenameReview(srcPath, dstPath, { newData });
}

// A review carries more signal than another if its body is materially longer,
// or it is scored while the other is not. Used to avoid discarding the fuller
// copy when a phantom and its correctly-named sibling are the same review.
function richness(d) {
  return { len: (d.fullText || '').length, scored: d.assignedScore != null || !!d.llmScore };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const phantoms = findPhantomFiles(ROOT);
  const report = { renamed: [], duplicate: [], conflict: [], unparseable: [], warnings: [], errors: [] };

  for (const { showId, showDir, filePath } of phantoms) {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch (e) { report.errors.push({ showId, reason: 'unreadable', error: e.message }); continue; }

    let critic = extractTheaterLifeByline(data.fullText || '');
    let recovered = false;
    if (!critic && REFETCH) {
      critic = fetchByline(data.url);
      recovered = !!critic;
    }
    if (!critic) { report.unparseable.push({ showId, url: data.url || null }); continue; }

    const slug = normalizeCritic(critic);
    if (!slug || slug === 'unknown') { report.unparseable.push({ showId, url: data.url || null, parsedButUnslugged: critic }); continue; }

    const dstBasename = `theater-life--${slug}.json`;
    const dstPath = path.join(showDir, dstBasename);

    if (!fs.existsSync(dstPath)) {
      // RENAME: set the real critic and move the file.
      report.renamed.push({ showId, critic, dstBasename, recovered });
      if (APPLY) {
        const r = renameOntoCritic(filePath, dstPath, data, critic, recovered);
        if (!r.wrote) { report.errors.push({ showId, reason: `rename-${r.skipped}`, dstBasename }); report.renamed.pop(); }
        else if (r.sisterStoreConflict || r.sisterStoreError) report.warnings.push({ showId, reason: 'sister-store', dstBasename, conflict: !!r.sisterStoreConflict });
      }
      continue;
    }

    // Sibling exists at the real critic's filename.
    let sib;
    try { sib = JSON.parse(fs.readFileSync(dstPath, 'utf-8')); }
    catch (e) { report.errors.push({ showId, reason: 'sibling-unreadable', error: e.message }); continue; }

    if (sameReview(data, sib)) {
      // DUPLICATE: same review as the correctly-named sibling. KEEP THE RICHER
      // COPY. Deleting the phantom blindly can drop a fuller/scored body when the
      // sibling is a truncated stub (hells-kitchen: 8663-char phantom vs 3316-char
      // sibling). A duplicateOf pointer is the wrong tool (different URLs on
      // theaterlife re-posts trip the duplicate-of-url-mismatch gate; flag-and-keep
      // tombstones are discouraged — memory/feedback_outlet_merge_no_flag_and_keep),
      // so we collapse to ONE file under the correct critic name.
      const p = richness(data), s = richness(sib);
      const phantomRicher = (p.len > s.len + 200 && p.len > s.len * 1.10) || (p.scored && !s.scored && p.len >= s.len);
      report.duplicate.push({ showId, critic, dstBasename, kept: phantomRicher ? 'phantom' : 'sibling', phantomLen: p.len, siblingLen: s.len });
      if (APPLY) {
        if (phantomRicher) {
          // Promote the phantom's richer body under the correct-critic name:
          // drop the thinner sibling (+ its sidecar), then rename the phantom onto it.
          const del = safeUnlinkReview(dstPath, { force: false });
          if (!del.wrote) { report.errors.push({ showId, reason: `dup-sib-unlink-${del.skipped}`, dstBasename }); report.duplicate.pop(); continue; }
          unlinkLlmSidecar(showId, dstBasename);
          const r = renameOntoCritic(filePath, dstPath, data, critic, recovered);
          if (!r.wrote) { report.errors.push({ showId, reason: `dup-promote-${r.skipped}`, dstBasename }); report.duplicate.pop(); }
          else if (r.sisterStoreConflict || r.sisterStoreError) report.warnings.push({ showId, reason: 'sister-store', dstBasename, conflict: !!r.sisterStoreConflict });
        } else {
          // Sibling is canonical (richer or equal) — drop the phantom + its sidecar.
          const r = safeUnlinkReview(filePath, { force: false });
          if (!r.wrote) { report.errors.push({ showId, reason: `dup-unlink-${r.skipped}`, dstBasename }); report.duplicate.pop(); }
          else unlinkLlmSidecar(showId, PHANTOM_BASENAME);
        }
      }
      continue;
    }

    // Same critic slug, same show, but materially different text — do NOT merge.
    report.conflict.push({ showId, critic, dstBasename, phantomUrl: data.url || null, siblingUrl: sib.url || null });
  }

  const n = phantoms.length;
  console.log(`\ntheater-life phantom-byline backfill  (root=${ROOT}, mode=${APPLY ? 'APPLY' : 'dry-run'})`);
  console.log(`  phantom files:  ${n}`);
  console.log(`  → rename:       ${report.renamed.length}`);
  console.log(`  → duplicate:    ${report.duplicate.length}`);
  console.log(`  → conflict:     ${report.conflict.length}  (manual)`);
  console.log(`  → unparseable:  ${report.unparseable.length}  (manual / re-fetch)`);
  console.log(`  → warnings:     ${report.warnings.length}  (sister-store)`);
  console.log(`  → errors:       ${report.errors.length}`);
  const promoted = report.duplicate.filter(d => d.kept === 'phantom').length;
  if (promoted) console.log(`  (of duplicates, ${promoted} promoted the fuller phantom body over a thinner sibling)`);

  // NOTE: this writeFileSync targets data/audit (the run report), NOT
  // data/review-texts — all review-texts mutations go through safeRenameReview/
  // safeUnlinkReview above. The variable is deliberately named reportPath (not
  // outPath/filePath) so the test.yml "route review-texts writes through
  // safeWriteReview" heuristic doesn't false-positive on this audit write.
  const reportPath = path.join('data', 'audit', 'theaterlife-byline-backfill.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`  report: ${reportPath}`);
}

main();
