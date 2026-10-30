#!/usr/bin/env node
/**
 * BRO-5794 diagnostic: review-text files on 2026 shows that are NOT counted in
 * reviews.json (no assignedScore), with the metadata that decides whether a
 * text-less fallback applies. Prints metadata only, never review text.
 *
 * Usage: node scripts/audit-uncounted-real-reviews.js [--year=2026] [--json] [--counts=PATH]
 * --counts (BRO-6038 shadow job) writes counts only and prints the summary only.
 * Its findings are the `suspect` rows: no wrongShow/wrongProduction/roundup/
 * rejection flag and a contentTier above stub, i.e. a real-looking review the
 * rebuild did not count. The full row total is reported beside it.
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { EXCERPT_FIELDS } = require('./lib/excerpt-fields');

const args = process.argv.slice(2);
const year = (args.find(a => a.startsWith('--year=')) || '--year=2026').split('=')[1];
const asJson = args.includes('--json');
const { countsPathFromArgv, writeAuditCounts } = require('./lib/audit-counts');
const countsPath = countsPathFromArgv(args);
const root = path.join(__dirname, '..');
const dir = path.join(root, 'data/review-texts');
const shows = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
const showList = Array.isArray(shows) ? shows : shows.shows;
const byId = new Map(showList.map(s => [s.id, s]));
const rv = JSON.parse(fs.readFileSync(path.join(root, 'data/reviews.json'), 'utf8'));
const counted = new Set((rv.reviews || rv).filter(r => r.assignedScore != null).map(r => `${r.showId}/${r.file || ''}`));
const countedKey = new Set((rv.reviews || rv).filter(r => r.assignedScore != null).map(r => `${r.showId}|${r.outletId}|${(r.criticName || '').toLowerCase()}`));

const rows = [];
for (const s of listShowDirs(dir)) {
  const show = byId.get(s);
  if (!show) continue;
  const yr = String(show.openingDate || show.previewDate || '').slice(0, 4);
  if (yr !== year && !s.includes(year)) continue;
  const sd = path.join(dir, s);
  for (const f of fs.readdirSync(sd).filter(x => x.endsWith('.json'))) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch (e) { continue; }
    if (!d || typeof d !== 'object' || !d.url) continue;
    const key = `${s}|${d.outletId}|${(d.criticName || '').toLowerCase()}`;
    if (countedKey.has(key) || d.assignedScore != null) continue;
    rows.push({
      show: s, file: f, outlet: d.outletId || d.outlet, critic: d.criticName, url: d.url,
      publishDate: d.publishDate, opening: show.openingDate, tier: d.contentTier, textLen: (d.fullText || '').length,
      excerpts: EXCERPT_FIELDS.filter(k => d[k]).map(k => `${k}:${String(d[k]).length}`),
      og: d.ogDescription ? String(d.ogDescription).length : 0, serp: d.serpSnippet ? String(d.serpSnippet).length : 0,
      stars: d.originalScore || d.originalRating || null,
      flags: ['wrongShow', 'wrongProduction', 'isRoundupArticle', 'rejectionReason', 'scoreStatus', 'textStatus', 'failureReason', 'isFullReview']
        .filter(k => d[k] != null && d[k] !== false).map(k => `${k}=${d[k]}`),
    });
  }
}
const EXCLUDING_FLAGS = new Set(['wrongShow', 'wrongProduction', 'isRoundupArticle', 'rejectionReason']);
const isSuspect = (r) => !['invalid', 'stub'].includes(r.tier) && !r.flags.some(f => EXCLUDING_FLAGS.has(f.split('=')[0]));
if (countsPath) {
  writeAuditCounts(countsPath, 'audit-uncounted-real-reviews.js', { findings: rows.filter(isSuspect).length, uncounted: rows.length, year: Number(year) || year });
} else if (asJson) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log(`${r.show}/${r.file} | ${r.outlet} | tier=${r.tier} len=${r.textLen} ex=[${r.excerpts}] og=${r.og} serp=${r.serp} stars=${r.stars} | pub=${r.publishDate} open=${r.opening} | ${r.flags.join(',')} | ${r.url}`);
console.error(`uncounted files on ${year} shows: ${rows.length} (${rows.filter(isSuspect).length} unflagged above stub)`);
