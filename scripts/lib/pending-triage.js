'use strict';
/**
 * pending-triage.js (BRO-8023): classify a _pending stub WITHOUT fetching it.
 *
 * The drain (scripts/replay-pending-bylines.js) fetches one file at a time, so a
 * 16-minute slot never reached most of the 6,786-file queue: thousands of stubs
 * that a URL rule could settle for free sat next to real reviews waiting for a
 * fetch. This is the drain's pre-fetch step, pulled out so it is pure, testable
 * and runnable over the whole queue in one pass (`--triage-only`).
 *
 *   duplicate  url already filed for THIS show   -> drain's redundant-stub rule
 *   junk       never a review of this production -> tagged with a reason, KEPT
 *   candidate  needs a fetch (byline, show match, date) -> drain's promotion path
 *
 * Every junk rule is a shared guard (intake uses the same ones), never a copy.
 */
const { offTopicSectionReason, listingPageUrlReason, nonReviewHostMatch } = require('./non-review-url-patterns');

// BRO-8023 (first batch promotions): Playbill /article/ pages are news (season
// boards, casting); 0 of 49,374 scored review urls are Playbill articles.
const PLAYBILL_ARTICLE_RE = /^https?:\/\/(?:www\.)?playbill\.com\/article\//i;
// A photo-call announcement ("production-images-released-for-grace-pervades-...").
// 0 scored urls match; a "first-look-theatre-..." review slug is left alone.
const ANNOUNCEMENT_SLUG_RE = /(?:^|[-/])(?:production-(?:images|photos|shots)-(?:released|revealed)|first-look-(?:at|photos|images|pictures))(?:-|\/|$)/i;

// Second batch (2026-11-21): the drain promoted two Times interviews and a Deadline closing-date story.
// Over the 49,794 scored urls: 0 have an "interview" token in the final slug without "review(s)"; 1 has
// "closing-date" (itself a news article: independent aspects-of-love-closing-date-refund).
const INTERVIEW_SLUG_RE = /(?:^|-)interview(?:-|$)/i;
const CLOSING_DATE_SLUG_RE = /(?:^|-)closing-date(?:-|$)/i;
const REVIEW_TOKEN_RE = /(?:^|-)reviews?(?:-|$)/i;
function finalSlug(url) {
  try { return new URL(String(url)).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
}

// BRO-8065: url-text rules for the site-search hits the first triage missed (11 of 18 known junk in the
// 2025-26 queue). The section/awards text rules never fire when the url names THIS show (a stage review filed
// under a screen-looking section, a Tony-winner's review), so no real review is rejected on url text alone.
// A screen section on any host (/movies/, /criticism/movies/, /tv/, /film/): a stage cue in the slug keeps it.
const SCREEN_SEGMENT_RE = /^(?:movies?|films?|tv|television|streaming)$/i;
const STAGE_CUE_RE = /theat|stage|musical|broadway|west-?end|opera|ballet|panto|off-broadway|playhouse|play-review/i;
// A TV episode recap ("outlander-blood-of-my-blood-episode-2-review"); 0 scored stage reviews carry it.
const TV_EPISODE_RE = /(?:^|-)(?:episode-\d+|s\d{1,2}-?e\d{1,2}|season-\d+-episode)(?:-|$)/i;
// Awards coverage: a live blog (/live/...), predictions, nominees, a "wins the tony" post, readers' voting.
const AWARDS_SLUG_RE = /(?:^|-)(?:tonys?|oliviers?|drama-desk|obies?|outer-critics-circle)-(?:awards?(?!-winn)|nominations?|nominees|predictions|host|voting|snubs|ceremony|red-carpet)(?:-|$)|(?:^|-)wins?-(?:the-)?(?:tony|olivier)(?:-|$)|(?:^|-)predictions(?:-|$)/i;
// Watch/TV fan sites the corpus has never scored a review from.
const NON_THEATRE_HOSTS = new Set(['watchcrunch.com', 'storiesfromthenewworld.com']);

/** Path segments (lowercased, before the final slug). */
function pathSegments(url) {
  try { return new URL(String(url)).pathname.split('/').filter(Boolean).map((p) => p.toLowerCase()); } catch { return []; }
}

/**
 * The url's own date (/YYYY/MM/DD/, BWW -YYYYMMDD, /YYYY/MM/ month, /YYYY/ year) wholly outside this production's
 * window, judged by the SAME canonical rule the drain applies to a fetched date (isArticleOutsideProductionWindow),
 * plus a one-year margin (below), so a pre-fetch junk verdict is one the post-fetch rule would also reach. A month or year counts only when its first and last day are
 * both outside and on the same side of the run (a year that contains the run is no evidence). Pure.
 */
const URL_DATE_MARGIN_DAYS = 365;
function urlDateOutsideWindowReason(url, show) {
  if (!show || !(show.openingDate || show.previewsStartDate)) return null;
  const { extractDateFromUrl } = require('./url-date');
  const r = extractDateFromUrl(url);
  if (!r || r.date === '2001-01-01') return null; // BWW's placeholder -20010101 suffix is not a date
  let first; let last; let label;
  if (r.date) { first = last = label = r.date; } else {
    const m = String(url).match(/\/((?:19|20)\d{2})\/(\d{1,2})\//);
    const y = m ? Number(m[1]) : Number(r.yearOnly);
    if (!y) return null;
    const mo = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? Number(m[2]) : null;
    const iso = (d) => d.toISOString().slice(0, 10);
    first = iso(new Date(Date.UTC(y, mo ? mo - 1 : 0, 1)));
    last = iso(new Date(Date.UTC(y, mo ? mo : 12, 0)));
    label = mo ? `${y}-${String(mo).padStart(2, '0')}` : String(y);
  }
  if (!isArticleOutsideProductionWindow(show, first) || !isArticleOutsideProductionWindow(show, last)) return null;
  const anchor = require('./date-guard').earliestShowDate(show);
  if (!anchor) return null;
  const end = String(show.closingDate || show.openingDate || anchor);
  const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
  // Margin: over the 49,907 scored urls the canonical window alone flagged 34 real reviews 9-186 days out
  // (undeclared earlier runs, late blog posts); a url date more than a year outside flags 4. Nearer ones are left
  // to the drain, which settles them on the fetched date.
  const before = days(anchor, last); const after = days(first, end);
  if (!(before > URL_DATE_MARGIN_DAYS || after > URL_DATE_MARGIN_DAYS)) return null;
  return `url date ${label} is more than a year outside this production's window`;
}

function hostKey(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; }
}
const _heldHostsMemo = new WeakMap();
/** Hosts with at least one scored review (from the held index's keys). */
function heldHosts(heldIndex) {
  if (!heldIndex) return new Set();
  if (!_heldHostsMemo.has(heldIndex)) _heldHostsMemo.set(heldIndex, new Set([...heldIndex.keys()].map((k) => k.split('/')[0])));
  return _heldHostsMemo.get(heldIndex);
}
const { isBlockedReviewUrl } = require('./domain-filters');
const { isArticleOutsideProductionWindow } = require('./date-guard');
const { urlYearConflict } = require('./url-year-guard');

/**
 * The canonical same-article key (combined-review-utils.normalizeArticleUrl): tracking params dropped, an id
 * query kept, so query-routed archives (LSA story.asp?ID=, post.cfm?id=) do not collapse into one key (BRO-6682).
 */
function normalizeReviewUrl(url) {
  return require('./combined-review-utils').normalizeArticleUrl(url);
}

/** The show title's distinctive words all appear in the url (a double review or roundup naming this show too). Pure. */
function urlNamesShow(url, show) {
  const words = String((show && show.title) || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['the', 'and', 'musical', 'play'].includes(w));
  if (!words.length) return false;
  const u = String(url || '').toLowerCase().replace(/['\u2019]/g, '');
  return words.every((w) => new RegExp(`(?:^|[^a-z0-9])${w}(?:[^a-z0-9]|$)`).test(u));
}

/**
 * Map normalized url -> Set(showId) of every scored review (reviews.json rows;
 * a rebuild-excluded row is not "held"). Pure over the rows passed in.
 */
function buildHeldUrlIndex(reviewRows) {
  const idx = new Map();
  for (const r of reviewRows || []) {
    if (!r || !r.url || !r.showId) continue;
    for (const u of [r.url, r.previousUrl]) {
      const k = normalizeReviewUrl(u);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(r.showId);
    }
  }
  return idx;
}

const SETTLED_KEYS = ['promoteSkippedReason', 'rssIdentityRejected'];
/** A stub the drain already settled (it never fetches it again). Pure. */
function isSettledPendingStub(data) {
  return !!data && SETTLED_KEYS.some((k) => !!data[k]);
}

/**
 * @param {object} data  the _pending stub
 * @param {{showId:string, show?:object, heldIndex?:Map<string,Set<string>>, showTitleOf?:(id:string)=>string}} ctx
 * @returns {{verdict:'duplicate'|'junk'|'candidate', reason:string|null, heldBy?:string[]}}
 */
function triagePendingStub(data, ctx = {}) {
  const url = data && data.url;
  if (!url) return { verdict: 'candidate', reason: null };
  const offTopic = offTopicSectionReason(url);
  if (offTopic) return { verdict: 'junk', reason: `${offTopic} URL, not a review` };
  const listing = listingPageUrlReason(url);
  if (listing) return { verdict: 'junk', reason: `${listing} URL, not a review` };
  if (isBlockedReviewUrl(url)) return { verdict: 'junk', reason: 'aggregator/listing/feature URL, not an outlet review' };
  const slug = finalSlug(url);
  if (!REVIEW_TOKEN_RE.test(slug) && INTERVIEW_SLUG_RE.test(slug)) return { verdict: 'junk', reason: 'interview, not a review' };
  if (!REVIEW_TOKEN_RE.test(slug) && CLOSING_DATE_SLUG_RE.test(slug)) return { verdict: 'junk', reason: 'closing-date news story, not a review' };
  // A show with no dates cannot use the production window; its id year against a /YYYY/ url year still settles
  // a 2-years-off article (observer.com/2024/12/a-complete-unknown-review filed under myth-off-broadway-2026).
  if (ctx.show && !ctx.show.openingDate && !ctx.show.previewsStartDate) {
    const idYear = Number((String(ctx.showId || '').match(/-(\d{4})$/) || [])[1]);
    const bad = idYear ? urlYearConflict(url, idYear, ctx.show.title) : null;
    if (bad) return { verdict: 'junk', reason: `url year ${bad} is more than a year from the show's ${idYear} (show has no dates)` };
  }
  if (PLAYBILL_ARTICLE_RE.test(url)) return { verdict: 'junk', reason: 'Playbill news article, not a review' };
  // BRO-8065 rules (see the constants above). None fires when the slug names this show and says "review".
  // Objective evidence first (a fan-site host, an episode number, the url's own date): these fire even when the
  // slug names the show, exactly as the drain's post-fetch date rule would (28-years-later-review under The Years).
  const host = hostKey(url);
  if (host && NON_THEATRE_HOSTS.has(host)) return { verdict: 'junk', reason: `${host} is a watch/TV fan site, not a theatre review` };
  if (TV_EPISODE_RE.test(slug)) return { verdict: 'junk', reason: 'TV episode recap, not a review' };
  const dateReason = urlDateOutsideWindowReason(url, ctx.show);
  if (dateReason) return { verdict: 'junk', reason: dateReason };
  // A bare numeric / 1-2 letter / generic title ("44", "G", "The Story") the url never spells out: a site-search
  // fluke (BRO-7930; the drain applied this before triage, now one rule for both). Owner/manual stubs are exempt.
  if (ctx.show && ctx.show.title && !['submit-review-form', 'manual-user-request'].includes(data.source)) {
    const gt = require('./generic-title-guard');
    if (gt.genericSingleWordTitle(ctx.show.title, { shortNumeric: true })
        && !gt.passesGenericTitleIdentity(url, ctx.show.title, { shortNumeric: true })) {
      return { verdict: 'junk', reason: `url has no identity for the bare title "${ctx.show.title}"` };
    }
  }
  // Text rules: never when the url names this show (a stage review filed under /movies/, a Tony-winner's review).
  if (!urlNamesShow(url, ctx.show)) {
    const segs = pathSegments(url).slice(0, -1);
    // Variety's 2007-09 theatre reviews live under /YYYY/film/awards/ (scored corpus rows): not a screen section.
    if (segs.some((p) => SCREEN_SEGMENT_RE.test(p)) && !STAGE_CUE_RE.test(slug) && !segs.includes('awards')) return { verdict: 'junk', reason: 'film/TV section URL, not a stage review' };
    if (segs[0] === 'live') return { verdict: 'junk', reason: 'live-blog URL, not a review' };
    if (AWARDS_SLUG_RE.test(slug.replace(/\.html?$/i, ''))) return { verdict: 'junk', reason: 'awards coverage, not a review' };
  }
  if (ANNOUNCEMENT_SLUG_RE.test(url)) return { verdict: 'junk', reason: 'production-photo announcement, not a review' };
  // The census's non-review host list over-reaches on some hosts that do publish reviews (483 scored rows), so it
  // only settles a stub on a host the corpus has never scored a review from (venue sites such as bam.org).
  if (ctx.heldIndex && nonReviewHostMatch(url) && !heldHosts(ctx.heldIndex).has(hostKey(url))) {
    return { verdict: 'junk', reason: 'non-review host (venue/company site) with no scored review, not a review' };
  }
  const held = ctx.heldIndex && ctx.heldIndex.get(normalizeReviewUrl(url));
  if (held && held.size) {
    if (held.has(ctx.showId)) return { verdict: 'duplicate', reason: 'url already scored for this show', heldBy: [ctx.showId] };
    const others = [...held].sort();
    // 425 scored urls belong to 2+ shows (NYT double reviews, Times roundups): a url that names this show too is
    // a candidate, not another show's review.
    // Only when the holder is a different WORK: a same-title holder is an earlier/later production of this show,
    // which is exactly what this rule settles (a 2025 Streetcar review under a-streetcar-named-desire-1973).
    const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const mine = titleKey(ctx.show && ctx.show.title);
    const holderTitles = others.map((id) => titleKey(ctx.showTitleOf ? ctx.showTitleOf(id) : ''));
    const jointWithOtherWork = mine && holderTitles.every((t) => t && t !== mine);
    if (jointWithOtherWork && urlNamesShow(url, ctx.show)) return { verdict: 'candidate', reason: null, heldBy: others };
    return { verdict: 'junk', reason: `url already scored under ${others.slice(0, 3).join(', ')}, not a review of this production`, heldBy: others };
  }
  // A date the stub already carries (site search / aggregator) settles a
  // same-title earlier or later production without a fetch; the drain applies
  // the identical canonical window to the fetched date.
  const pd = data.publishDate;
  // Aggregator stubs store prose dates ("December 14, 2014"): any parseable date naming a 4-digit year counts.
  const pdIso = stubDateIso(pd);
  if (ctx.show && pdIso && isArticleOutsideProductionWindow(ctx.show, pdIso)) {
    return { verdict: 'junk', reason: `article published ${pdIso} is outside this production's window (stub date, no fetch)` };
  }
  return { verdict: 'candidate', reason: null };
}

/**
 * A byline that is a member of the show's own creative team (the playwright on a
 * venue page: "William Shakespeare" on bam.org/Hamlet) means the page is about
 * the show, not a critic's review of it. Pure.
 */
function bylineIsShowCreator(byline, show) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const b = norm(byline);
  if (!b || b === 'unknown' || !show || !Array.isArray(show.creativeTeam)) return false;
  return show.creativeTeam.some((m) => m && norm(m.name) === b);
}

/** A stub's stored date as YYYY-MM-DD, or null when it is absent, unparseable or names no 4-digit year. Pure. */
function stubDateIso(pd) {
  const str = String(pd || '').trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1'); // "August 12th, 2021"
  if (!str || !/(?:^|\D)(?:19|20)\d{2}(?:\D|$)/.test(str)) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T12:00:00Z` : str);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Era bucket of a show id by its year suffix (the queue report's slices). Pure. */
function showEra(showId) {
  const m = String(showId || '').match(/-(\d{4})$/);
  const y = m ? Number(m[1]) : 0;
  if (y >= 2025) return '2025-26';
  if (y >= 2015) return '2015-24';
  return 'pre-2015';
}

module.exports = { urlDateOutsideWindowReason, urlNamesShow, stubDateIso, bylineIsShowCreator, triagePendingStub, buildHeldUrlIndex, normalizeReviewUrl, isSettledPendingStub, showEra };
