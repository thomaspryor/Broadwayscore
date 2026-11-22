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
  if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) { first = last = label = r.date; } else {
    // A range (blogspot "YYYY-MM", /YYYY/MM/, /YYYY/): a declared earlier run or tour leg inside it could be the
    // review's own production, and the canonical guard only tests single days, so leave these shows to the drain.
    if ((show.priorRuns || []).length || (show.tourLegs || []).length) return null;
    const ym = r.date && String(r.date).match(/^(\d{4})-(\d{2})$/);
    const m = ym ? [null, ym[1], ym[2]] : String(url).match(/\/((?:19|20)\d{2})\/(\d{1,2})\//);
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

/** A venue as a slug phrase: "Royal Exchange Theatre, Manchester" -> "royal-exchange"; "The Old Vic" -> "old-vic". Pure. */
function venuePhrase(venue) {
  const head = String(venue || '').split(/[,(]/)[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '');
  const words = head.split(/[^a-z0-9]+/).filter((w) => w && !['the', 'theatre', 'theater', 'playhouse'].includes(w));
  const phrase = words.join('-');
  return phrase.length >= 5 ? phrase : null;
}
/**
 * The slug names the venue of ANOTHER shows.json entry with this title (twelfth-night-at-the-young-vic filed under
 * the Olivier 2017 run) and not this show's own venue: that entry's review. Only same-title entries count, so an
 * undeclared pre-transfer venue (Death of a Salesman: Young Vic -> Piccadilly) never settles a stub. Pure.
 * @param {{id:string, venue:string}[]} sameTitleShows  other entries sharing this show's title
 */
function siblingVenueReason(url, show, sameTitleShows) {
  if (!show || !Array.isArray(sameTitleShows) || !sameTitleShows.length) return null;
  const slug = `-${finalSlug(url).toLowerCase().replace(/\.html?$/i, '')}-`;
  const mine = venuePhrase(show.venue);
  if (mine && slug.includes(`-${mine}-`)) return null;
  if (/-transfer/.test(slug)) return null; // "transfers-from-the-young-vic": continuity, not another production
  // A tour plays many venues; its reviews name each one.
  if (/tour/i.test(`${show.category || ''} ${show.venue || ''}`)) return null;
  const start = (x) => Date.parse(String((x && (x.previewsStartDate || x.openingDate)) || ''));
  const own = new Set([mine, ...((show.priorRuns || []).map((r) => venuePhrase(r && r.venue))), ...((show.tourLegs || []).map((r) => venuePhrase(r && r.venue)))].filter(Boolean));
  for (const o of sameTitleShows) {
    const p = venuePhrase(o && o.venue);
    if (!p || own.has(p) || (mine && (mine.includes(p) || p.includes(mine)))) continue;
    // The production this one transferred from/to (declared, or a same-title entry opening up to two years
    // earlier): its reviews are continuity coverage the corpus scores (1536 Almeida -> Ambassadors).
    const linked = (a, b) => !!a && a === b;
    if (linked(o.id, show.transferOf) || linked(o.id, show.transferredTo) || linked(o.transferredTo, show.id) || linked(o.transferOf, show.id)) continue;
    const gap = (start(show) - start(o)) / 86400000;
    if (gap >= 0 && gap <= 730) continue;
    if (/tour/i.test(`${o.category || ''} ${o.venue || ''}`)) continue;
    if (`-${titleParts(show.title).join('-')}-`.includes(`-${p}-`)) continue; // "crucible": venue word inside the title
    // Venue context only ("at-the-young-vic", "almeida-theatre"): a bare "harold-pinter" / "noel-coward" is as
    // often the playwright, and "broadway" / "palace" are ordinary words (corpus audit, BRO-8065).
    if (new RegExp(`-at-(?:the-)?${p}-|-${p}-(?:theatre|theater|playhouse)-`).test(slug)) return `url names the ${o.venue} production (${o.id}), not this one`;
  }
  return null;
}
const titleParts = (title) => String(title || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
/**
 * A letters-only title with no word of 3+ letters ("No I.D."): no slug word can match it, so site search files any
 * page under it (67 Daily Mail stubs). True when the rule applies and the url does not spell the title out
 * ("no-i-d", "no-id", "noid"; the first three parts). Digit titles ("9 to 5", "44") are generic-title-guard's. Pure.
 */
function urlMissesShortTitle(url, title) {
  const parts = titleParts(title);
  // 3+ parts: "N/A" (2) has opaque review urls (lightingandsoundamerica story.asp?ID=) in the scored corpus.
  if (parts.length < 3 || parts.some((w) => w.length >= 3 || /\d/.test(w))) return false;
  // Only a descriptive slug (3+ words) can be judged: an opaque url (FT /content/<uuid>, ?id=) says nothing.
  // Whole hyphen/underscore parts of 3+ letters, hex-only parts excluded (a uuid's "abcdef" is no word).
  const words = finalSlug(url).toLowerCase().replace(/\.html?$/i, '').split(/[-_.]+/).filter((w) => /^[a-z]{3,}$/.test(w) && !/^[a-f]+$/.test(w));
  if (words.length < 3) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${parts.slice(0, 3).join('[-_]?')}(?:[^a-z0-9]|$)`);
  return !re.test(String(url || '').toLowerCase());
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
  // A title with no word of 3+ letters ("No I.D.") cannot be matched by any slug word: the url must spell it out.
  if (ctx.show && ctx.show.title && urlMissesShortTitle(url, ctx.show.title)
      && !['submit-review-form', 'manual-user-request'].includes(data.source)) {
    return { verdict: 'junk', reason: `url never spells out the short title "${ctx.show.title}"` };
  }
  const sibling = siblingVenueReason(url, ctx.show, ctx.sameTitleShows);
  if (sibling) return { verdict: 'junk', reason: sibling };
  // Text rules: never when the url names this show (a stage review filed under /movies/, a Tony-winner's review).
  if (!urlNamesShow(url, ctx.show)) {
    const segs = pathSegments(url).slice(0, -1);
    // Variety's 2007-09 theatre reviews live under /YYYY/film/awards/ (scored corpus rows): not a screen section.
    if (segs.some((p) => SCREEN_SEGMENT_RE.test(p)) && !STAGE_CUE_RE.test(slug) && !segs.includes('awards')) return { verdict: 'junk', reason: 'film/TV section URL, not a stage review' };
    if (segs[0] === 'live') return { verdict: 'junk', reason: 'live-blog URL, not a review' };
    if (!REVIEW_TOKEN_RE.test(slug.replace(/\.html?$/i, '')) && AWARDS_SLUG_RE.test(slug.replace(/\.html?$/i, ''))) return { verdict: 'junk', reason: 'awards coverage, not a review' };
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

const _sameTitleMemo = new WeakMap();
/** Other shows.json entries sharing this show's title (the fields siblingVenueReason reads). Memoized per array. */
function sameTitleShowsFrom(show, allShows) {
  if (!show || !show.title || !Array.isArray(allShows)) return [];
  const key = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!_sameTitleMemo.has(allShows)) {
    const idx = new Map();
    for (const x of allShows) {
      const k = key(x && x.title); if (!k) continue;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ id: x.id, venue: x.venue, openingDate: x.openingDate, previewsStartDate: x.previewsStartDate, category: x.category, transferOf: x.transferOf, transferredTo: x.transferredTo });
    }
    _sameTitleMemo.set(allShows, idx);
  }
  return (_sameTitleMemo.get(allShows).get(key(show.title)) || []).filter((o) => o.id !== show.id);
}
module.exports = { sameTitleShowsFrom, venuePhrase, siblingVenueReason, urlDateOutsideWindowReason, urlNamesShow, stubDateIso, bylineIsShowCreator, triagePendingStub, buildHeldUrlIndex, normalizeReviewUrl, isSettledPendingStub, showEra };
