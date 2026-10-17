'use strict';
/**
 * Pure helpers for scripts/audit-nyt-pick-coverage.js (BRO-4192).
 *
 * A Critic's Pick badge only shows when the picked NYT review is in our
 * review data under the same URL (rebuild-all-reviews.js matches by canonical
 * URL). This finds picks that match no stored review and proposes the
 * tracked show they most likely belong to, so the review can be ingested.
 *
 * Show matching is a CANDIDATE heuristic for a human to confirm before
 * ingesting (CLAUDE.md §3: never derive stored metadata from URLs). It uses
 * the review date (NYT's /YYYY/MM/DD/ path is the publish date) against the
 * production's run window, and the show title's words against the slug.
 */

const STOP_WORDS = new Set([
  'the', 'and', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'review',
  'broadway', 'theater', 'theatre', 'musical', 'play', 'off',
]);

function canonicalUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    return url.origin.replace('://nytimes.com', '://www.nytimes.com').replace(/^http:/, 'https:')
      + url.pathname.replace(/\/+$/, '');
  } catch {
    return String(u);
  }
}

function words(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w && !STOP_WORDS.has(w));
}

/** { date: 'YYYY-MM-DD', slugWords: [...] } from an NYT review URL, or null. */
function parsePickUrl(u) {
  const m = String(u).match(/\/(\d{4})\/(\d{2})\/(\d{2})\/theater\/([^/?#]+?)(?:\.html)?(?:[?#].*)?$/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, slugWords: words(m[4].replace(/-/g, ' ')) };
}

function daysBetween(a, b) {
  return (Date.parse(a) - Date.parse(b)) / 86400000;
}

/**
 * Is the review date plausibly within this production's review window?
 * Reviews land from first preview (critics sometimes attend early) until
 * shortly after closing. Missing dates fall back to a year around opening.
 */
function inReviewWindow(show, date) {
  // min() of the two, so swapped preview/opening dates still work.
  const earliest = [show.previewsStartDate, show.openingDate].filter(Boolean).sort()[0];
  if (!earliest) return false;
  const end = show.closingDate || null;
  if (daysBetween(date, earliest) < -14) return false;
  if (end) return daysBetween(date, end) <= 14;
  return daysBetween(date, earliest) <= 400;
}

/**
 * Candidate shows for one pick: every title word appears in the slug and the
 * date is inside the run window. Titles of a single very short word are
 * skipped unless the slug is exactly that word plus stop words (avoids
 * "Job" matching every slug containing "job").
 */
function candidateShows(pick, shows) {
  const parsed = parsePickUrl(pick);
  if (!parsed) return [];
  const slug = new Set(parsed.slugWords);
  const out = [];
  for (const show of shows) {
    const tw = words(show.title);
    if (tw.length === 0) continue;
    if (!tw.every(w => slug.has(w))) continue;
    if (tw.length === 1 && tw[0].length < 4 && parsed.slugWords.length > 2) continue;
    if (!inReviewWindow(show, parsed.date)) continue;
    out.push(show);
  }
  return out;
}

/**
 * Split picks into: matched (URL already in reviews), and unmatched with the
 * candidate shows each could belong to. `reviews` needs {showId, outletId, url}.
 */
function sameDay(publishDate, isoDay) {
  if (!publishDate || !isoDay) return false;
  const iso = String(publishDate).match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0] === isoDay;
  const t = Date.parse(String(publishDate).replace(/(\d+)(st|nd|rd|th)/, '$1') + ' UTC');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === isoDay;
}

function auditPickCoverage(pickUrls, reviews, shows) {
  const byUrl = new Map();
  for (const r of reviews) {
    if (r.url) byUrl.set(canonicalUrl(r.url), r);
  }
  const nytByShow = new Map();
  for (const r of reviews) {
    if ((r.outletId || '').startsWith('nytimes')) {
      if (!nytByShow.has(r.showId)) nytByShow.set(r.showId, []);
      nytByShow.get(r.showId).push(r);
    }
  }
  const matched = [];
  const unmatched = [];
  for (const u of pickUrls) {
    const hit = byUrl.get(canonicalUrl(u));
    if (hit) { matched.push({ url: u, showId: hit.showId }); continue; }
    const parsed = parsePickUrl(u);
    const candShows = candidateShows(u, shows);
    // A manual entry can carry a non-nytimes.com URL (gun-and-powder: the
    // theatre's PDF of the review). Count the pick as covered when a candidate
    // show already has an NYT review designated Critics_Pick on the pick's date.
    const proxy = candShows
      .flatMap(s => nytByShow.get(s.id) || [])
      .find(r => r.designation === 'Critics_Pick' && sameDay(r.publishDate, parsed && parsed.date));
    if (proxy) { matched.push({ url: u, showId: proxy.showId, via: proxy.url }); continue; }
    const cands = candShows.map(s => ({
      showId: s.id,
      title: s.title,
      status: s.status,
      existingNytReviews: (nytByShow.get(s.id) || []).map(r => r.url),
    }));
    unmatched.push({ url: u, date: parsed && parsed.date, candidates: cands });
  }
  return { matched, unmatched };
}

module.exports = { sameDay, canonicalUrl, parsePickUrl, inReviewWindow, candidateShows, auditPickCoverage };
