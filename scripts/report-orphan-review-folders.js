#!/usr/bin/env node
/**
 * report-orphan-review-folders.js — list data/review-texts folders with no
 * shows.json id (BRO-4317) and propose a home for every file in them.
 *
 * Each file is matched by its publishDate against the run window of every
 * candidate production (same id base / title); URLs are never used to pick a
 * production (CLAUDE.md §3). The report carries metadata only (paths, urls,
 * dates, text lengths), never review text, so it is safe to print from
 * run-script.yml.
 *
 * Usage:
 *   node scripts/report-orphan-review-folders.js            # summary
 *   node scripts/report-orphan-review-folders.js --json     # full per-file report
 *   node scripts/report-orphan-review-folders.js --strict   # exit 1 when any orphan folder exists
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  findOrphanReviewFolders, retiredOrphanFolders, candidateShows, isExactCandidate, idTwin, inWindow, normalizeUrl, toMs,
} = require('./lib/orphan-review-folders');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

const USAGE = `report-orphan-review-folders.js — review-text folders with no shows.json id, and a proposed home per file.

Usage:
  node scripts/report-orphan-review-folders.js [--json] [--strict]
  node scripts/report-orphan-review-folders.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function textLen(r) {
  return typeof r?.fullText === 'string' ? r.fullText.length : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { process.stdout.write(USAGE); return 0; }
  const shows = (readJson(path.join(ROOT, 'data', 'shows.json')) || {}).shows || [];
  if (shows.length < 500) {
    console.error(`shows.json has ${shows.length} rows; refusing to treat it as ground truth`);
    return 2;
  }
  const DIR = resolveReviewTextsDir();
  if (!DIR || !fs.existsSync(DIR)) {
    console.error('data/review-texts is missing (run with --review-texts in cloud)');
    return 2;
  }
  const retired = new Map();
  for (const r of readJson(path.join(ROOT, 'data', 'retired-show-ids.json')) || []) {
    if (r && r.id) retired.set(r.id, r);
  }
  const ids = new Set(shows.map((s) => s.id));
  const orphans = findOrphanReviewFolders(DIR, ids);
  const files = [];
  for (const { folder, files: names } of orphans) {
    const cands = candidateShows(folder, shows);
    const ret = retired.get(folder);
    const twin = idTwin(folder, shows, ret && ret.reason);
    for (const file of names) {
      const r = readJson(path.join(DIR, folder, file)) || {};
      const pd = toMs(r.publishDate);
      const hits = pd == null ? [] : cands.filter((s) => inWindow(pd, s));
      const rec = {
        folder, file, url: r.url || null, publishDate: r.publishDate || null,
        outletId: r.outletId || null, critic: r.criticName || null, source: r.source || null,
        textLen: textLen(r), contentTier: r.contentTier || null,
        wrongProduction: r.wrongProduction === true, wrongShow: r.wrongShow === true,
        retired: ret ? { reason: String(ret.reason || '').slice(0, 160), duplicateOf: ret.duplicateOf || null } : null,
        candidates: cands.map((s) => `${s.id} ${s.openingDate || '?'}..${s.closingDate || 'open'}`),
        hits: hits.map((s) => s.id),
      };
      // Where a same-named file already sits in the proposed target, describe it.
      const target = hits.length === 1 ? hits[0].id : (pd == null && twin ? twin : null);
      if (target) {
        const tp = path.join(DIR, target, file);
        if (fs.existsSync(tp)) {
          const t = readJson(tp) || {};
          rec.targetSameFile = {
            target,
            sameUrl: normalizeUrl(t.url) === normalizeUrl(r.url),
            url: t.url || null, publishDate: t.publishDate || null,
            textLen: textLen(t), contentTier: t.contentTier || null,
            wrongProduction: t.wrongProduction === true,
            wrongProductionReason: t.wrongProduction ? String(t.wrongProductionReason || '').slice(0, 200) : null,
          };
        }
      }
      if (r.wrongProduction) rec.wrongProductionReason = String(r.wrongProductionReason || '').slice(0, 200);
      rec.twin = twin;
      // A title/prefix pairing (not an id-base match) is never a clean move: it needs a human look.
      const loose = hits.length === 1 && !isExactCandidate(folder, hits[0]);
      rec.kind = hits.length === 1 ? (rec.targetSameFile ? (rec.targetSameFile.sameUrl ? 'dup-same-url' : 'dup-diff-url') : loose ? 'loose-move' : 'clean-move')
        : hits.length > 1 ? 'multi-match'
        : pd == null && twin ? (rec.targetSameFile ? (rec.targetSameFile.sameUrl ? 'twin-dup-same-url' : 'twin-dup-diff-url') : 'twin-move')
        : pd == null ? 'no-date' : cands.length ? 'no-window-match' : 'no-candidate';
      files.push(rec);
    }
  }
  const byKind = {};
  for (const f of files) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const stranded = retiredOrphanFolders(orphans, retired.values());
  const summary = { folders: orphans.length, files: files.length, byKind, retiredFolders: stranded.length, retiredFiles: stranded.reduce((n, o) => n + o.files.length, 0) };
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ summary, files }, null, 1)}\n`);
  } else {
    console.log(`Orphan review-text folders: ${orphans.length} (${files.length} files)`);
    for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
    console.log(`  of which retired ids (stranded by a retirement): ${summary.retiredFolders} folders, ${summary.retiredFiles} files`);
    for (const o of stranded) console.log(`  RETIRED ${o.folder} (${o.files.length}) ${String(o.retired.reason || '').slice(0, 100)}`);
    for (const o of orphans.slice(0, 40)) console.log(`  ${o.folder} (${o.files.length})`);
  }
  return args.includes('--strict') && orphans.length ? 1 : 0;
}

// exitCode, not process.exit(): exit() drops a large --json write still buffered in a pipe (run-script.yml cut it at ~219 KB).
if (require.main === module) process.exitCode = main();
module.exports = { main };
