#!/usr/bin/env node
'use strict';
/**
 * Dry run of the BRO-7748 press-night near-miss detector over recent press nights (offline, no fetches, no spend).
 *
 *   node scripts/audit-press-night-near-miss.js [--data-dir=data] [--nights=5] [--json]
 *
 * For the last N Broadway / off-Broadway press nights that have reviews in reviews.json:
 *   strict-miss  a review URL of that show whose slug the strict lane matcher refuses (titleMatchesShow /
 *                urlSlugMatchesShow). Run twice: the matcher before BRO-7739 ({fuzzy}) and as it is now (with the
 *                main-title rule), so the BMG-style subtitle case shows up.
 *   caught       a strict miss the near-miss detector flags (known outlet + nearMissSignals on the slug).
 *   false alarm  another show's review published within a day of the night that the detector flags for this show.
 * Only URL slugs are tested: reviews.json has no headlines, so live recall (headline AND slug) is at least this high.
 * The found-vs-live gap check needs live timestamps that are not stored historically; it is covered by unit tests.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { titleMatchesShow, urlSlugMatchesShow } = require('./lib/rss-discovery');
const { resolveOutletFromUrl } = require('./lib/review-normalization');
const { nearMissSignals } = require('./lib/opening-night-lane/near-miss');

const argv = process.argv.slice(2);
const arg = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

function slugTitle(url) {
  try { return decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop().replace(/[-_]+/g, ' '); } catch { return ''; }
}

function strictMatches(url, title, opts) {
  return titleMatchesShow(slugTitle(url), title, opts) || urlSlugMatchesShow(url, title, opts);
}

function dayDiff(a, b) { return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000; }

function audit({ shows, reviews, nights = 5 }) {
  const allTitles = shows.map((s) => s.title).filter(Boolean);
  const OPTS = { before: { fuzzy: true }, now: { fuzzy: true, mainTitle: true, allShowTitles: allTitles } };
  const byShow = new Map();
  for (const r of reviews) if (r && r.url && r.showId) (byShow.get(r.showId) || byShow.set(r.showId, []).get(r.showId)).push(r);
  const pressNights = shows
    .filter((s) => s.openingDate && ['broadway', 'off-broadway'].includes(s.category) && (byShow.get(s.id) || []).length)
    .sort((a, b) => b.openingDate.localeCompare(a.openingDate)).slice(0, nights);
  const out = [];
  for (const show of pressNights) {
    const own = byShow.get(show.id).filter((r) => resolveOutletFromUrl(r.url));
    const row = { show: show.id, night: show.openingDate, reviews: own.length };
    for (const [k, opts] of Object.entries(OPTS)) {
      const misses = own.filter((r) => !strictMatches(r.url, show.title, opts));
      const caught = misses.filter((r) => nearMissSignals({ url: r.url, title: '' }, show).length);
      row[k] = { strictMiss: misses.length, caught: caught.length, missed: misses.filter((r) => !caught.includes(r)).map((r) => r.url) };
    }
    const others = reviews.filter((r) => r.showId !== show.id && r.url && r.publishDate && dayDiff(r.publishDate, show.openingDate) <= 1 && resolveOutletFromUrl(r.url));
    const fa = others.filter((r) => nearMissSignals({ url: r.url, title: '' }, show).length && !strictMatches(r.url, show.title, OPTS.now));
    row.otherShowReviews = others.length;
    row.falseAlarms = fa.map((r) => `${r.showId}: ${r.url}`);
    out.push(row);
  }
  return out;
}

function main() {
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const dir = path.resolve(arg('data-dir', path.join(__dirname, '..', 'data')));
  const load = (f) => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return Array.isArray(j) ? j : j.shows || j.reviews || []; };
  const rows = audit({ shows: load('shows.json'), reviews: load('reviews.json'), nights: Number(arg('nights', 5)) || 5 });
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  const sum = (k, f) => rows.reduce((n, r) => n + r[k][f], 0);
  for (const r of rows) {
    console.log(`${r.night} ${r.show}: ${r.reviews} known-outlet reviews | before BRO-7739: ${r.before.strictMiss} strict misses, ${r.before.caught} caught | now: ${r.now.strictMiss} misses, ${r.now.caught} caught | false alarms ${r.falseAlarms.length}/${r.otherShowReviews} other-show reviews`);
    for (const u of r.now.missed) console.log(`   still missed: ${u}`);
    for (const u of r.falseAlarms) console.log(`   false alarm: ${u}`);
  }
  const fa = rows.reduce((n, r) => n + r.falseAlarms.length, 0); const other = rows.reduce((n, r) => n + r.otherShowReviews, 0);
  console.log(`TOTAL ${rows.length} nights: before BRO-7739 ${sum('before', 'caught')}/${sum('before', 'strictMiss')} strict misses caught; now ${sum('now', 'caught')}/${sum('now', 'strictMiss')}; false alarms ${fa}/${other}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { audit, slugTitle };
