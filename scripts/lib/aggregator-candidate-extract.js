'use strict';

/**
 * Pure extraction logic for turning aggregator (Playbill Verdict + BWW
 * Review-Roundup) unmatched-article audit entries into OB-discovery
 * candidates.
 *
 * This module does NO IO — the driver (scripts/extract-aggregator-candidates.js)
 * fetches article HTML via scripts/lib/scraper.js and feeds it here. Keeping
 * the logic pure makes it fixture-testable (CLAUDE.md §15 / the
 * test-extraction pattern) — the test passes captured BWW/PV HTML and asserts
 * the classification, with zero network.
 *
 * The shape that comes OUT (an "accept") is a staging-candidate object
 * compatible with venue-listing-discover.js#writeStagingCandidates — so the
 * promoter (promote-ob-venue-candidates.js) reads ONE staging file and never
 * learns aggregator-specific shapes. See plan-review 2026-05-28.
 *
 * Design notes (from the 6-reviewer plan review):
 *  - Bot-shell detection is THREE independent signals (size + h1 + date),
 *    because fetchPage() returns HTTP 200 with a Cloudflare/Bright-Data
 *    interstitial shell when blocked, and a greedy venue regex would mint
 *    garbage {title,venue,date} triples out of footer text. (pre-mortem P0)
 *  - BWW slugs use `-On-Broadway` / `-Off-Broadway` PLACEHOLDER tails where a
 *    venue would otherwise be. Those are NOT venues and NOT typos — the venue
 *    must come from the article body. (structure-review P0)
 *  - Typo detection is Levenshtein 1..3 on the NORMALIZED title (apostrophes
 *    and punctuation stripped first) so "Dad Don't Read This" vs slug
 *    "Dad Dont Read This" is a MATCH (0 edits), while "Autopbiography" vs
 *    "Autobiography" is a TYPO (1 edit). (pre-mortem secondary)
 */

const { JSDOM } = require('jsdom');
const { slugify, levenshteinDistance, aliasCanonical } = require('./deduplication');
const { normalizeTitle } = require('./title-match');
const { normalizeVenueName } = require('./venue-classification');

// Aggregator-infrastructure URLs that land in the unmatched audit but are not
// shows (site nav, legal, feeds). Matched against the article slug.
const INFRASTRUCTURE_SLUG_RE = new RegExp(
  '(?:^|[-/])(?:' +
  'site-?map|privacy-?policy|terms-of-(?:use|service)|cookie-policy|' +
  'rss-?feeds?|upcoming-cast-recordings|cast-recordings|advertise|' +
  'contact-us|about-us|newsletter|subscribe|sign-?up|sweepstakes' +
  ')(?:[-/]|$)',
  'i'
);

// Words that terminate a venue name in a headline ("... at St. Luke's Theatre").
const VENUE_TYPE_WORD =
  'Theatres?|Theaters?|Halls?|Houses?|Centers?|Centres?|Warehouses?|' +
  'Playhouses?|Stages?|Studios?|Clubs?|Auditoriums?|Workshops?|Rooms?|' +
  'Factory|Armory|Public|Rep';

// "at <Venue>" — used to split a BWW/PV headline into show title + venue.
// Two venue shapes: a LEADING type word + number/qualifier ("Theatre 71",
// "Stage 42", "Theatre Row") OR a trailing type word ("St. Luke's Theatre",
// "6th Floor Theater"). The trailing-type capture is TEMPERED — it can't span
// the word "at" — so "Dinner at Eight at the Todd Haimes Theatre" matches only
// "the Todd Haimes Theatre" (not "Eight at the Todd Haimes Theatre"), and the
// caller takes the LAST match so the title keeps its internal "at". Global so
// the caller can iterate matches. (ship-check P1)
const HEADLINE_VENUE_RE = new RegExp(
  '\\bat\\s+(?:the\\s+)?' +
  '(' +
    '(?:Theatres?|Theaters?|Stages?)\\s+(?:\\d+|Row|East|West)' +        // "Theatre 71", "Stage 42"
    '|' +
    '[A-Z0-9](?:(?!\\bat\\b)[\\w\'.&\\- ])*?(?:' + VENUE_TYPE_WORD + ')' + // "St. Luke's Theatre"
  ')(?=[\\s,.;:—–-]|$)',
  'ig'
);

/** Find the venue in `text`. For a headline, pass preferLast=true so the
 *  title (which may itself contain "at") keeps everything before the venue
 *  clause. Returns { venue, index } or null. */
function findVenueMatch(text, preferLast) {
  const re = new RegExp(HEADLINE_VENUE_RE.source, 'ig');
  let m, chosen = null;
  while ((m = re.exec(text)) !== null) {
    if (!chosen || preferLast) chosen = { venue: cleanVenue(m[1]), index: m.index };
    if (!preferLast) break;
  }
  return chosen;
}

// BWW placeholder tails: the slug names no theater, just the market.
const BWW_PLACEHOLDER_TAIL_RE =
  /-(?:opens-)?(?:on|off)-broadway(?:-\d{0,8})?$|-broadway-?\d{0,8}$|-in-nyc(?:-\d{0,8})?$/i;

function isInfrastructureSlug(slug) {
  return INFRASTRUCTURE_SLUG_RE.test(String(slug || ''));
}

/**
 * THREE-signal bot-shell / block-page detector. Returns true (== "this is not
 * a real article, reject it") if ANY signal is missing. fetchPage() returns
 * 200 with a stripped interstitial when Bright Data / Cloudflare blocks it;
 * trusting such a page is how garbage candidates reach shows.json.
 */
function isBotShell(html) {
  if (!html || html.length < 5000) return true;
  let doc;
  try {
    doc = new JSDOM(html).window.document;
  } catch {
    return true;
  }
  const h1 = doc.querySelector('h1');
  if (!h1 || !h1.textContent.trim()) return true;
  // Date signal: <meta article:published_time> OR any JSON-LD datePublished.
  const meta = doc.querySelector('meta[property="article:published_time"]');
  if (meta && meta.getAttribute('content')) return false;
  if (extractDateFromJsonLd(doc)) return false;
  return true; // no date anywhere → treat as shell
}

/** Properly title-case a SHOUTY BWW show name without breaking apostrophes:
 *  "DAD DON'T READ THIS" → "Dad Don't Read This" (not "Don'T"). */
function titleCaseShout(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|\s)([a-z])/g, (_, pre, c) => pre + c.toUpperCase())
    .trim();
}

/** Strip BWW head/tail and return the show-title portion of a roundup slug,
 *  plus whether the slug used a market placeholder instead of a venue. */
function parseBwwSlugTitle(rawSlug) {
  let s = String(rawSlug || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/?article\//, '')
    .replace(/^Review-Roundup-/i, '')
    // Colon-less editorializing lead-ins some regional roundups use in place
    // of "Review-Roundup-" (task #722, "Critics-Sound-Off-On-La-Jollas-3-
    // SUMMERS-OF-LINCOLN"). Must mirror the headline strip in
    // extractArticleFields — otherwise the slug-derived reference title and
    // the body-extracted title diverge enough to trip classifyTitleDelta's
    // mismatch guard on a real, correctly-parsed show.
    .replace(/^(?:The-)?Critics-(?:Sound-Off-On|React-To|Weigh-In-On|Are-Talking-About|Rave-About)-/i, '')
    .replace(/^The-Reviews-Are-In-For-/i, '')
    // Same class: a leading feeder-city possessive ("La-Jollas-SHOW"). Only
    // known regional feeder cities strip — never touches an unrelated title
    // that happens to start with a capitalized word.
    .replace(REGIONAL_CITY_SLUG_LEAD_RE, '');
  const placeholder = BWW_PLACEHOLDER_TAIL_RE.test(s);
  // Drop trailing date, then drop a venue/placeholder tail to isolate title.
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(BWW_PLACEHOLDER_TAIL_RE, '');
  // Strip the venue tail at the LAST "-(opens-)?at-" — NOT the first. A title
  // that itself contains "at" ("DINNER-AT-EIGHT-At-St-Lukes-Theatre") must keep
  // its internal "at"; the venue is always the final "at <theater>" clause.
  // (ship-check: greedy-from-first-at truncated "Dinner at Eight" → "Dinner",
  // which then false-rejected the candidate as title-mismatch.)
  const atRe = /-(?:opens-)?at-/ig;
  let lastAt = -1, am;
  while ((am = atRe.exec(s)) !== null) lastAt = am.index;
  if (lastAt >= 0) s = s.slice(0, lastAt);
  const title = titleCaseShout(s.replace(/-/g, ' '));
  return { title, placeholder };
}

function extractDateFromJsonLd(doc) {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed;
    try { parsed = JSON.parse(script.textContent); } catch { continue; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const dates = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.datePublished) dates.push(item.datePublished);
      if (item.dateCreated) dates.push(item.dateCreated);
      // BWW LiveBlogPosting: per-critic dates under liveBlogUpdate[].
      const updates = item.liveBlogUpdate || item.liveBlogUpdates || [];
      for (const u of Array.isArray(updates) ? updates : []) {
        if (u && u.datePublished) dates.push(u.datePublished);
      }
    }
    if (dates.length) {
      // Earliest = the article's first publish moment (≈ opening coverage).
      dates.sort();
      return dates[0];
    }
  }
  return null;
}

function extractHeadline(doc) {
  // Prefer JSON-LD headline (clean, no site-name suffix), then h1, then <title>.
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed;
    try { parsed = JSON.parse(script.textContent); } catch { continue; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item && typeof item.headline === 'string' && item.headline.trim()) {
        return item.headline.trim();
      }
    }
  }
  const h1 = doc.querySelector('h1');
  if (h1 && h1.textContent.trim()) return h1.textContent.trim();
  const title = doc.querySelector('title');
  return title ? title.textContent.trim() : '';
}

/**
 * Pull {title, venue, date} out of an article's HTML. Returns nulls for any
 * field that couldn't be extracted — the caller decides accept vs reject.
 * Title/venue both come from the headline ("Review Roundup: SHOW at VENUE");
 * venue falls back to first-paragraph prose if the headline names no theater.
 */
function extractArticleFields(html) {
  let doc;
  try { doc = new JSDOM(html).window.document; } catch { return { title: null, venue: null, date: null }; }

  let headline = extractHeadline(doc);
  // Drop the "Review Roundup:" / "Reviews:" lead-in.
  headline = headline.replace(/^\s*(?:review\s+roundup|reviews?|first\s+look)\s*:\s*/i, '');
  // Drop colon-less editorializing lead-ins some regional roundups use
  // instead ("Critics Sound Off On X", not "Review Roundup: X") — task #722,
  // "3 Summers of Lincoln". Without this the whole lead-in phrase becomes
  // part of the extracted title.
  headline = headline.replace(
    /^\s*(?:the\s+)?critics\s+(?:sound\s+off\s+on|react\s+to|weigh\s+in\s+on|are\s+talking\s+about|rave\s+about)\s+/i,
    ''
  ).replace(/^\s*the\s+reviews\s+are\s+in\s+for\s+/i, '');

  const date = extractMetaDate(doc) || extractDateFromJsonLd(doc);

  // Venue: from the headline "… at VENUE" (last such clause), else the lede.
  const hv = findVenueMatch(headline, /* preferLast */ true);
  let venue;
  let title;
  if (hv) {
    venue = hv.venue;
    // Title is everything before the venue clause — keeps an internal "at"
    // (e.g. "Dinner at Eight"). Strip the trailing verb ("Opens"/"Arrives") +
    // any "the" that introduced the venue.
    title = headline.slice(0, hv.index)
      .replace(/\s+(?:opens?|arrives?|returns?|begins?|premieres?|comes\s+to|now\s+playing)\s*$/i, '')
      .replace(/[,—–\-:\s]+$/, '')
      .trim();
  } else {
    venue = extractVenueFromBody(doc);
    title = extractTitleFromHeadline(headline);
    // Regional roundups sometimes front-load the venue's city as a
    // possessive instead of an "at VENUE" clause ("La Jolla's 3 SUMMERS OF
    // LINCOLN" — task #722), which the boundary regex above doesn't strip
    // since it isn't a verb/dash/comma. Only strip it when the independently
    // -extracted venue confirms the leading word is a known feeder city, not
    // part of the show title itself (e.g. never touches "Chicago The Musical").
    if (venue && title) {
      const city = feederVenueCity(venue);
      const cityName = city ? city.split(',')[0].trim() : null;
      if (cityName) {
        const leadRe = new RegExp(`^${cityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|\u2019s)\\s+`, 'i');
        if (leadRe.test(title)) title = title.replace(leadRe, '').trim();
      }
    }
  }

  if (title) title = titleCaseIfShout(title);
  return {
    title: title || null,
    venue: venue || null,
    date: date || null,
  };
}

// Boundary markers for the NO-venue-in-headline case (placeholder slugs like
// "… Opens Off-Broadway"). Deliberately does NOT include a bare " at " — when
// there is no venue clause, an "at" is part of the title (e.g. "Dinner at
// Eight") and must not cut it. (ship-check P1)
const TITLE_BOUNDARY_RE =
  /\s+(?:opens?|arrives?|returns?|begins?|comes\s+to|now\s+playing|premieres?)\b|\s+(?:on|off)[-\s]broadway\b|\s*[—–]\s*|,\s+(?:starring|featuring|with)\b/i;

function extractTitleFromHeadline(headline) {
  const h = String(headline || '').trim();
  const m = h.match(TITLE_BOUNDARY_RE);
  const cut = m ? h.slice(0, m.index) : h;
  return cut.replace(/[,—–\-:\s]+$/, '').trim();
}

function extractMetaDate(doc) {
  const meta = doc.querySelector('meta[property="article:published_time"]');
  const c = meta && meta.getAttribute('content');
  return c && c.trim() ? c.trim() : null;
}

/**
 * Scan only the LEDE for "at (the) <Venue>". A review-roundup lede is about
 * the subject show ("SHOW … opened at VENUE"); scanning deeper risks grabbing
 * a different production's theater from a "fresh off her run at the Booth"
 * aside. First <p> only, first 400 chars, FIRST match. (ship-check P1)
 */
function extractVenueFromBody(doc) {
  const firstP = doc.querySelector('article p, p');
  const text = firstP ? (firstP.textContent || '').replace(/\s+/g, ' ').slice(0, 400) : '';
  const hv = findVenueMatch(text, /* preferLast */ false);
  if (hv) return hv.venue;

  // Fallback: meta description. Some BWW templates (regional Review Roundups
  // in particular — "3 Summers of Lincoln" / La Jolla Playhouse, task #722)
  // don't wrap review content in a real <article>/<p> at all: the DOM's
  // first <p> in document order is nav/breadcrumb chrome ("Broadway + NYC"),
  // so the body-paragraph scan above finds nothing. The meta description is
  // publisher-authored summary text that reliably states "...now playing at
  // VENUE..." even when the visible markup doesn't.
  const meta =
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    '';
  if (!meta) return null;

  // Meta description is a single unstructured sentence, unlike the article
  // body — a stray "fresh off her run at [OTHER VENUE]" aside is more likely
  // to land here than in a review's opening paragraph. If the description
  // names more than one distinct venue, which one is "the" venue is
  // genuinely ambiguous — bail rather than silently trusting whichever the
  // regex happened to match first (ship-check adversarial review P1, task
  // #722). A null venue just means this candidate falls through to
  // rejection, never a wrong write.
  const re = new RegExp(HEADLINE_VENUE_RE.source, 'ig');
  const distinctVenues = new Set();
  let m;
  while ((m = re.exec(meta)) !== null) {
    distinctVenues.add(cleanVenue(m[1]));
  }
  if (distinctVenues.size > 1) return null;

  const mv = findVenueMatch(meta, /* preferLast */ false);
  return mv ? mv.venue : null;
}

function cleanVenue(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').replace(/^the\s+/i, '').trim();
  return v || null;
}

function titleCaseIfShout(s) {
  // If the title is mostly uppercase (BWW SHOUT), title-case it; otherwise
  // leave the publisher's casing (Playbill uses normal case).
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) return titleCaseShout(s);
  return s;
}

/**
 * A typo iff the normalized reference title and body title differ by a SMALL
 * edit distance (1..3). 0 == clean match. >3 == genuinely different strings
 * (slug abbreviation, wrong article) — that's a 'title-mismatch', not a typo.
 */
/**
 * Same normalization, but with parenthesised text UNWRAPPED rather than
 * dropped: "Two Strangers (Carry a Cake Across New York)" -> "two strangers
 * carry a cake across new york".
 *
 * normalizeTitle() strips parentheticals on purpose — they are usually venue or
 * composer noise ("Cable Street (59e59)"). But some shows carry a parenthesised
 * SUBTITLE that is genuinely part of the name, and sources disagree on whether
 * to include the brackets. BWW's slug spells it out while its body keeps the
 * brackets, so the two normalized to "two strangers carry a cake across new
 * york" vs "two strangers at a r t" — a 30-char edit distance on what is in
 * fact the same show (observed live, run 31029032996: the CORRECT roundup was
 * rejected as title-mismatch, so the show could not be auto-added).
 */
function unwrapParenTitle(s) {
  return String(s || '').replace(/[()[\]]/g, ' ');
}

/**
 * Drop a trailing " at <venue>" clause: BWW body titles are headline-shaped
 * ("TWO STRANGERS (...) at A.R.T.") while the slug carries the bare title.
 * Applied only to the loosened comparison below, never to the strict one, and
 * only to the TRAILING clause — a title with "at" mid-string is untouched.
 */
/**
 * Does a trailing "at X" clause actually name a VENUE?
 *
 * This is the guard that makes venue-stripping safe. "Dinner at Eight" and
 * "Meet Me at the Fair" are real shows whose "at" clause is part of the NAME;
 * blindly stripping it made a request for "Dinner" match the "Dinner at Eight"
 * roundup, which would have written the WRONG show into shows.json. A venue
 * clause names a theatre — so require it to look like one: a theatre keyword,
 * a known Broadway-feeder venue, or a house initialism ("A.R.T.", "BAM").
 * Anything else is treated as part of the title and left alone.
 */
const VENUE_KEYWORD_RE =
  /\b(?:theat(?:re|er)s?|playhouse|cent(?:er|re)|stage|hall|arena|rep(?:ertory)?|globe|forum|opera|auditorium|pavilion|amphitheat(?:re|er)|festival|drama)\b/i;
const VENUE_INITIALISM_RE = /^(?:the\s+)?(?:[A-Z]\.){2,}[A-Z]?\.?$|^(?:the\s+)?[A-Z]{2,6}$/;

function isVenueLikeClause(clause) {
  const c = String(clause || '').trim().replace(/[.,;]+$/, '');
  if (!c) return false;
  // A known feeder venue or a house initialism ("A.R.T.") is conclusive.
  if (feederVenueCity(c)) return true;
  if (VENUE_INITIALISM_RE.test(c)) return true;
  // Otherwise a venue keyword is necessary but NOT sufficient: a real venue
  // clause names a specific house ("the St. James Theatre", "La Jolla
  // Playhouse"), whereas a BARE keyword is ordinary English that belongs to the
  // title — "Meet Me at the Forum" and "A Night at the Stage" both stripped to
  // a one-word stem and false-matched, the same defect as "Dinner"/"Dinner at
  // Eight" (ship-check adversarial review, 2026-08-05). Require a proper-noun
  // word ALONGSIDE the keyword, ignoring a leading article.
  const words = c.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
  return words.length >= 2 && VENUE_KEYWORD_RE.test(c);
}

/**
 * Drop a trailing " at <venue>" clause — but ONLY when that clause really names
 * a venue (see isVenueLikeClause). BWW body titles are headline-shaped
 * ("TWO STRANGERS (...) at A.R.T.") while the slug carries the bare title.
 * Applied only to the loosened comparison below, never to the strict one, and
 * only to the TRAILING clause — a title with "at" mid-string is untouched.
 */
function stripTrailingVenueClause(s) {
  const str = String(s || '');
  const m = /\s+at\s+([^,;]*)$/i.exec(str);
  if (!m) return str;
  if (!isVenueLikeClause(m[1])) return str;
  return str.slice(0, m.index);
}

/**
 * Trailing editorial furniture aggregators bolt onto a headline:
 * "THE OUTSIDERS World Premiere", "GYPSY Opens Tonight",
 * "HADESTOWN Celebrates Opening Night". These describe the EVENT, not the
 * show, so the slug ("The-Outsiders") and the body headline disagree by
 * several words and classifyTitleDelta called it a mismatch — which is why a
 * request for "The Outsiders" was refused against its own correct La Jolla
 * roundup (dry run, 2026-08-05).
 *
 * Deliberately a CLOSED list of known phrases, not a general "strip trailing
 * words" rule: an open-ended trim would eat real subtitles. Applied only to the
 * loosened comparison, which demands exact equality and a substantial stem.
 */
const EDITORIAL_SUFFIX_RE =
  /\s+(?:(?:world|us|u\.s\.|american|west\s+coast|east\s+coast|broadway|off-broadway|london|regional|national)\s+)?(?:premiere|revival|transfer|tour)\b|\s+(?:opens?|opening|begins?|starts?|launches?|celebrates?|kicks?\s+off)(?:\s+(?:tonight|today|night|performances|previews|its\s+run))?\b|\s+opening\s+night\b/gi;

function stripEditorialSuffix(s) {
  let out = String(s || '');
  // Repeat: "World Premiere Opens" needs two passes ("...Opens" then "...Premiere").
  for (let i = 0; i < 4; i++) {
    const next = out.replace(EDITORIAL_SUFFIX_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * The title to WRITE for a candidate: the show's name, not the headline.
 *
 * Aggregator headlines describe an event at a venue, so the raw extracted title
 * carries both ("THE OUTSIDERS World Premiere",
 * "TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T."). Written straight
 * through, that becomes the public show title AND the id/slug derived from it.
 *
 * Reuses the exact strippers the loosened matcher uses, so what we write is
 * consistent with what we match on. Shouty all-caps is restored to title case
 * via the existing titleCaseShout. Parentheses are deliberately NOT unwrapped —
 * a parenthesised subtitle is part of the real name
 * ("Two Strangers (Carry a Cake Across New York)").
 *
 * Never returns empty: if stripping would leave nothing, the original wins.
 * A slightly noisy title is recoverable; a blank one corrupts the catalog.
 */
const EDITORIAL_VOCAB = new Set([
  'world', 'us', 'american', 'west', 'east', 'coast', 'broadway', 'london',
  'regional', 'national', 'premiere', 'revival', 'transfer', 'tour', 'opens',
  'opening', 'night', 'begins', 'starts', 'launches', 'celebrates', 'kicks',
  'off', 'performances', 'previews', 'the', 'its', 'run', 'a', 'an',
]);

/** Is every remaining word editorial furniture? Then we stripped the title. */
function isAllEditorial(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => EDITORIAL_VOCAB.has(w));
}

function cleanCandidateTitle(raw) {
  const original = String(raw || '').trim();
  if (!original) return original;
  const stripped = stripEditorialSuffix(stripTrailingVenueClause(original)).trim();
  // Keep the original when stripping leaves nothing, or leaves only more
  // editorial words — a show actually named "World Premiere" must not become
  // "World". A slightly noisy title is recoverable; a mangled one is not.
  const base = stripped && !isAllEditorial(stripped) ? stripped : original;
  const letters = base.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return base;
  // titleCaseShout only capitalises after whitespace, so "(CARRY" would become
  // "(carry". Capitalise after an opening bracket or quote too.
  return titleCaseShout(base).replace(/([([{"'\u2018\u201c])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

function classifyTitleDelta(refTitle, bodyTitle) {
  const a = normalizeTitle(refTitle || '');
  const b = normalizeTitle(bodyTitle || '');
  if (!a || !b) return 'unknown';
  if (a === b) return 'match';

  // Second opinion with parenthesised subtitles unwrapped. This can only ever
  // turn a mismatch/typo into a closer verdict, never reject something the
  // primary comparison accepted — the strict check above already returned.
  // EXACT equality only — deliberately NOT fed into the edit-distance branch
  // below. Stripping a venue clause shortens both strings, and on short titles
  // that turns a clear mismatch into a "typo": "Cats" vs "Dogs at the Palace"
  // collapses to "cats" vs "dogs", distance 3, which add-requested-show.js
  // accepts (it rejects only on 'mismatch'). Loosening is safe when it demands
  // the two titles be identical, and unsafe the moment it feeds a threshold.
  //
  // AND the surviving stem must be substantial. stripTrailingVenueClause()
  // cannot tell a venue from a title: "Dinner at Eight" and "Meet Me at the
  // Fair" are real shows whose "at" clause is part of the NAME. Without this
  // guard a request for "Dinner" matched the roundup for "Dinner at Eight" —
  // a false accept that would write the WRONG show into shows.json, which is
  // the exact failure this guard exists to prevent (ship-check adversarial
  // review, 2026-08-05). Two words and ten characters is enough to keep the
  // real case ("two strangers carry a cake across new york", "sunset blvd")
  // while refusing every one-word stem. Erring toward rejection is right here:
  // a refused add costs a manual entry, a false accept corrupts the catalog.
  const loosen = (s) =>
    normalizeTitle(stripEditorialSuffix(stripTrailingVenueClause(unwrapParenTitle(s))));
  const au = loosen(refTitle);
  const bu = loosen(bodyTitle);
  if (au && bu && au === bu) return 'match';

  const d = levenshteinDistance(a, b);
  if (d >= 1 && d <= 3) return 'typo';
  return 'mismatch';
}

function slugCollidesWith(title, existingSlugs) {
  if (!title) return false;
  return existingSlugs.has(slugify(title));
}

/**
 * Build the slug set used by every already-in-shows gate (extractor pre-fetch
 * skip, classify slug-collision, pruneUnmatchedAudit). Promoted regional/OB
 * shows carry `-regional-<year>` / `-off-broadway-<year>` suffixed slugs that
 * slugify(title) never equals — without the stripped variants every promoted
 * show re-fetches + re-stages + skip-duplicates DAILY, forever (QA 2026-07-08).
 */
function collisionSlugSet(shows) {
  const set = new Set();
  for (const s of Array.isArray(shows) ? shows : []) {
    if (!s || !s.slug) continue;
    set.add(s.slug);
    const stripped = s.slug.replace(/-(?:regional|off-broadway)-\d{4}$/, '');
    if (stripped !== s.slug) set.add(stripped);
    // Also index by TITLE-derived slug: a retitled show ("CrazySexyCool: The
    // TLC Musical", slug base "crazysexycool") must still collide with its
    // roundup's parsed title, or the article re-fetches daily (2026-07-10).
    if (s.title) set.add(slugify(s.title));
  }
  return set;
}

/**
 * Off-broadway/regional shows only — every candidate this pipeline discovers
 * is one of these two categories (classifyVenueMarket never assigns anything
 * else), so this is the correct universe for an "already known" check BEFORE
 * an article's venue is known (pre-fetch skip, audit-file pruning). Excluding
 * Broadway/West End shows closes the cross-market half of the blind spot
 * described below even though venue itself still can't be checked at these
 * two call sites.
 */
function obRegionalShows(shows) {
  return (Array.isArray(shows) ? shows : []).filter(
    (s) => s && (s.category === 'off-broadway' || s.category === 'regional')
  );
}

/**
 * Venue equality for findKnownObShow — deliberately NOT title-match.js's
 * canonicalVenue(). That function's fallback for a venue outside the curated
 * VENUE_ALIASES table is just the lowercased FIRST WORD (title-match.js
 * canonicalVenue, ~line 250), so two unrelated theatres that both start with
 * "The" collapse to the same key. Fine for canonicalVenue's original callers
 * (fuzzy duplicate-detection candidates a human reviews); unsafe here — a
 * false venue MATCH is the one thing standing between a title collision and
 * a silent reject/prune, so it would quietly reintroduce the exact bug this
 * file's venue-scoping exists to prevent (ship-check finding, task #1246,
 * 2026-08-11: verified canonicalVenue("The Duke on 42nd Street") ===
 * canonicalVenue("The Public Theater")).
 *
 * Reuses two already-shipped, separately-tested helpers instead of adding a
 * third normalization scheme: aliasCanonical() (deduplication.js) requires a
 * REAL VENUE_ALIASES hit on both sides — no lossy fallback — and
 * normalizeVenueName() (venue-classification.js) is an exact (punctuation/
 * whitespace/Theatre-vs-Theater insensitive) full-string comparison for
 * venues the alias table doesn't cover.
 */
function venuesMatch(a, b) {
  if (!a || !b) return false;
  const aliasA = aliasCanonical(a);
  const aliasB = aliasCanonical(b);
  if (aliasA || aliasB) return aliasA !== null && aliasA === aliasB;
  const normA = normalizeVenueName(a);
  return normA !== '' && normA === normalizeVenueName(b);
}

/**
 * The full venue-scoped "already known" check: title AND venue must both
 * match an off-broadway/regional show, never title alone — a bare title
 * match against the full 2,800+ show catalog collides with any unrelated
 * same-named show in any market or decade (ship-check P0, task #101,
 * 2026-08-11: a title-only prune dropped a brand-new "Hamlet" candidate
 * because an unrelated 2009 "Hamlet" shared its slug). Only usable once an
 * article's venue is known — i.e. AFTER fetch (classifyCandidate).
 *
 * @param {string} title
 * @param {string} venue
 * @param {Array} shows
 * @returns {{id:string}|null}
 */
function findKnownObShow(title, venue, shows) {
  if (!title || !venue) return null;
  const normalized = normalizeTitle(title);
  for (const s of obRegionalShows(shows)) {
    if (!s.title) continue;
    if (venuesMatch(venue, s.venue) && normalizeTitle(s.title) === normalized) {
      return { id: s.id };
    }
  }
  return null;
}

/**
 * Prune an unmatched-audit array (the *-unmatched.json the PV + BWW landing
 * scrapers write) of entries that no longer belong:
 *   - infrastructure slugs (site nav / legal / feeds) — never a show, so they
 *     would otherwise accumulate forever;
 *   - entries whose reference title now slug-collides with a show in
 *     shows.json — the show was matched or manually promoted since the entry
 *     was logged.
 *
 * TITLE-ONLY, deliberately: the raw unmatched-audit record ({url, slug,
 * title?}) has no venue — the article hasn't been fetched yet, and this
 * function never fetches (it runs inline in the scraper, before any HTML is
 * available). findKnownObShow() can't be used here for that reason.
 *
 * Callers MUST pass a MARKET-SCOPED existingSlugs (built from
 * `collisionSlugSet(obRegionalShows(shows))`, not the full catalog) — this is
 * the mitigation for the venue gap: it closes the cross-market half of the
 * blind spot (a new OB show can no longer collide with an old closed
 * Broadway/West End namesake) but NOT the within-OB/regional cross-venue
 * half (P1 task #1246, 2026-08-11, follow-up to the P0 above). That residual
 * risk is accepted here because pruning only controls audit-file growth /
 * re-fetch cost, not correctness — a wrongly-pruned genuinely-new show still
 * gets a second chance the moment extract-aggregator-candidates.js fetches
 * and venue-scopes it via findKnownObShow() (classifyCandidate) BEFORE this
 * function's next run prunes it again. A same-run ordering gap can still
 * lose that window (see extract-aggregator-candidates.js's pre-fetch gate for
 * the analogous tradeoff); closing it fully would require fetching here,
 * which defeats this function's purpose (cheap, network-free pruning).
 *
 * The scrapers route a now-matched article to their `matched` bucket, never
 * back into `unmatched`, so a pruned entry does NOT come back next run. Pruning
 * the MERGED (existing + this-run) set means infrastructure is dropped every
 * run even though the landing scan re-surfaces it — the file never persists it.
 *
 * @param {Array} entries  the merged unmatched-audit records
 * @param {object} opts
 * @param {'playbill-verdict'|'bww-roundup'} opts.source  picks the referenceTitle strategy
 * @param {Set<string>} opts.existingSlugs  MARKET-SCOPED slugs already in shows.json (off-broadway/regional only)
 * @returns {{kept: Array, pruned: number}}
 */
function pruneUnmatchedAudit(entries, { source, existingSlugs } = {}) {
  const slugs = existingSlugs instanceof Set ? existingSlugs : new Set();
  const kept = [];
  let pruned = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    if (isInfrastructureSlug(e.slug) || isInfrastructureSlug(e.url)) { pruned++; continue; }
    const ref = referenceTitle(source, e);
    if (ref && slugCollidesWith(ref, slugs)) { pruned++; continue; }
    kept.push(e);
  }
  return { kept, pruned };
}

/**
 * Remove already-classified candidates from the STAGING file
 * (data/audit/ob-venue-candidates.json) whose (title, venue) now matches a
 * show already in shows.json. This is the staging-file counterpart to
 * pruneUnmatchedAudit (which cleans the *-unmatched.json audit inputs).
 *
 * Why this exists: the daily CI promotion (promote-ob-venue-candidates.js
 * --regional-only) explicitly skips every non-regional candidate untouched —
 * `if (regionalOnly && c.category !== 'regional') { remainingStaged.push(c);
 * continue; }` — so findExistingMatch() (the jaccard/subtitle dedupe against
 * shows.json) never runs for OB candidates on the scheduled path. The only
 * code that removes a stale OB candidate is the operator-run default mode,
 * which nothing schedules. A candidate whose show gets added to shows.json
 * through ANY other route (manual add, feedback pipeline, a later promote run
 * for a DIFFERENT batch) then sits in staging — and in the health-check "OB
 * Discovery — Action Needed" digest — forever. Found 2026-08-11: "Dad Don't
 * Read This" (closed 2026-06) and "Rosie O'Donnell: Common Knowledge" (closed)
 * were both still staged, false-positive noise for shows that were never
 * missing.
 *
 * MUST be venue-scoped, not title-only (adversarial ship-check review
 * 2026-08-11): shows.json holds 2,800+ productions across every market and
 * decade, so a bare slugCollidesWith(title) check would prune a brand-new
 * production that merely shares a title with an unrelated closed show
 * anywhere in the catalog ("Hamlet", "The Seagull", ...) — silently erasing
 * exactly the discovery signal this task exists to surface. Requiring
 * venuesMatch(candidate.venue, existing.venue) too means a title collision
 * alone is never enough to delete (see venuesMatch's header for why that's
 * NOT the same as title-match.js's looser canonicalVenue()).
 *
 * Deliberately exact (normalized-title + venue) match only — not the fuller
 * jaccard/subtitle-variant match promote-ob-venue-candidates.js's
 * findExistingMatch() uses. This runs on every extract-aggregator-
 * candidates.js invocation (daily, no extra fetches) and only needs to catch
 * the common case: the exact show, at the exact venue, now exists. A
 * near-miss that only jaccard would catch stays staged for the operator
 * path — a false negative here is harmless (residual staged noise); a false
 * positive silently drops a real new show, so this stays conservative.
 *
 * @param {Array} staged  data/audit/ob-venue-candidates.json contents
 * @param {Array} shows  shows.json shows array
 * @returns {{kept: Array, pruned: Array}}
 */
function pruneStagedCandidates(staged, shows) {
  const kept = [];
  const pruned = [];
  for (const c of Array.isArray(staged) ? staged : []) {
    if (!c || typeof c !== 'object') continue;
    if (!c.title) { kept.push(c); continue; }
    const match = findKnownObShow(c.title, c.venue, shows);
    if (match) {
      pruned.push({ ...c, matchedShowId: match.id });
    } else {
      kept.push(c);
    }
  }
  return { kept, pruned };
}

/**
 * The best title we can name BEFORE fetching: PV ships a `title` on the audit
 * record; BWW only a slug (parse it). Lets the driver skip a fetch when the
 * show is already in shows.json — which is the common case for an unmatched
 * URL that lingers in the audit file after the show was manually promoted.
 * (ship-check P0 — without this, every promoted show re-fetches weekly.)
 */
function referenceTitle(source, record) {
  if (record && record.title) return record.title;
  if (source === 'bww-roundup') return parseBwwSlugTitle(record.slug || '').title;
  return null;
}

/**
 * Classify ONE unmatched audit record into accept (a staging candidate) or
 * reject (with a reason). Pure: `html` is supplied by the driver.
 *
 * @param {object} args
 * @param {'playbill-verdict'|'bww-roundup'} args.source
 * @param {object} args.record  the raw audit entry {url, slug, title?, reason?, firstSeen?}
 * @param {string|null} args.html  fetched article HTML (null if fetch skipped/failed)
 * @param {Array} args.shows  shows.json shows array — venue is known by this
 *   point (fields.venue, checked above), so the slug-collision guard below can
 *   be fully venue-scoped via findKnownObShow, unlike the pre-fetch gates that
 *   only have a title to go on.
 * @returns {{status:'accept', candidate:object} | {status:'reject', reason:string, detail?:string}}
 */
// Broadway-feeder regional theatres (the "out-of-market but Broadway-bound"
// watchlist, memory/project_regional_expansion_watchlist.md). A candidate whose
// venue matches gets category 'regional' instead of 'off-broadway': the OB
// promoter's Playbill-OB/Lortel cross-validation can never confirm a DC or
// Chicago production, so these auto-promote off the roundup page itself
// (promote-ob-venue-candidates.js --regional-only; user rule 2026-07-08: a PV
// Verdict / BWW Review Roundup page IS the go-live signal) — before that,
// CrazySexyCool (Arena Stage) sat undiscovered in staging for 6 days (2026-07).
// One table drives BOTH classification (classifyVenueMarket) and the promoted
// show entry's "Venue, City, ST" string (feederVenueCity) — a venue can never
// classify regional without a city and vice versa.
// NOTE: no bare "A.R.T." pattern — "A.R.T./New York Theatres" is a real NYC
// Off-Broadway rental complex; PV/BWW articles spell Cambridge's venue out.
//
// EACH ENTRY MATCHES THE COMPANY NAME **AND** ITS STAGE/HALL NAMES (2026-08-05,
// owner decision). Aggregators routinely name the hall, not the company:
// BroadwayWorld filed Two Strangers under "A.R.T.'s Loeb Drama Center", which
// matched nothing here, so a genuine Cambridge tryout classified 'off-broadway'
// and was refused by add-requested-show. The company was already allowlisted —
// only its stage name was missing. Users talk this way too ("The Weiss at La
// Jolla", GH #542). Stage names are included ONLY where unambiguous: generic
// ones ("Owen Theatre", "The Yard", "White Theatre") are deliberately omitted
// rather than risk classifying an unrelated production as a Broadway feeder.
const REGIONAL_FEEDER_VENUES = [
  // Loeb Drama Center is A.R.T. Cambridge's mainstage — safe where bare
  // "A.R.T." is not, since A.R.T./New York has no hall by that name.
  { re: /\bamerican repertory theat(?:er|re)\b|\bloeb drama cent(?:er|re)\b/i, city: 'Cambridge, MA', domain: 'americanrepertorytheater.org' },
  // Mandell Weiss Theatre/Forum + Potiker Theatre are La Jolla Playhouse halls.
  { re: /\bla jolla playhouse\b|\bmandell weiss\b|\bweiss (?:theat(?:re|er)|forum)\b|\bpotiker theat(?:re|er)\b/i, city: 'La Jolla, CA', domain: 'lajollaplayhouse.org' },
  // Lowell Davies Festival Theatre + Shiley Stage are Old Globe stages.
  { re: /\bold globe\b|\blowell davies\b|\bshiley stage\b/i, city: 'San Diego, CA', domain: 'theoldglobe.org' },
  // Roda + Peet's are Berkeley Rep's two houses.
  { re: /\bberkeley rep(?:ertory)?\b|\broda theat(?:re|er)\b|\bpeet'?s theat(?:re|er)\b/i, city: 'Berkeley, CA', domain: 'berkeleyrep.org' },
  { re: /\bgoodman(?: theatre| theater)?\b|\balbert theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'goodmantheatre.org' },
  { re: /\bsteppenwolf\b/i, city: 'Chicago, IL', domain: 'steppenwolf.org' },
  { re: /\bchicago shakespeare\b/i, city: 'Chicago, IL', domain: 'chicagoshakes.com' },
  { re: /\b(?:arena stage|kreeger|fichandler)\b/i, city: 'Washington, DC', domain: 'arenastage.org' },
  { re: /\bshakespeare theatre company\b/i, city: 'Washington, DC', domain: 'shakespearetheatre.org' },
  { re: /\bamerican conservatory theater\b|\btoni rembe\b/i, city: 'San Francisco, CA', domain: 'act-sf.org' },
  { re: /\b5th avenue theatre\b/i, city: 'Seattle, WA', domain: '5thavenue.org' },
  { re: /\bpaper mill playhouse\b/i, city: 'Millburn, NJ', domain: 'papermill.org' },
  { re: /\balliance theatre\b|\bcoca-?cola stage\b/i, city: 'Atlanta, GA', domain: 'alliancetheatre.org' },
  { re: /\b(?:center theatre group|ahmanson|mark taper)\b/i, city: 'Los Angeles, CA', domain: 'centertheatregroup.org' },
  // UK feeder venues (added 2026-08-13, card #1405): Game of Thrones: The Mad
  // King (RSC, world premiere) sat 3 days with reviews-but-no-shows.json-entry
  // because this table was US-only — classifyVenueMarket() fell through to
  // 'off-broadway' for the RSC venue, and the OB promoter's Playbill-OB/Lortel
  // cross-validation can never confirm a UK production, so it silently never
  // promoted. "City" has no state suffix (UK, not US) — feederVenueCity()
  // and buildRegionalShowEntry just concatenate venue+city either way.
  // "RSC" alone is intentionally excluded (too short, collides with other
  // acronym usage in article prose the way bare "A.R.T." would). Swan
  // Theatre/The Other Place are RSC's other Stratford stages but are too
  // generic a name to allowlist bare (same rationale as "Owen Theatre" etc
  // above) — only the flagship hall is matched until a real BWW/PV article
  // is seen using the stage name instead of the company name.
  { re: /\broyal shakespeare (?:company|theatre|theater)\b/i, city: 'Stratford-upon-Avon', domain: 'rsc.org.uk' },
  { re: /\bchichester festival theatre\b/i, city: 'Chichester', domain: 'cft.org.uk' },
];

// Dash-joined city names from the table above, for stripping a leading
// possessive in a BWW slug ("La-Jollas-3-SUMMERS-OF-LINCOLN" — task #722).
// Multi-word cities first so "San-Diego" doesn't shadow-match "San-..." alone.
const REGIONAL_CITY_SLUG_LEAD_RE = (() => {
  const cities = [...new Set(REGIONAL_FEEDER_VENUES.map((v) => v.city.split(',')[0].trim()))]
    .sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/\s+/g, '-'));
  return new RegExp(`^(?:${cities.join('|')})s-`, 'i');
})();

/** City string for a Broadway-feeder regional venue, or null if not one. */
function feederVenueCity(venue) {
  if (!venue) return null;
  const hit = REGIONAL_FEEDER_VENUES.find(v => v.re.test(venue));
  return hit ? hit.city : null;
}

function classifyVenueMarket(venue) {
  return feederVenueCity(venue) ? 'regional' : 'off-broadway';
}

function classifyCandidate({ source, record, html, shows }) {
  const slug = record.slug || '';
  if (isInfrastructureSlug(slug) || isInfrastructureSlug(record.url || '')) {
    return { status: 'reject', reason: 'infrastructure' };
  }
  // PV low-confidence entries already matched a show — not a new candidate.
  if (record.reason === 'low-confidence') {
    return { status: 'reject', reason: 'low-confidence-existing-match' };
  }

  // Reference title for typo detection: PV ships a `title`; BWW only a slug.
  let refTitle = record.title || null;
  let slugPlaceholder = false;
  if (source === 'bww-roundup') {
    const parsed = parseBwwSlugTitle(slug);
    refTitle = refTitle || parsed.title;
    slugPlaceholder = parsed.placeholder;
  }

  if (!html) {
    return { status: 'reject', reason: 'fetch-failed' };
  }
  if (isBotShell(html)) {
    return { status: 'reject', reason: 'bot-shell' };
  }

  const fields = extractArticleFields(html);
  if (!fields.title) {
    return { status: 'reject', reason: 'no-title' };
  }

  // Typo check BEFORE venue check so a typo'd slug (CELEBRITY-AUTOPBIOGRAPHY)
  // surfaces as 'typo-detected' for a human to fix the scraper, rather than
  // hiding behind a 'no-venue' rejection. (acceptance #2)
  const delta = classifyTitleDelta(refTitle, fields.title);
  if (delta === 'typo') {
    return { status: 'reject', reason: 'typo-detected', detail: `slug="${refTitle}" body="${fields.title}"` };
  }
  if (delta === 'mismatch') {
    return { status: 'reject', reason: 'title-mismatch', detail: `slug="${refTitle}" body="${fields.title}"` };
  }

  if (!fields.venue) {
    return { status: 'reject', reason: slugPlaceholder ? 'placeholder-venue-no-theater' : 'no-venue' };
  }
  if (!fields.date) {
    return { status: 'reject', reason: 'no-date' };
  }

  // Guard against a slug collision overwriting an existing show. Venue-scoped
  // (title AND venue must both match) — fields.venue is known here, so unlike
  // the pre-fetch gates this can use the full check (P1 task #1246,
  // 2026-08-11): a title-only guard here would reject a brand-new same-named
  // show at a different venue, exactly the P0 findKnownObShow's header
  // describes.
  const knownMatch = findKnownObShow(fields.title, fields.venue, shows);
  if (knownMatch) {
    return { status: 'reject', reason: 'slug-collision', detail: `${slugify(fields.title)} @ ${knownMatch.id}` };
  }

  // Shape matches a venue-listing-discover staging entry. The promoter recomputes
  // canonicalVenue(venue) itself, so we don't carry a (would-go-stale) copy.
  //
  // corroborations: other sources that also surfaced this same candidate
  // (e.g. a critic-listing post AND a later BWW roundup for the same show).
  // Provenance DATA on the record, not a property of a shared gate — a
  // promotion rule can read it, but no rule REQUIRES it to be non-empty
  // (S2, task #995: a rule whose corroborators nobody builds confirms
  // nothing — see decideCriticListingPromotion in ob-cross-validation.js).
  // Optional; defaults to [] so every existing caller/candidate is unaffected.
  // The DISPLAY title, cleaned of headline furniture. fields.title comes from a
  // news headline, so it carries the event description and the venue clause:
  // the two shows added on 2026-08-05 landed in the public catalog as
  // "THE OUTSIDERS World Premiere" and
  // "TWO STRANGERS (CARRY A CAKE ACROSS NEW YORK) at A.R.T." — which is what a
  // visitor would have read on the show page, and what the id/slug were derived
  // from. Only the written record is cleaned; every comparison above still runs
  // on the raw headline, so no classification or dedupe decision shifts.
  const displayTitle = cleanCandidateTitle(fields.title);
  const candidate = {
    title: displayTitle,
    venue: fields.venue,
    // Slug stays derived from the RAW headline, NOT the cleaned title. The
    // nightly crawl's already-in-shows gate compares slugify(RAW headline)
    // against collisionSlugSet(shows), which indexes each show's slug, its
    // market-suffix-stripped slug, and slugify(show.title). Cleaning the slug
    // too removes every raw-derived member of that set, so the gate stops
    // matching the very headline the show came from and the article re-fetches,
    // re-stages and re-dedupes EVERY NIGHT, forever — the exact failure
    // collisionSlugSet's own header warns about (QA 2026-07-08). Verified:
    // with a cleaned slug, slugCollidesWith('THE OUTSIDERS World Premiere')
    // returns false against the show it created.
    //
    // So identity (slug -> id) is deliberately unchanged and only the
    // user-visible title is cleaned. Renaming ids is a separate migration:
    // review records and audit trails reference them.
    slug: slugify(fields.title),
    source,
    sourceUrl: record.url || null,
    articlePublishedAt: fields.date,
    discoveredAt: record.firstSeen || fields.date || new Date().toISOString(),
    category: classifyVenueMarket(fields.venue),
    corroborations: [],
  };
  return { status: 'accept', candidate };
}

module.exports = {
  cleanCandidateTitle,
  INFRASTRUCTURE_SLUG_RE,
  REGIONAL_FEEDER_VENUES,
  feederVenueCity,
  classifyVenueMarket,
  isInfrastructureSlug,
  isBotShell,
  parseBwwSlugTitle,
  extractArticleFields,
  classifyTitleDelta,
  slugCollidesWith,
  collisionSlugSet,
  obRegionalShows,
  venuesMatch,
  findKnownObShow,
  pruneUnmatchedAudit,
  pruneStagedCandidates,
  referenceTitle,
  classifyCandidate,
  titleCaseShout,
};
