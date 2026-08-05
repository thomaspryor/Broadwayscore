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
const { slugify, levenshteinDistance } = require('./deduplication');
const { normalizeTitle } = require('./title-match');

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
function stripTrailingVenueClause(s) {
  return String(s || '').replace(/\s+at\s+[^,;]*$/i, '');
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
  const substantial = (s) => s.split(' ').filter(Boolean).length >= 2 && s.length >= 10;
  const loosen = (s) => normalizeTitle(stripTrailingVenueClause(unwrapParenTitle(s)));
  const au = loosen(refTitle);
  const bu = loosen(bodyTitle);
  if (au && bu && au === bu && substantial(au)) return 'match';

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
 * Prune an unmatched-audit array (the *-unmatched.json the PV + BWW landing
 * scrapers write) of entries that no longer belong:
 *   - infrastructure slugs (site nav / legal / feeds) — never a show, so they
 *     would otherwise accumulate forever;
 *   - entries whose reference title now slug-collides with a show in
 *     shows.json — the show was matched or manually promoted since the entry
 *     was logged.
 *
 * The "already in shows" gate is DELIBERATELY the SAME exact-slug membership
 * (`slugCollidesWith(referenceTitle(source, entry), existingSlugs)`) that
 * extract-aggregator-candidates.js uses pre-fetch. Using the live token-set
 * matchers (matchSlugToShow / matchTitleToShow) here would be LOOSER than that
 * gate and could silently delete a genuinely new candidate that merely shares
 * title tokens with an existing/closed namesake (e.g. a new "Hamlet at BAM"
 * vs an old "hamlet-2009") before extract ever fetches it — a lost discovery.
 * Baking the exact gate in (rather than a caller-supplied predicate) keeps
 * prune and extract provably in agreement.
 *
 * The scrapers route a now-matched article to their `matched` bucket, never
 * back into `unmatched`, so a pruned entry does NOT come back next run. Pruning
 * the MERGED (existing + this-run) set means infrastructure is dropped every
 * run even though the landing scan re-surfaces it — the file never persists it.
 *
 * @param {Array} entries  the merged unmatched-audit records
 * @param {object} opts
 * @param {'playbill-verdict'|'bww-roundup'} opts.source  picks the referenceTitle strategy
 * @param {Set<string>} opts.existingSlugs  slugs already in shows.json
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
 * @param {Set<string>} args.existingSlugs  slugs already in shows.json
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
const REGIONAL_FEEDER_VENUES = [
  { re: /\bamerican repertory theat(?:er|re)\b/i, city: 'Cambridge, MA', domain: 'americanrepertorytheater.org' },
  { re: /\bla jolla playhouse\b/i, city: 'La Jolla, CA', domain: 'lajollaplayhouse.org' },
  { re: /\bold globe\b/i, city: 'San Diego, CA', domain: 'theoldglobe.org' },
  { re: /\bberkeley rep(?:ertory)?\b/i, city: 'Berkeley, CA', domain: 'berkeleyrep.org' },
  { re: /\bgoodman(?: theatre| theater)?\b/i, city: 'Chicago, IL', domain: 'goodmantheatre.org' },
  { re: /\bsteppenwolf\b/i, city: 'Chicago, IL', domain: 'steppenwolf.org' },
  { re: /\bchicago shakespeare\b/i, city: 'Chicago, IL', domain: 'chicagoshakes.com' },
  { re: /\b(?:arena stage|kreeger|fichandler)\b/i, city: 'Washington, DC', domain: 'arenastage.org' },
  { re: /\bshakespeare theatre company\b/i, city: 'Washington, DC', domain: 'shakespearetheatre.org' },
  { re: /\bamerican conservatory theater\b/i, city: 'San Francisco, CA', domain: 'act-sf.org' },
  { re: /\b5th avenue theatre\b/i, city: 'Seattle, WA', domain: '5thavenue.org' },
  { re: /\bpaper mill playhouse\b/i, city: 'Millburn, NJ', domain: 'papermill.org' },
  { re: /\balliance theatre\b/i, city: 'Atlanta, GA', domain: 'alliancetheatre.org' },
  { re: /\b(?:center theatre group|ahmanson|mark taper)\b/i, city: 'Los Angeles, CA', domain: 'centertheatregroup.org' },
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

function classifyCandidate({ source, record, html, existingSlugs }) {
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

  // Guard against a slug collision overwriting an existing show.
  if (slugCollidesWith(fields.title, existingSlugs)) {
    return { status: 'reject', reason: 'slug-collision', detail: slugify(fields.title) };
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
  const candidate = {
    title: fields.title,
    venue: fields.venue,
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
  pruneUnmatchedAudit,
  referenceTitle,
  classifyCandidate,
  titleCaseShout,
};
