'use strict';

// u/Boring_Waltz_9545's "Estimated percentage recouped" for each Broadway
// show (BRO-5502). Their weekly r/Broadway Grosses Analysis gives a range for
// every newer musical. The site shows it, credited to them, for musicals (where
// our model runs high and stays off) and closed shows we cannot model.
//
// Checked by hand against reported outcomes before launch: The Outsiders and
// Just in Time read 100 the month they announced recoupment, Hell's Kitchen's
// final 60 matched the reported 55-60, and Death Becomes Her's final 10-30
// overstated a reported total loss. Our model had Hell's Kitchen at 91 and
// Death Becomes Her at 45.
//
// Stored on the commercial.json record by scrape-boring-waltz-costs.js:
//   analystRecoupPct  [low, high], the figure as written ("0%" is [0, 0])
//   analystRecoupAsOf the post's date (YYYY-MM-DD)
//   analystRecoupUrl  the post

const { extractWeeklyFinancialsFromPost } = require('./reddit-grosses');

const DAY_MS = 86_400_000;
// A title match must be the production running at the post's date: it began
// performances no more than 45 days after the post, and closed no more than
// 150 days before it (same title, an earlier or later revival).
const MAX_DAYS_BEFORE_START = 45;
const MAX_DAYS_AFTER_CLOSE = 150;
// The analyst writes 0-100; anything past this is a misread line.
const MAX_PCT = 200;

const FIELDS = ['analystRecoupPct', 'analystRecoupAsOf', 'analystRecoupUrl'];

function isoDate(post) {
  return new Date(post.created_utc * 1000).toISOString().slice(0, 10);
}

function postUrl(post) {
  if (typeof post.permalink === 'string' && post.permalink.startsWith('/')) return `https://www.reddit.com${post.permalink}`;
  return typeof post.url === 'string' && /^https:\/\//.test(post.url) ? post.url : null;
}

function daysBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / DAY_MS;
}

/** Was this production running (or about to start) on the post's `date`? */
function runsNear(show, date) {
  const start = show.previewsStartDate || show.openingDate;
  if (start && daysBetween(date, start) > MAX_DAYS_BEFORE_START) return false;
  if (show.closingDate && daysBetween(show.closingDate, date) > MAX_DAYS_AFTER_CLOSE) return false;
  return true;
}

/**
 * His newest figure from this production's run: a late recap or a title a
 * later revival now owns must not hide an in-run figure.
 * @param {object} show
 * @param {Array<{postDate: string}>} figures newest first
 */
function newestFigureInRun(show, figures) {
  return figures.find((f) => runsNear(show, f.postDate));
}

/**
 * The analyst's newest figure for each show.
 * @param {Array<{created_utc?: number, selftext?: string, permalink?: string, url?: string}>} posts any order
 * @param {(name: string) => ({slug?: string, id?: string, previewsStartDate?: string|null, openingDate?: string|null, closingDate?: string|null} | null)} matchShow
 *   the post's show heading to a Broadway production, or null
 * @returns {Map<string, {pct: [number, number], asOf: string, url: string|null, showName: string}>} keyed by slug
 */
function latestRecoupEstimates(posts, matchShow) {
  const out = new Map();
  const newestFirst = posts.filter((p) => p && Number.isFinite(p.created_utc)).sort((a, b) => b.created_utc - a.created_utc);
  for (const post of newestFirst) {
    const asOf = isoDate(post);
    for (const row of extractWeeklyFinancialsFromPost(post.selftext || '')) {
      if (row.recoupedLow == null) continue;
      const low = Math.min(row.recoupedLow, row.recoupedHigh);
      const high = Math.max(row.recoupedLow, row.recoupedHigh);
      if (!(low >= 0 && high <= MAX_PCT)) continue;
      const show = matchShow(row.showName);
      if (!show || !runsNear(show, asOf)) continue;
      const slug = show.slug || show.id;
      if (slug && !out.has(slug)) out.set(slug, { pct: [low, high], asOf, url: postUrl(post), showName: row.showName });
    }
  }
  return out;
}

/**
 * The fields to write for one estimate, or null when the record already holds
 * it or a newer one. A post edited on the same date replaces its earlier
 * reading. Only the three analyst fields: never recouped, the designation or
 * anything reported.
 */
function analystRecoupPatch(record, est) {
  if (!record || !est) return null;
  const storedAsOf = typeof record.analystRecoupAsOf === 'string' ? record.analystRecoupAsOf : null;
  if (storedAsOf && storedAsOf > est.asOf) return null;
  const patch = { analystRecoupPct: est.pct, analystRecoupAsOf: est.asOf, analystRecoupUrl: est.url };
  if (storedAsOf === est.asOf && JSON.stringify(record.analystRecoupPct) === JSON.stringify(est.pct) && record.analystRecoupUrl === est.url) return null;
  return patch;
}

/**
 * Write each show's newest figure onto its commercial.json record.
 * @param {Record<string, object>} records commercial.json `shows`, edited in place when apply is true
 * @returns {{updated: Array<{slug: string, from: [number, number]|null, to: [number, number], asOf: string}>, noRecord: string[]}}
 */
function applyAnalystRecoupEstimates(records, posts, matchShow, { apply = true } = {}) {
  const updated = [];
  const noRecord = [];
  for (const [slug, est] of latestRecoupEstimates(posts, matchShow)) {
    const record = records && records[slug];
    if (!record) { noRecord.push(slug); continue; }
    const patch = analystRecoupPatch(record, est);
    if (!patch) continue;
    updated.push({ slug, from: record.analystRecoupPct || null, to: est.pct, asOf: est.asOf });
    if (apply) Object.assign(record, patch);
  }
  return { updated, noRecord };
}

module.exports = {
  latestRecoupEstimates, analystRecoupPatch, applyAnalystRecoupEstimates, runsNear, newestFigureInRun,
  FIELDS, MAX_DAYS_BEFORE_START, MAX_DAYS_AFTER_CLOSE, MAX_PCT,
};
