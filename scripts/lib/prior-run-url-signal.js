'use strict';

const { foldDiacritics } = require('./url-slug');

/**
 * prior-run-url-signal.js — "does this candidate URL's own slug say it reviews
 * an EARLIER production of the show?" for shows that declare `priorRuns`.
 *
 * BRO-5512 (Kramer/Fauci, St. Ann's 2026-10): the show's earlier NYU Skirball
 * run (2026-02-11..21) shares the calendar year with the St. Ann's run, so the
 * year-only checks (isUrlYearOutOfWindow, isUrlYearInPriorRun) cannot see that
 * theatlantic.com/culture/2026/02/... and exeuntnyc.com/.../kramer-fauci-at-nyu-skirball
 * review the February production. They sat in the SERP census as "missing" and
 * fired an opening-window review-gap alert that no ingest could ever clear
 * (ingest is, rightly, gated off for them).
 *
 * Two slug-only signals, both requiring a declared priorRuns entry (the
 * absence of a signal proves nothing, a signal only ever says "other run"):
 *   - month: a /YYYY/MM/ (or YYYY-MM) path segment whose month lies inside a
 *     prior run's open..close months and outside the current run's months.
 *   - venue: the slug names a prior run's venue and not the current venue.
 */

const VENUE_STOPWORDS = new Set([
  'the', 'of', 'for', 'and', 'at', 'center', 'centre', 'theater', 'theatre',
  'performing', 'arts', 'playhouse', 'house', 'hall',
]);

function slugTokens(s) {
  return new Set(foldDiacritics(String(s || '')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function venueKeyTokens(venue) {
  const toks = [...slugTokens(venue)].filter((t) => t.length >= 2 && !VENUE_STOPWORDS.has(t));
  // One word ("public", "lincoln") is too weak to identify a venue.
  return toks.length >= 2 ? toks : [];
}

function monthIndex(d) {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.getUTCFullYear() * 12 + dt.getUTCMonth();
}

function monthSpan(openingDate, closingDate) {
  const from = monthIndex(openingDate);
  if (from === null) return null;
  const to = closingDate ? monthIndex(closingDate) : null;
  return { from, to: to === null ? from : Math.max(from, to) };
}

/**
 * @param {string} url
 * @param {object} show shows.json record (priorRuns, venue, previewsStartDate, openingDate, closingDate)
 * @returns {{signal: 'prior-run-month'|'prior-run-venue', detail: string}|null}
 */
function priorRunUrlSignal(url, show, { useVenue = true } = {}) {
  if (!url || !show || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return null; }

  // Only a run the show says does NOT carry its reviews over: a bare priorRuns
  // entry also readmits that run's URLs (audit-show-review-gap.test.mjs), so
  // dropping them is opt-in via inheritReviews:false.
  const declared = show.priorRuns.filter((r) => r && r.inheritReviews === false);
  if (declared.length === 0) return null;

  const current = monthSpan(show.previewsStartDate || show.openingDate, show.closingDate || show.openingDate);
  const runs = declared.map((r) => ({ r, span: r && r.openingDate ? monthSpan(r.openingDate, r.closingDate) : null }));

  const ym = pathname.match(/(?:^|[\/\-_])((?:19|20)\d{2})[\/\-](0[1-9]|1[0-2])(?:[\/\-_]|$)/);
  if (ym) {
    const idx = parseInt(ym[1], 10) * 12 + (parseInt(ym[2], 10) - 1);
    const inCurrent = current && idx >= current.from && idx <= current.to;
    if (!inCurrent) {
      for (const { span } of runs) {
        if (span && idx >= span.from && idx <= span.to) {
          return { signal: 'prior-run-month', detail: `url month ${ym[1]}-${ym[2]} falls inside a declared prior run` };
        }
      }
    }
  }

  // Venue signal is census-only: a Show Score link naming the old venue is
  // more likely a transfer review than an old-run review.
  if (!useVenue) return null;
  // Last path segment only, so section folders ("/lincoln-center/") never match.
  const slug = pathname.replace(/\/+$/, '').split('/').pop();
  const segs = slugTokens(slug);
  // Flat substring, not tokens: "st-anns-warehouse" must match "St. Ann's Warehouse".
  const flatPath = slug.replace(/[^a-z0-9]/g, '');
  const flatCurrent = foldDiacritics(String(show.venue || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  // Any distinctive word of the current venue ("warehouse") also counts: transfer
  // reviews shorten it ("from-nyu-skirball-to-st-anns").
  const currentWords = [...slugTokens(show.venue)].filter((t) => t.length >= 5 && !VENUE_STOPWORDS.has(t));
  const namesCurrent = (flatCurrent.length >= 6 && flatPath.includes(flatCurrent)) || currentWords.some((t) => flatPath.includes(t))
    || (flatCurrent.length >= 6 && flatPath.includes(flatCurrent.slice(0, 5)));
  if (!namesCurrent) {
    for (const { r } of runs) {
      const key = venueKeyTokens(r && r.venue);
      if (key.length > 0 && key.every((t) => segs.has(t))) {
        return { signal: 'prior-run-venue', detail: `url names prior-run venue "${r.venue}"` };
      }
    }
  }
  return null;
}

// Philadelphia Fringe (FringeArts) is a festival run at a different venue; a
// New York transfer's reviews name New York or its own venue, not FringeArts.
// Sibling of audit-show-review-gap.js edinburghFringeUrlSignal, which cannot
// see a show with declared priorRuns.
const PHILLY_FRINGE_SLUG_RE = /(^|[\/\-_])(fringearts|philly[\/\-_]fringe|philadelphia[\/\-_](?:live[\/\-_]arts[\/\-_])?fringe)([\/\-_]|$)/i;
function phillyFringeUrlSignal(url, show) {
  if (!show || !['broadway', 'off-broadway'].includes(show.category)) return null;
  if (/fringe/i.test(`${show.title || ''} ${show.venue || ''}`)) return null;
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  if (!PHILLY_FRINGE_SLUG_RE.test(pathname)) return null;
  const flat = pathname.toLowerCase().replace(/[^a-z0-9]/g, '');
  const venue = foldDiacritics(String(show.venue || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
  if (/newyork|nyc|offbroadway|broadway/.test(flat) || (venue.length >= 6 && flat.includes(venue))) return null;
  return { signal: 'philly-fringe-url', detail: 'url names the Philadelphia Fringe; show is a New York run' };
}

module.exports = { priorRunUrlSignal, phillyFringeUrlSignal };
