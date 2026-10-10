/**
 * review-slot-guards — pure predicates for the BRO-4430 coverage failures,
 * where a real review of the right production was dropped because a date, URL
 * or byline on its file was wrong, or a stale file blocked the outlet's slot.
 *
 * Each predicate is shared by every write path that hit the failure, so the
 * ingest collision check, the file writer, the URL swap and the URL repair
 * writers cannot drift apart again:
 *
 *   isStaleNonReviewSlot   a flagged file whose own url is a non-review page
 *                          (cast announcement, show/listing page, round-up)
 *                          must not block the real review for that outlet
 *                          (The Body of Mary TheaterMania, The Pass NYTG).
 *   isAggregatorPageUrl    an aggregator / round-up page is never an outlet's
 *                          own review url, so no backfill may write it into
 *                          `url` (How the Other Half Loves FT got the
 *                          westendtheatre.com round-up and was then dropped by
 *                          the rebuild's isBlockedReviewUrl gate).
 *   urlOwnedByOtherCritic  a url repair must not repoint a named critic's file
 *                          onto a url a sibling file already holds for a
 *                          DIFFERENT named critic at the same outlet (NYSR:
 *                          Finkle's file took Scheck's url, Sommers' took
 *                          Torre's, and each real review was then lost).
 *   isDatelessRevivalHold  the rebuild's dateless-revival hold only lifts when
 *   shouldRetryDatelessHoldFetch  a date arrives; the collector must fetch the
 *                          stored url for one instead of SERP-rediscovering a
 *                          url nobody doubted (An American Daughter NY Sun sat
 *                          held forever after its SERP rediscovery abandoned).
 */

const DAY_MS = 86400000;
const DATELESS_HOLD_RETRY_COOLDOWN_MS = 14 * DAY_MS;

function _classify(url) {
  const { classifyReviewUrl } = require('./non-review-url-patterns');
  return classifyReviewUrl(url);
}

function _sameUrl(a, b) {
  const { sameUrlKey } = require('./review-url-collision');
  const ka = sameUrlKey(a);
  return !!ka && ka === sameUrlKey(b);
}

/**
 * True when `url` is an aggregator or round-up page: a host the rebuild
 * refuses outright (domain-filters isBlockedReviewUrl) or a round-up/hub page
 * (review-guards isRoundupUrl). Neither can be any outlet's own review url.
 * @param {string} url
 * @returns {boolean}
 */
function isAggregatorPageUrl(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const { isBlockedReviewUrl } = require('./domain-filters');
  if (isBlockedReviewUrl(url)) return true;
  const { isRoundupUrl } = require('./review-guards');
  const r = isRoundupUrl(url);
  return !!(r && r.isRoundup);
}

/**
 * True when `existing` is a flagged record whose own url is not a review page,
 * and `incomingUrl` is a different url that IS a review candidate. Such a
 * file's flag describes the non-review page, not a prior production of the
 * review, so it must neither block the incoming review nor keep its slot.
 * @param {object} existing  review-text record already on disk
 * @param {string} incomingUrl
 * @returns {boolean}
 */
function isStaleNonReviewSlot(existing, incomingUrl) {
  if (!existing || typeof existing !== 'object') return false;
  if (!existing.url || !incomingUrl) return false;
  if (existing._locked === true || existing.urlManualOverride === true) return false;
  // Duplicates are not stale slots: their pointer names the real record.
  if (existing.duplicateOf) return false;
  const flagged = existing.wrongProduction === true
    || existing.wrongShow === true
    || existing.isNonReview === true;
  if (!flagged) return false;
  if (_sameUrl(existing.url, incomingUrl)) return false;
  // classifyReviewUrl only (it already covers round-ups): isBlockedReviewUrl
  // also blocks some REAL review shapes (playbill.com/news/article, /features/),
  // and a flagged prior-production review there must keep blocking.
  // BRO-4431: a classifier's "not a review" verdict on the file is the same
  // evidence when the url shape can't give it (westendbestfriend.co.uk files
  // news and reviews alike under /news/: a National Theatre Live broadcast
  // post held the Golden Boy review's slot, issue 913).
  // A wrongProduction/wrongShow record also marked isNonReview only counts
  // when its content verdict agrees (wrong_content): CV promotion can mis-set
  // isNonReview on a real prior-production review, which must keep blocking.
  const nonReviewVerdict = existing.isNonReview === true
    && ((existing.wrongProduction !== true && existing.wrongShow !== true)
      || existing.incompleteReason === 'wrong_content');
  if (_classify(existing.url).ok && !nonReviewVerdict) return false;
  const incomingVerdict = _classify(incomingUrl);
  return incomingVerdict.ok === true && !isAggregatorPageUrl(incomingUrl);
}

function _namedCritic(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  const { normalizeCritic } = require('./review-normalization');
  return normalizeCritic(t);
}

/**
 * The sibling file that already holds `url` for a different NAMED critic, or
 * null. An Unknown on either side proves nothing about identity, so it never
 * counts as a conflict (the byline may simply be unresolved).
 * @param {object} args
 * @param {string} args.showDir       data/review-texts/<showId>
 * @param {string} args.url           candidate url for this file
 * @param {string} args.selfFilename  this file's basename
 * @param {string} args.selfCriticName this file's criticName
 * @param {object} [args.fs]          injected fs for tests
 * @returns {{filename: string, criticName: string}|null}
 */
function urlOwnedByOtherCritic({ showDir, url, selfFilename, selfCriticName, fs: fsImpl } = {}) {
  const self = _namedCritic(selfCriticName);
  if (!self || !showDir || !url) return null;
  const fs = fsImpl || require('fs');
  const path = require('path');
  let files;
  try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
  catch { return null; }
  for (const file of files) {
    if (file === selfFilename) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); }
    catch { continue; }
    if (!data || !data.url || !_sameUrl(data.url, url)) continue;
    // A sibling already known to be wrong cannot own the url.
    if (data.duplicateOf || data.wrongAttribution === true) continue;
    const other = _namedCritic(data.criticName);
    if (other && other !== self) return { filename: file, criticName: data.criticName };
  }
  return null;
}

/**
 * True when the record is held by the rebuild's dateless-revival guard
 * (rebuild-all-reviews.js, reason 'dateless-revival').
 * @param {object} d
 * @returns {boolean}
 */
function isDatelessRevivalHold(d) {
  if (!d || d.wrongProduction !== true) return false;
  if (d.wrongProductionReason === 'dateless-revival') return true;
  return typeof d.wrongProductionNote === 'string'
    && d.wrongProductionNote.startsWith('Dateless revival guard');
}

/**
 * True when the collector should fetch a dateless-revival hold's STORED url
 * to recover its publish date. The hold's only open question is the date, so
 * the url is not in doubt and SERP rediscovery is the wrong tool; one fetch
 * per 14 days (the same wrongShowRetryAt clock the other flag retries use).
 * @param {object} d
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function shouldRetryDatelessHoldFetch(d, nowMs = Date.now()) {
  if (!isDatelessRevivalHold(d)) return false;
  if (d.publishDate) return false;
  if (!d.url || !/^https?:\/\//i.test(d.url)) return false;
  if (d._locked === true) return false;
  const last = d.wrongShowRetryAt ? Date.parse(d.wrongShowRetryAt) : NaN;
  return !Number.isFinite(last) || nowMs - last > DATELESS_HOLD_RETRY_COOLDOWN_MS;
}

// Lowercased url path with every non-alphanumeric run as one hyphen, framed by
// hyphens so a phrase can be matched on whole-token boundaries.
function _urlPathSlug(url) {
  if (!url || typeof url !== 'string') return '';
  let p;
  try { p = new URL(url).pathname; } catch { return ''; }
  return `-${p.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-`;
}

function _phraseSlug(s) {
  if (!s || typeof s !== 'string') return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// "The Other Palace - Main Theatre" -> "other-palace"; "Duke of York's Theatre" -> "duke-of-yorks".
function _venueSlug(venue) {
  if (!venue || typeof venue !== 'string') return '';
  const head = venue.split(/\s[-–—]\s|,/)[0];
  return _phraseSlug(head).replace(/^the-/, '').replace(/-(theatre|theater)$/, '');
}

// Same article under a cosmetic url variant: http/https, www, query string,
// trailing slash, an /amp suffix, thetimes.co.uk vs thetimes.com. A query is
// kept only where it IS the article id (post.cfm?p=29317, ?id=, ?ID=).
function _articleKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url || '').toLowerCase(); }
  const host = u.hostname.toLowerCase().replace(/^(www|amp|m)\./, '').replace(/^thetimes\.co\.uk$/, 'thetimes.com');
  const p = u.pathname.toLowerCase().replace(/\/amp\/?$/, '').replace(/\/+$/, '');
  const id = ['p', 'id', 'ID', 'articleid'].map((k) => u.searchParams.get(k)).find(Boolean);
  return `${host}${p}${id ? `?${id}` : ''}`;
}

function _slugHas(pathSlug, phrase) {
  return !!phrase && phrase.length >= 4 && pathSlug.includes(`-${phrase}-`);
}

/**
 * True when an incoming review should take over an outlet+critic slot held by
 * a flagged record about another show or production (BRO-4956).
 *
 * The slot is the filename <outlet>--<critic>.json. One critic reviewing two
 * productions that both land in this show's folder (London Box Office's
 * Stuart King on Juniper Blood in 2025 and Blood of my Blood in 2026) used to
 * lose the second review for good: detectIngestCollision refused it while it
 * was dateless, and once dated the writer merged it into the flagged file and
 * refused with "Stale merge". The flagged file has nothing to keep for this
 * show, so it is retired to the graveyard and the incoming review is written
 * clean.
 *
 * The incoming review must be provably this production:
 *   - dated inside opening-30d .. opening+365d (the existing in-window rule), or
 *   - dateless, its url naming this show's full title where the flagged file's
 *     url does not (a different show), or naming this show's venue where the
 *     flagged file's url names neither (a different production of the title).
 * A dated review outside the window, or any url-level other-production signal,
 * never takes the slot, so the Beaches 2026-04-22 protection holds: a prior
 * production's review cannot clear a flag by arriving under a new url.
 *
 * @param {object} existing  flagged record already on disk
 * @param {{url: string, publishDate?: string, outletId?: string, criticNamed?: boolean}} incoming
 *   criticNamed false = the incoming byline is unresolved (Unknown)
 * @param {object} show      shows.json row (title, venue, openingDate, ...)
 * @returns {boolean}
 */
function flaggedSlotSupersededBy(existing, incoming, show) {
  if (!existing || typeof existing !== 'object' || !incoming || !show) return false;
  if (existing.wrongProduction !== true && existing.wrongShow !== true) return false;
  if (existing._locked === true || existing.urlManualOverride === true || existing.duplicateOf) return false;
  if (existing.wrongProductionManualClear || existing.wrongShowManualClear) return false;
  // A human confirmed this flag: never undo it by moving the file.
  if (existing.humanReviewedWrongProduction === true || existing.wrongProductionOverride === true) return false;
  const inUrl = incoming.url;
  if (!inUrl || !/^https?:\/\//i.test(inUrl)) return false;
  if (existing.url && (_sameUrl(existing.url, inUrl) || _articleKey(existing.url) === _articleKey(inUrl))) return false;
  // Same date as the flagged record: likely the same (re-dated) article, not a second review.
  if (incoming.publishDate && existing.publishDate && String(incoming.publishDate).slice(0, 10) === String(existing.publishDate).slice(0, 10)) return false;
  if (_classify(inUrl).ok !== true || isAggregatorPageUrl(inUrl)) return false;
  // A flagged non-review page keeps its own in-place url swap (BRO-4430/4431).
  if (isStaleNonReviewSlot(existing, inUrl)) return false;
  const { otherProductionSignal, URL_SIGNALS } = require('./other-production-signal');
  if (otherProductionSignal({ url: inUrl, outletId: incoming.outletId }, show, { only: URL_SIGNALS })) return false;
  if (require('./review-normalization').reviewSlugNamesDifferentShow(inUrl, show.title)) return false;

  const inSlug = _urlPathSlug(inUrl);
  const exSlug = _urlPathSlug(existing.url);
  const title = _phraseSlug(show.title);

  const openingMs = show.openingDate ? Date.parse(show.openingDate) : NaN;
  if (incoming.publishDate) {
    const pd = require('./date-utils').toDateMs(incoming.publishDate);
    if (Number.isFinite(pd) && Number.isFinite(openingMs)) {
      const inWindow = pd >= openingMs - 30 * DAY_MS && pd <= openingMs + 365 * DAY_MS;
      // An unresolved byline proves nothing about identity (BRO-3182), so it
      // also needs the url to name this show.
      return inWindow && (incoming.criticNamed !== false || _slugHas(inSlug, title));
    }
  }

  if (!_slugHas(inSlug, title)) return false;
  // The flagged url names the show at all (even by a short title or one token):
  // same title, so only the venue can tell the productions apart.
  const exNamesShow = _slugHas(exSlug, title) || require('./review-normalization').urlSlugNamesShow(existing.url, show.title);
  if (!exNamesShow) return true;
  const venue = _venueSlug(show.venue);
  return _slugHas(inSlug, venue) && !_slugHas(exSlug, venue);
}

module.exports = {
  isAggregatorPageUrl,
  isStaleNonReviewSlot,
  flaggedSlotSupersededBy,
  urlOwnedByOtherCritic,
  isDatelessRevivalHold,
  shouldRetryDatelessHoldFetch,
  DATELESS_HOLD_RETRY_COOLDOWN_MS,
};
