#!/usr/bin/env node
/**
 * audit-uk-regional-deterministic.js (BRO-6713)
 *
 * Free, model-free integrity checks over the UK regional population
 * (shows.json category 'regional' at a data/uk-regional-venues.json house,
 * excluding local-only rows). Complements the Gemini/GPT audits
 * (fact-check-historical-sample.js --cohort=uk-regional and
 * audit-review-crossmodel.js --cohort=uk-regional).
 *
 * Checks: duplicate productions, id-year vs opening-year, date ordering,
 * status vs closing date, opening date vs earliest review date, review URLs
 * that name a different venue, star-rating vs score band.
 * Prints counts and show ids only. Never prints review text.
 *
 * Usage: node scripts/audit-uk-regional-deterministic.js [--json]
 * Exit 0 always (advisory report); --json prints the machine summary.
 */
const path = require('path');
const root = path.join(__dirname, '..');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');

const shows = require(path.join(root, 'data/shows.json'));
const all = Array.isArray(shows) ? shows : shows.shows;
const reviews = require(path.join(root, 'data/reviews.json')).reviews;
const venues = require(path.join(root, 'data/uk-regional-venues.json'));

const uk = all.filter((s) => s.category === 'regional' && isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s));
const ids = new Set(uk.map((s) => s.id));
const byShow = {};
for (const r of reviews) if (ids.has(r.showId)) (byShow[r.showId] = byShow[r.showId] || []).push(r);

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const out = {};
const add = (k, id, note) => ((out[k] = out[k] || []).push(note ? `${id} (${note})` : id));

const seen = {};
for (const s of uk) {
  const k = `${norm(s.title)}|${norm(s.venue)}`;
  (seen[k] = seen[k] || []).push(s);
}
for (const list of Object.values(seen)) {
  if (list.length < 2) continue;
  // Same title at the same house in overlapping or same-year runs is a probable duplicate.
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const ya = String(a.openingDate || '').slice(0, 4), yb = String(b.openingDate || '').slice(0, 4);
    if (ya === yb) add('duplicateSameYear', a.id, `also ${b.id}`);
  }
}

const bandOf = (stars) => ({ 1: [0, 30], 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] })[stars];
const venueWords = venues.map((v) => ({ words: [v.idKey, ...(v.aliases || [])].map(norm), city: v.city }));

for (const s of uk) {
  const rs = byShow[s.id] || [];
  const idYear = (s.id.match(/-(\d{4})$/) || [])[1];
  const oy = String(s.openingDate || '').slice(0, 4);
  if (!s.openingDate) add('noOpeningDate', s.id);
  else if (idYear && oy && idYear !== oy) add('idYearNotOpeningYear', s.id, `${idYear} vs ${s.openingDate}`);
  if (s.openingDate && s.closingDate && s.closingDate < s.openingDate) add('closesBeforeOpens', s.id, `${s.openingDate} > ${s.closingDate}`);
  if (s.previewsStartDate && s.openingDate && s.previewsStartDate > s.openingDate) add('previewsAfterOpening', s.id);
  if (s.status === 'closed' && s.closingDate && s.closingDate > today) add('closedButClosingInFuture', s.id, s.closingDate);
  if (s.status === 'open' && s.closingDate && s.closingDate < today) add('openButClosingInPast', s.id, s.closingDate);
  if (s.openingDate && s.openingDate > today && rs.length) add('reviewsBeforeOpeningDate', s.id, `${rs.length} reviews, opens ${s.openingDate}`);

  const dated = rs.map((r) => r.publishDate).filter(Boolean).sort();
  if (s.openingDate && dated.length) {
    const d = days(dated[0], s.openingDate);
    if (d < -3) add('earliestReviewBeforeOpening', s.id, `${d}d`);
    if (d > 14) add('earliestReviewLongAfterOpening', s.id, `+${d}d`);
    if (s.openingDateSource) out._openingSources = out._openingSources || {}, (out._openingSources[s.openingDateSource] = (out._openingSources[s.openingDateSource] || 0) + 1);
  }
  for (const r of rs) {
    const m = String(r.originalRating || '').match(/(\d)\s*(?:\/|out of)\s*5/);
    if (m && r.assignedScore != null) {
      const band = bandOf(Number(m[1]));
      if (band && (r.assignedScore < band[0] || r.assignedScore > band[1])) add('starOutsideBand', s.id, `${m[1]}/5 -> ${r.assignedScore}`);
    }
    const u = norm(String(r.url || '').replace(/^https?:\/\/[^/]+/, ''));
    const yr = (String(r.url || '').match(/\/(20\d\d)\//) || [])[1];
    if (yr && idYear && Math.abs(Number(yr) - Number(idYear)) >= 2) add('reviewUrlYearFarFromRun', s.id, `url ${yr}`);
    const other = venueWords.find((v) => v.words.some((w) => w.length > 8 && u.includes(w.replace(/ /g, ' '))) && !isSameHouse(s, v));
    if (other) add('reviewUrlNamesOtherHouse', s.id, other.words[0]);
  }
}

function isSameHouse(show, v) {
  const sv = norm(show.venue);
  return v.words.some((w) => sv.includes(w) || w.includes(sv));
}

const summary = { shows: uk.length, reviews: Object.values(byShow).reduce((n, a) => n + a.length, 0) };
for (const [k, v] of Object.entries(out)) summary[k] = Array.isArray(v) ? v.length : v;
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, detail: out }, null, 1));
} else {
  console.log(JSON.stringify(summary, null, 1));
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) console.log(`\n${k} (${v.length}): ${v.slice(0, 6).join('; ')}${v.length > 6 ? ' ...' : ''}`);
}
module.exports = { uk };
