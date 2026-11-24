'use strict';

/**
 * URL→content mismatch detector for collect-review-texts.js (BRO-7060).
 *
 * One entry point, checkUrlContentMismatch(), for "did the fetch at this review
 * URL return an article about THIS show?". It composes the body-mention check
 * (content-quality.js validateContentMentionsShow) with the waivers the
 * collector used to apply inline at two call sites (first fetch and the
 * discovered-URL retry):
 *   - the Guardian API headline waiver (guardian-api-result.js)
 *   - the titledReviews blog waiver (titled-blog-collect.js)
 *   - the dedicated-review headline waiver (new, below)
 *
 * Why the headline waiver exists. The BRO-7055 re-collect rejected 74 files as
 * url_content_mismatch. Re-fetching them showed one dominant false-positive
 * class: a dedicated review whose page <title> names the show ("MIDDLEMARCH
 * Swan, Stratford upon Avon | theatreCat", "Bleak Expectations at the Criterion
 * Theatre – review", "Theatre review: Bat Out of Hell ...") while the critic
 * never repeats the title in the body ("this monumental RSC production", "the
 * show"). The extracted body excludes the headline, so the body count was 0 and
 * the review was nulled. The check exists to catch a CDN misroute / stale cache
 * / wrong-slug redirect serving a DIFFERENT article; such a page carries the
 * other article's <title>, so a <title> that is unambiguously a single-show
 * review headline for this show is the proof the check is looking for.
 *
 * The waiver stays narrow on purpose (each limit maps to a real mismatch seen
 * in the audit):
 *   - text >= 1500 chars: thin pages (listing capsules, paywall teasers, a
 *     1045-char "Into the Woods | Maryland Theatre Guide" listing) still need a
 *     body mention.
 *   - the FULL title must lead the headline (optional "Review:"/"Theatre
 *     review:" prefix). A prefix of a subtitled title is not enough: "One Day –
 *     The Musical" must not pass on "ONE DAY WHEN WE WERE YOUNG at Park
 *     Theatre". A one-word title under 8 chars must be followed by punctuation
 *     or a review/venue word, so "Pity Party review" never proves "Pity".
 *   - OR a long (>= 10 chars, 2+ word) full title appears anywhere in the
 *     headline ("Richard Hawley's Standing at the Sky's Edge is a perfect
 *     musical ...", "The RSC's new Much Ado About Nothing is stunning").
 *     One-word titles never pass this way: "Is A Triumph Of Theatrical
 *     Storytelling" is not a review of "Triumph", "...Can Still Thrive" is not
 *     a review of "Still".
 *   - roundup headlines and multi-show headlines ("Birdland, Another Country
 *     and A Small Family Business - reviews", whose extracted body was the
 *     Another Country section) never qualify.
 *   - only when the body check failed with htmlTitleMatch === true; a <title>
 *     that names a different show keeps rejecting.
 */

const { validateContentMentionsShow } = require('./content-quality');
const { normalizeForMention, buildShowTitleVariants } = require('./show-title-variants');
const { titleHtmlFor, guardianMentionWaiver } = require('./guardian-api-result');
const { titledBlogMentionWaiver } = require('./titled-blog-collect');

// Outlets whose <title> tag is systemically unreliable (moved from
// collect-review-texts.js, BRO-4058 follow-up 2026-09-22): pages-on-stages
// serves a DIFFERENT post's <title> at the fetched URL, so its html is never
// passed to the <title> cross-check.
const UNRELIABLE_TITLE_OUTLETS = new Set(['pages-on-stages']);

const MIN_HEADLINE_ONLY_TEXT = 1500;
const ROUNDUP_HEADLINE_MARKERS = /\b(roundup|shows? to see|things to do|what to see|best (?:plays|musicals|shows|of)|this week|and more|top \d+|\d+ shows)\b/i;
// "Review:", "Theatre review:", "Theater: ", "First night:" before the title.
const HEADLINE_PREFIX_RE = /^(?:(?:theatre|theater|stage|first night)\s+)?(?:review\s+)?/;
// What may follow a short one-word title for it to count as the headline's subject.
const SHORT_TITLE_FOLLOW_RE = /^(?:\s*[,:;|()–—-]|\s+(?:review|reviews|at|by|from|is|in|on|starring)\b|\s*$)/i;

/** Headline forms of the show title: the full title and its no-"The" form (no subtitle prefixes). */
function fullTitleForms(showTitle) {
  return buildShowTitleVariants(showTitle, { includePrefix: false }).filter((v) => v.length > 2);
}

/**
 * PURE. Is this page <title> a single-show review headline that names `showTitle`?
 * @param {string} htmlTitle - decoded page <title>
 * @param {string} showTitle - shows.json title
 * @param {{catalogTitles?: Iterable<string>}} [opts] - other catalog titles, for
 *   the multi-show-headline exclusion
 * @returns {{ok: boolean, why: string}}
 */
function headlineProvesShow(htmlTitle, showTitle, opts = {}) {
  const raw = String(htmlTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw || !showTitle) return { ok: false, why: 'no headline' };
  if (ROUNDUP_HEADLINE_MARKERS.test(raw)) return { ok: false, why: 'roundup headline' };
  const forms = fullTitleForms(showTitle);
  if (!forms.length) return { ok: false, why: 'no title forms' };

  // The headline segment before a "Site | Section" suffix.
  const headSeg = raw.split(/\s+\|\s+/)[0];
  if (namesSeveralShows(headSeg, forms, opts.catalogTitles)) return { ok: false, why: 'multi-show headline' };

  const norm = normalizeForMention(raw).replace(/^["'\s]+/, '');
  const lead = norm.replace(HEADLINE_PREFIX_RE, '');
  // A longer catalog title that contains this one and is what the headline
  // names ("Romeo and Juliet" for "& Juliet") is not this show.
  const longerTitleNamed = (form) => namesLongerTitle(norm, form, forms, opts.catalogTitles);
  for (const form of forms) {
    if (lead !== form && !lead.startsWith(`${form} `)) continue;
    if (longerTitleNamed(form)) continue;
    const core = form.replace(/^the /, '');
    // One-word titles under 10 chars ("Broadway Will Dim the Lights...", "Pity
    // Party review") must be followed by punctuation or a review/venue word.
    const oneWordShort = !core.includes(' ') && core.length < 10;
    if (!oneWordShort) return { ok: true, why: 'headline leads with title' };
    // Re-find the title in the raw headline to inspect what follows it.
    const after = rawTextAfterTitle(raw, form);
    if (after !== null && SHORT_TITLE_FOLLOW_RE.test(after)) return { ok: true, why: 'headline leads with title' };
  }
  // A blog post titled exactly the show after the blog name: "Act Three - The
  // Reviews: Lazarus", "Act Three - The Reviews: Vietgone".
  const colonIdx = headSeg.lastIndexOf(':');
  if (colonIdx > 0) {
    const tail = normalizeForMention(headSeg.slice(colonIdx + 1));
    if (forms.includes(tail)) return { ok: true, why: 'headline is blog name then title' };
  }
  for (const form of forms) {
    const words = form.replace(/^the /, '').split(' ');
    if (words.length < 2 || form.length < 10) continue;
    if (` ${norm} `.includes(` ${form} `) && !longerTitleNamed(form)) return { ok: true, why: 'headline names long title' };
  }
  return { ok: false, why: 'headline does not lead with the full title' };
}

// Text of the raw headline right after the (normalized) title, or null.
function rawTextAfterTitle(raw, form) {
  const words = raw.split(/(\s+)/);
  // Grow a prefix of raw tokens until its normalized form covers the title.
  let acc = '';
  for (let i = 0; i < words.length; i++) {
    acc += words[i];
    const n = normalizeForMention(acc).replace(HEADLINE_PREFIX_RE, '');
    if (n === form) {
      // Punctuation glued to the last title word ("Pity," / "Pity:") is "after".
      const m = words[i].match(/[,:;|()–—-]+$/);
      return (m ? m[0] : '') + words.slice(i + 1).join('');
    }
    if (n.length > form.length) return null;
  }
  return null;
}

function namesLongerTitle(norm, form, forms, catalogTitles) {
  if (!catalogTitles) return false;
  const padded = ` ${norm} `;
  for (const t of catalogTitles) {
    if (t.length <= form.length || forms.includes(t)) continue;
    if (!` ${t} `.includes(` ${form} `)) continue;
    if (padded.includes(` ${t} `)) return true;
  }
  return false;
}

// "Birdland, Another Country and A Small Family Business - reviews": two or more
// list items, one of them another catalog title.
function namesSeveralShows(headSeg, forms, catalogTitles) {
  if (!catalogTitles) return false;
  // Only the list before a dash-separated standfirst/site suffix ("... - reviews",
  // "... – Chicago"): catalog titles such as "Broadway", "News" and "Chicago" in
  // a suffix must not make a single-show headline look like a list.
  const items = headSeg.split(/\s+[-–—]\s+/)[0].split(/\s*,\s*|\s+(?:and|&)\s+/)
    .map((s) => normalizeForMention(s).replace(HEADLINE_PREFIX_RE, ''))
    .filter((s) => s.length >= 4);
  if (items.length < 2) return false;
  const own = new Set(forms);
  const catalog = catalogTitles instanceof Set ? catalogTitles : new Set(catalogTitles);
  return items.some((it) => !own.has(it) && catalog.has(it));
}

let _catalog = null;
let _catalogPath = null;
/** Normalized catalog titles (and their no-"The" forms) from shows.json; honours SHOWS_JSON_PATH. */
function loadCatalogTitles() {
  const { showsJsonPath } = require('./shows-json-path');
  const p = showsJsonPath();
  if (_catalog && _catalogPath === p) return _catalog;
  const set = new Set();
  try {
    const raw = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    for (const s of (raw.shows || raw)) {
      const n = normalizeForMention(s && s.title);
      if (n && n.length >= 4) { set.add(n); set.add(n.replace(/^the /, '')); }
    }
  } catch { /* no catalog: the multi-show exclusion is skipped */ }
  _catalog = set;
  _catalogPath = p;
  return set;
}

/**
 * PURE (given catalogTitles). May a failed body-mention check be waived because
 * the page <title> is a dedicated review headline for this show?
 * @param {{valid: boolean, htmlTitle: string|null, htmlTitleMatch: boolean|null}} sanity
 * @param {string} text - fetched body text
 * @param {string} showTitle
 * @param {{catalogTitles?: Iterable<string>}} [opts]
 */
function dedicatedReviewHeadlineWaiver(sanity, text, showTitle, opts = {}) {
  if (!sanity || sanity.valid || sanity.htmlTitleMatch !== true || !sanity.htmlTitle) return false;
  if (typeof text !== 'string' || text.length < MIN_HEADLINE_ONLY_TEXT) return false;
  return headlineProvesShow(sanity.htmlTitle, showTitle, opts).ok;
}

/**
 * The collector's URL→content mismatch decision.
 * @param {object} args
 * @param {{text: string, html?: string, method?: string, pageTitle?: string}} args.result - fetch result
 * @param {string} args.showTitle - canonical shows.json title
 * @param {string} [args.showId]
 * @param {string} [args.url] - review URL (titledReviews blog waiver)
 * @param {string} [args.outletId]
 * @param {{catalogTitles?: Iterable<string>}} [opts]
 * @returns {object} validateContentMentionsShow's result, plus `waivedBy`
 *   ('guardian-api' | 'titled-blog' | 'review-headline' | null). `valid` is
 *   true when the check passed or was waived.
 */
function checkUrlContentMismatch({ result, showTitle, showId, url, outletId }, opts = {}) {
  const text = result && result.text;
  const trustHtmlTitle = !UNRELIABLE_TITLE_OUTLETS.has(String(outletId || '').toLowerCase());
  const sanity = validateContentMentionsShow(text, trustHtmlTitle ? titleHtmlFor(result) : null, showTitle, showId);
  sanity.waivedBy = null;
  if (sanity.valid) return sanity;
  if (guardianMentionWaiver(result, showTitle)) sanity.waivedBy = 'guardian-api';
  else if (titledBlogMentionWaiver(url, sanity, showTitle)) sanity.waivedBy = 'titled-blog';
  else if (dedicatedReviewHeadlineWaiver(sanity, text, showTitle, {
    catalogTitles: opts.catalogTitles || loadCatalogTitles(),
  })) sanity.waivedBy = 'review-headline';
  if (sanity.waivedBy) {
    sanity.waivedReason = sanity.reason;
    sanity.valid = true;
  }
  return sanity;
}

module.exports = {
  checkUrlContentMismatch,
  dedicatedReviewHeadlineWaiver,
  headlineProvesShow,
  loadCatalogTitles,
  UNRELIABLE_TITLE_OUTLETS,
  MIN_HEADLINE_ONLY_TEXT,
};
