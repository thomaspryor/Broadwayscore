#!/usr/bin/env node
/**
 * fix-printed-bylines.js: name review files from the credit the ARTICLE prints, where the page
 * metadata names a shared account or nobody.
 *
 *   - override: the stored name disagrees with a printed credit at an outlet in
 *     PRINTED_BYLINE_OVERRIDES (South London: CMS user "Michael Holland" on every review, the real
 *     critic is in the standfirst "... writes Lizzie Paul."; All That Dazzles: "Review by Daz Gale"
 *     filed under "All That Dazzles" / "Sam - Admin").
 *   - fill: the file is Unknown and the text carries the credit (byline-from-text.js extractors:
 *     Talkin' Broadway "Theatre Review by", NYTG "Review by", Time Out "Written by <name><role>").
 *   - page (--fetch): the credit lives only in the page HTML, not in the stored text (The Spy in the
 *     Stalls "Reviewed on <date> / by <name>", Musical Theatre Review's sign-off before the share
 *     widget). The page is read once over plain HTTP and run through that outlet's one credit extractor.
 *
 * Fills go through applyPageByline (every guard of the Unknown-byline backfill: flagged/locked files,
 * credited creatives, sibling collisions). Overrides rename through safeRenameReview and are refused
 * on a destination collision. Dry run by default.
 *
 * Usage:
 *   node scripts/fix-printed-bylines.js [--dir=PATH] [--outlet=a,b] [--show=ID] [--fetch] [--apply]
 *   --dir     review-texts root (default <repo>/data/review-texts)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { extractBylineFromText, printedBylineOverride } = require('./lib/byline-from-text');
const { applyPageByline } = require('./lib/review-file-writer');
const { safeRenameReview, safeWriteReview } = require('./lib/review-write-guard');
const { generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');
const { isJunkCriticName } = require('./lib/byline-recovery');

const USAGE = `fix-printed-bylines.js: name review files from the credit the article prints.

Usage:
  node scripts/fix-printed-bylines.js [--dir=PATH] [--outlet=a,b] [--show=ID] [--fetch] [--apply]
  node scripts/fix-printed-bylines.js --help, -h    print this usage and exit
`;

// Outlets whose critic is only in the page HTML (the stored text drops it), each with the ONE
// extractor that reads its printed credit. The page's generic author is a house account there
// (Musical Theatre Review: "Admin", and "Angela Thomas" on press-release posts; Spy in the Stalls:
// the site name), so the generic extractor chain is deliberately not used.
const { extractSignOffBeforeShare, extractReviewedByLine } = require('./lib/byline-extraction');
const PAGE_EXTRACTORS = {
  'musical-theatre-review': extractSignOffBeforeShare,
  'the-spy-in-the-stalls': extractReviewedByLine,
};
const PAGE_ONLY_OUTLETS = new Set(Object.keys(PAGE_EXTRACTORS));
const TEXT_OUTLETS = new Set(['south-london', 'theatreandtonic', 'all-that-dazzles-uk', 'talkinbroadway', 'nytg', 'timeout', 'timeout-london']);

function isUnnamed(name) {
  return !name || /^(unknown|unnamed)$/i.test(String(name).trim()) || isJunkCriticName(name);
}

function getPage(url, redirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'curl/8.5.0' }, timeout: 25000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(getPage(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 3e6) body += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Pure: the action for one review-text record, or null. `page` is the fetched HTML (page-only outlets).
 * @returns {{kind: 'override'|'fill'|'page', name: string} | null}
 */
function decideByline(outletId, data, page) {
  if (!data || data.wrongProduction || data.duplicateOf || data.criticNameManual || data._locked === true) return null;
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  const stored = data.criticName;
  const override = printedBylineOverride(outletId, text, data.url, isUnnamed(stored) ? null : stored);
  // A stored real name that disagrees with the printed credit is replaced (override); an unnamed file
  // takes the credit through the guarded Unknown-byline path (fill).
  if (override && !isUnnamed(stored) && String(override).toLowerCase() !== String(stored || '').toLowerCase()) return { kind: 'override', name: override };
  if (!isUnnamed(stored)) return null;
  if (override) return { kind: 'fill', name: override };
  const hit = TEXT_OUTLETS.has(outletId) ? extractBylineFromText(outletId, text) : null;
  if (hit && hit.known) return { kind: 'fill', name: hit.name };
  if (page && PAGE_EXTRACTORS[outletId]) {
    const name = PAGE_EXTRACTORS[outletId](page);
    if (name && !isUnnamed(name)) return { kind: 'page', name };
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const arg = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const apply = argv.includes('--apply');
  const fetchPages = argv.includes('--fetch');
  const root = arg('dir') || path.join(__dirname, '..', 'data', 'review-texts');
  const outlets = arg('outlet') ? new Set(arg('outlet').split(',')) : null;
  const onlyShow = arg('show');

  const counts = { override: 0, fill: 0, page: 0, refused: 0, noop: 0 };
  const refusals = {};
  const report = [];
  for (const show of fs.readdirSync(root)) {
    if (onlyShow && show !== onlyShow) continue;
    const dir = path.join(root, show);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const outletId = normalizeOutlet(f.split('--')[0]);
      if (outlets && !outlets.has(outletId)) continue;
      if (!TEXT_OUTLETS.has(outletId) && !PAGE_ONLY_OUTLETS.has(outletId)) continue;
      const filePath = path.join(dir, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      let decision = decideByline(outletId, data, null);
      if (!decision && fetchPages && PAGE_ONLY_OUTLETS.has(outletId) && isUnnamed(data.criticName) && data.url && !data.wrongProduction && !data.duplicateOf) {
        const page = await getPage(data.url);
        decision = decideByline(outletId, data, page);
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!decision) { counts.noop++; continue; }
      let result;
      if (decision.kind === 'override') {
        const dst = path.join(dir, generateReviewFilename(outletId, decision.name));
        if (!apply) result = { applied: true, newPath: dst };
        else {
          const updated = { ...data, criticName: decision.name, criticEnrichedFrom: 'printed-byline:text-override' };
          if (path.resolve(dst) === path.resolve(filePath)) {
            // The slug already names the critic; only the stored criticName is stale.
            const w = safeWriteReview(filePath, updated);
            result = w && w.wrote !== false ? { applied: true, newPath: dst } : { applied: false, reason: 'write-failed' };
          } else {
            const r = safeRenameReview(filePath, dst, { newData: updated });
            result = r && r.wrote ? { applied: true, newPath: dst } : { applied: false, reason: `rename-${(r && r.skipped) || 'failed'}` };
          }
        }
      } else {
        result = applyPageByline(filePath, data, { showId: show, criticName: decision.name, source: decision.kind === 'page' ? 'printed-page' : 'printed-text', dryRun: !apply });
      }
      if (result.applied) {
        counts[decision.kind]++;
        report.push({ show, file: f, kind: decision.kind, from: data.criticName || null, to: decision.name });
      } else {
        counts.refused++;
        refusals[result.reason] = (refusals[result.reason] || 0) + 1;
        report.push({ show, file: f, kind: decision.kind, from: data.criticName || null, to: decision.name, refused: result.reason });
      }
    }
  }
  for (const r of report.slice(0, 400)) {
    console.log(`${r.refused ? 'REFUSED ' + r.refused : (apply ? 'NAMED' : 'WOULD NAME')} [${r.kind}] ${r.show}/${r.file}: ${r.from} -> ${r.to}`);
  }
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: override ${counts.override}, fill ${counts.fill}, page ${counts.page}, refused ${counts.refused} ${JSON.stringify(refusals)}, untouched ${counts.noop}`);
}

module.exports = { decideByline, isUnnamed };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
