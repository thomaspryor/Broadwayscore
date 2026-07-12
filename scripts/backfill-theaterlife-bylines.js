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
const { safeRenameReview, safeWriteReview } = require('./lib/review-write-guard');

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
function containment(a, b) {
  const A = wordSet(a), B = wordSet(b);
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
  // (~0.3-0.5); the same review modulo the byline header is ~0.9+.
  if (containment(a.fullText, b.fullText) >= 0.85) return true;
  return false;
}

function main() {
  const phantoms = findPhantomFiles(ROOT);
  const report = { renamed: [], duplicate: [], conflict: [], unparseable: [], errors: [] };

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
      const src = recovered ? 'theaterlife-byline-refetch' : 'theaterlife-byline-backfill';
      const newData = { ...data, criticName: critic, criticEnrichedFrom: src, _priorCriticName: 'Barry Gordin' };
      delete newData.misattributedFullText;
      delete newData.extractedByline;
      delete newData.expectedCritic;
      report.renamed.push({ showId, critic, dstBasename, recovered });
      if (APPLY) {
        const r = safeRenameReview(filePath, dstPath, { newData });
        if (!r.wrote) { report.errors.push({ showId, reason: `rename-${r.skipped}`, dstBasename }); report.renamed.pop(); }
      }
      continue;
    }

    // Sibling exists at the real critic's filename.
    let sib;
    try { sib = JSON.parse(fs.readFileSync(dstPath, 'utf-8')); }
    catch (e) { report.errors.push({ showId, reason: 'sibling-unreadable', error: e.message }); continue; }

    if (sameReview(data, sib)) {
      // DUPLICATE: point the phantom at the real-named sibling; rebuild folds it.
      report.duplicate.push({ showId, critic, dstBasename });
      if (APPLY) {
        const newData = { ...data, duplicateOf: dstBasename, duplicateReason: 'theaterlife-phantom-barry-gordin re-attributed to sibling', criticName: critic, _priorCriticName: 'Barry Gordin' };
        const r = safeWriteReview(filePath, newData, { force: true });
        if (!r.wrote) { report.errors.push({ showId, reason: `dup-write-${r.skipped}`, dstBasename }); report.duplicate.pop(); }
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
  console.log(`  → errors:       ${report.errors.length}`);

  const outPath = path.join('data', 'audit', 'theaterlife-byline-backfill.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`  report: ${outPath}`);
}

main();
