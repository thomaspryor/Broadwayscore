#!/usr/bin/env node
/**
 * BRO-4403 audit + sweep: review files whose `url` holds "&amp;" or whose
 * fullText starts with a leaked <img>. Default = audit (exit 1 if any found).
 *   --apply          rewrite through safeWriteReview (the write chokepoint)
 *   --requeue-out=F  write show:file list of non-complete, non-flagged swept files
 *   REVIEW_TEXTS_DIR overrides the corpus root (default data/review-texts)
 */
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { sanitizeReviewRecord } = require('./lib/review-url-entity-decode');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const KEEP_FIELDS = ['duplicateOf', 'duplicateReason', 'duplicateClearReason', 'duplicateTextOf', 'tierReason'];
const apply = process.argv.includes('--apply');
const requeueArg = process.argv.find((a) => a.startsWith('--requeue-out='));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.json') && e.name !== 'failed-fetches.json') yield p;
  }
}

function findIssues(data) {
  const issues = [];
  const s = sanitizeReviewRecord(data);
  if (s !== data) {
    if (s.url !== data.url) issues.push('url-entity');
    if (s.fullText !== data.fullText) issues.push('leading-img');
  }
  return issues;
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('sweep-review-url-entities.js [--apply] [--requeue-out=FILE] [--reset-from=TSV]  (audit by default; REVIEW_TEXTS_DIR overrides corpus root)');
    process.exit(0);
  }
  if (!fs.existsSync(DIR)) { console.error(`FAIL: corpus root missing: ${DIR}`); process.exit(1); }
  let scanned = 0; const hits = []; const failed = []; const requeue = [];
  for (const file of walk(DIR)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    scanned++;
    const issues = findIssues(data);
    if (!issues.length) continue;
    hits.push({ file, issues, tier: data.contentTier, flagged: !!(data.wrongProduction || data.wrongShow || data.isRoundupArticle) });
    if (!apply) continue;
    const r = safeWriteReview(file, sanitizeReviewRecord(data), { merge: true });
    if (!r.wrote) { failed.push({ file, skipped: r.skipped }); continue; }
    let after = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The guard's URL-collision/stale-duplicateOf heuristics can fire on any
    // write; a URL-cosmetics sweep must not change duplicate state (or tier
    // reason). Restore those fields to their pre-sweep values.
    let restored = false;
    for (const k of KEEP_FIELDS) {
      if (JSON.stringify(after[k]) !== JSON.stringify(data[k])) {
        restored = true;
        if (k in data) after[k] = data[k]; else delete after[k];
      }
    }
    if (restored) fs.writeFileSync(file, JSON.stringify(after, null, 2) + '\n');
    if (findIssues(after).length) failed.push({ file, skipped: 'still-dirty' });
    else if (issues.includes('url-entity') && after.contentTier !== 'complete' && !hits[hits.length - 1].flagged) {
      requeue.push(`${path.basename(path.dirname(file))}\t${path.basename(file)}\t${after.url}`);
    }
  }
  const by = (k) => hits.filter((h) => h.issues.includes(k)).length;
  console.log(`scanned=${scanned} url-entity=${by('url-entity')} leading-img=${by('leading-img')} ${apply ? `applied=${hits.length - failed.length} failed=${failed.length}` : ''}`);
  failed.forEach((f) => console.log(`  FAILED ${f.file}: ${f.skipped}`));
  if (requeueArg) { fs.writeFileSync(requeueArg.split('=')[1], requeue.join('\n') + '\n'); console.log(`requeue=${requeue.length}`); }
  if (!process.argv.some((a) => a.startsWith('--reset-from=')) && (apply ? failed.length : hits.length)) process.exit(1);
}

if (require.main === module) main();
module.exports = { findIssues };

// --reset-from=<requeue tsv>: files whose retry back-off / discovery-abandoned
// state was earned against the broken (&amp;) url. Clear so the normal
// collect-review-texts queue picks them up with the decoded url.
if (require.main === module && process.argv.find((a) => a.startsWith('--reset-from='))) {
  const tsv = process.argv.find((a) => a.startsWith('--reset-from=')).split('=')[1];
  let n = 0;
  for (const l of fs.readFileSync(tsv, 'utf8').trim().split('\n')) {
    const [show, file] = l.split('\t');
    const p = path.join(DIR, show, file);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!('fetchRetryAfter' in d) && !d.fetchDiscoveryAbandoned) continue;
    delete d.fetchRetryAfter; delete d.fetchDiscoveryAbandoned;
    d.needsRefetch = true;
    // Raw edit on purpose: only these 3 keys move; routing through the guard
    // re-runs its heal/invariant heuristics and rewrote unrelated fields.
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n'); n++;
  }
  console.log(`reset-retry-state=${n}`);
}
