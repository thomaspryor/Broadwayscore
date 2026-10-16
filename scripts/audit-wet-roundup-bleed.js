#!/usr/bin/env node
/**
 * audit-wet-roundup-bleed.js (BRO-4858)
 *
 * Audits WestEndTheatre (WET) round-up data for the BRO-4851 bleed: a round-up
 * block with no byline took the NEXT outlet's critic and review URL.
 *
 *   1. Archive rows (data/aggregator-archive/westendtheatre/*.json) that carry
 *      the bleed fingerprint (same critic + same url as a later row, url owned
 *      by that later row's outlet). For these the fixed extractSectionReviews
 *      output is known exactly: critic null, url null. See lib/wet-bleed-audit.js.
 *   2. The review-text files those rows produced (same show, same outlet,
 *      holding the borrowed critic or url), with their current state.
 *   3. Every WET-sourced review-text file whose url's domain belongs to another
 *      outlet than its outletId (check (a) on the card).
 *   4. Leads: a WET-sourced file whose criticName is another outlet's critic in
 *      the same WET post, without url proof (check (b)). Report only.
 *
 * Read-only. Writes the report JSON to --out (default
 * data/audit/wet-roundup-bleed-audit.json) and a summary to stdout. Data fixes
 * go through an approved-fix plan (data/pending-fixes/), never from here.
 *
 * Usage:
 *   node scripts/audit-wet-roundup-bleed.js [--out=PATH] [--no-write] [--json]
 *        [--archive-dir=DIR] [--review-texts=DIR]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const { normalizeOutlet, resolveOutletFromUrl, isCrossOutletUrl } = require('./lib/review-normalization');
const {
  normalizeArchiveRows, findArchiveBleeds, matchBleedFiles, normCritic, isWetUrl,
  defaultOutletIdFor, defaultOwnsUrl, sameHouse,
} = require('./lib/wet-bleed-audit');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const ARCHIVE_DIR = arg('archive-dir', path.join(ROOT, 'data', 'aggregator-archive', 'westendtheatre'));
const REVIEW_DIR = arg('review-texts', path.join(ROOT, 'data', 'review-texts'));
const OUT = arg('out', path.join(ROOT, 'data', 'audit', 'wet-roundup-bleed-audit.json'));
const NO_WRITE = process.argv.includes('--no-write');
const JSON_OUT = process.argv.includes('--json');

const outletIdFor = defaultOutletIdFor;
const ownsUrl = defaultOwnsUrl;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const showFilesCache = new Map();
function showFiles(showId) {
  if (showFilesCache.has(showId)) return showFilesCache.get(showId);
  const dir = path.join(REVIEW_DIR, showId);
  let out = [];
  if (fs.existsSync(dir)) {
    out = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => ({ file: `${showId}/${f}`, data: readJson(path.join(dir, f)) }))
      .filter(x => x.data);
  }
  showFilesCache.set(showId, out);
  return out;
}

// Exclusion state as stored on the file (what keeps a row out of reviews.json).
function fileState(d) {
  const flags = ['wrongAttribution', 'wrongProduction', 'wrongShow', 'isRoundupArticle', 'isNotReview',
    'isNonReview', 'crossOutletDuplicate', 'isSyndicatedDuplicate', 'nonReviewFlag', 'showNotMentioned']
    .filter(k => d[k] === true);
  if (d.duplicateOf) flags.push(`duplicateOf=${d.duplicateOf}`);
  return {
    criticName: d.criticName || null,
    url: d.url || null,
    source: d.source || null,
    hasFullText: typeof d.fullText === 'string' && d.fullText.length > 200,
    fullTextChars: typeof d.fullText === 'string' ? d.fullText.length : 0,
    flags,
  };
}

function isWetSourced(d) {
  return d.source === 'westendtheatre' || d.scoreSource === 'westendtheatre-star-rating'
    || typeof d.westEndTheatreScore === 'string' || typeof d.westEndTheatreExcerpt === 'string';
}

function main() {
  if (!fs.existsSync(ARCHIVE_DIR)) { console.error(`archive dir missing: ${ARCHIVE_DIR}`); process.exit(2); }
  if (!fs.existsSync(REVIEW_DIR)) { console.error(`review-texts dir missing: ${REVIEW_DIR}`); process.exit(2); }

  const report = {
    generatedAt: new Date().toISOString(),
    card: 'BRO-4858',
    method: 'Archive rows only: WET pages are behind a Cloudflare challenge and the archive holds parsed rows, not HTML, so the fixed parser cannot be re-run on source pages. A bleed row is identified by the fingerprint the old parser left (critic + url copied from a later row whose outlet owns the url); for those rows the fixed parser output is critic null, url null.',
    archive: { files: 0, rows: 0, unreadable: [] },
    bleeds: [],
    domainMismatches: [],
    leads: [],
  };

  const archiveCriticsByShow = new Map();
  for (const f of fs.readdirSync(ARCHIVE_DIR).filter(x => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    const archive = readJson(path.join(ARCHIVE_DIR, f));
    if (!archive) { report.archive.unreadable.push(f); continue; }
    // Replay (gather-reviews, sweep-we-aggregators) keys on the FILE name, not
    // ourShowId, so the review-text folder the rows reach is the file's.
    const showId = f.replace(/\.json$/, '');
    const rows = normalizeArchiveRows(archive);
    report.archive.files++;
    report.archive.rows += rows.length;
    archiveCriticsByShow.set(showId, rows.map(r => ({ ...r, outletId: outletIdFor(r) })));

    const { bleeds, leads } = findArchiveBleeds(rows, { outletIdFor, ownsUrl, sameHouse });
    for (const b of bleeds) {
      const files = matchBleedFiles(b, showFiles(showId)).map(({ file, data }) => ({ file, ...fileState(data) }));
      report.bleeds.push({ showId, archive: f, ...b, reviewTextFiles: files });
    }
    for (const l of leads) {
      const files = showFiles(showId)
        .filter(({ data }) => data.outletId === l.outletId && normCritic(data.criticName) === normCritic(l.critic))
        .map(({ file, data }) => ({ file, ...fileState(data) }));
      report.leads.push({ showId, archive: f, kind: 'archive-shared-critic', ...l, reviewTextFiles: files });
    }
  }

  // (a) url domain vs outletId, and (b) critic == another outlet's critic in the
  // same post, over every WET-sourced review-text file.
  const leadKeys = new Set(report.leads.map(l => `${l.showId}|${l.outletId}|${normCritic(l.critic)}`));
  for (const showId of fs.readdirSync(REVIEW_DIR).sort()) {
    const dir = path.join(REVIEW_DIR, showId);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const { file, data } of showFiles(showId)) {
      if (!isWetSourced(data)) continue;
      if (data.url && !isWetUrl(data.url) && data.outletId && isCrossOutletUrl(data.outletId, data.url)) {
        const owner = resolveOutletFromUrl(data.url);
        const ownerId = owner ? owner.outletId : null;
        if (!sameHouse(data.outletId, ownerId)) {
          report.domainMismatches.push({ file, outletId: data.outletId, urlOutletId: ownerId, ...fileState(data) });
        }
      }
      const rows = archiveCriticsByShow.get(showId);
      const c = normCritic(data.criticName);
      if (!rows || !c) continue;
      const fileOutlet = normalizeOutlet(data.outletId);
      const other = rows.find(r => !sameHouse(r.outletId, fileOutlet) && normCritic(r.critic) === c);
      const own = rows.find(r => sameHouse(r.outletId, fileOutlet) && normCritic(r.critic) === c);
      if (!other || own) continue;
      const key = `${showId}|${data.outletId}|${c}`;
      if (leadKeys.has(key)) continue;
      leadKeys.add(key);
      report.leads.push({
        showId, kind: 'review-text-critic-of-other-outlet', file, outletId: data.outletId,
        critic: data.criticName, url: data.url || null, otherOutlet: other.outlet, otherOutletId: other.outletId,
        otherUrl: other.url, ...fileState(data),
      });
    }
  }

  report.summary = {
    archiveFiles: report.archive.files,
    archiveRows: report.archive.rows,
    bleedRows: report.bleeds.length,
    bleedReviewTextFiles: report.bleeds.reduce((n, b) => n + b.reviewTextFiles.length, 0),
    domainMismatches: report.domainMismatches.length,
    leads: report.leads.length,
  };
  // Files a finding points at that carry no exclusion flag, i.e. still count.
  const unflagged = new Set();
  const note = rf => { if (rf && rf.file && rf.flags.length === 0) unflagged.add(rf.file); };
  for (const b of report.bleeds) b.reviewTextFiles.forEach(note);
  report.domainMismatches.forEach(note);
  for (const l of report.leads) (l.file ? [l] : (l.reviewTextFiles || [])).forEach(note);
  report.summary.unflaggedFiles = [...unflagged].sort();

  if (!NO_WRITE) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  }
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`WET round-up bleed audit (BRO-4858): ${report.archive.files} archive posts, ${report.archive.rows} rows`);
  console.log(`\nBleed rows (fixed parser re-derives critic=null, url=null): ${report.bleeds.length}`);
  for (const b of report.bleeds) {
    console.log(`  ${b.showId} #${b.index} ${b.outletId}: stored "${b.stored.critic}" ${b.stored.url}  <- from #${b.donor.index} ${b.donor.outletId}`);
    if (!b.reviewTextFiles.length) console.log('      review-texts: none hold the borrowed critic/url');
    for (const rf of b.reviewTextFiles) console.log(`      ${rf.file}  critic=${rf.criticName} url=${rf.url} fullText=${rf.fullTextChars} flags=[${rf.flags.join(',')}]`);
  }
  console.log(`\nWET-sourced files whose url belongs to another outlet: ${report.domainMismatches.length}`);
  for (const m of report.domainMismatches) console.log(`  ${m.file}  ${m.outletId} url-> ${m.urlOutletId}  ${m.url} flags=[${m.flags.join(',')}]`);
  console.log(`\nLeads (critic shared with another outlet, no url proof; report only): ${report.leads.length}`);
  for (const l of report.leads) {
    console.log(`  [${l.kind}] ${l.showId} ${l.outletId} "${l.critic}" (also ${l.otherOutletId}) url=${l.url || '-'}`);
    const files = l.file ? [l] : (l.reviewTextFiles || []);
    for (const rf of files) console.log(`      ${rf.file}  fullText=${rf.fullTextChars} flags=[${rf.flags.join(',')}]`);
  }
  console.log(`\nUnflagged review-text files in any finding (would still count): ${report.summary.unflaggedFiles.length}`);
  for (const f of report.summary.unflaggedFiles) console.log(`  ${f}`);
  if (!NO_WRITE) console.log(`\nReport: ${path.relative(ROOT, OUT)}`);
}

main();
