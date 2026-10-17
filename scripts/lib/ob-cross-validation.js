'use strict';

/**
 * Cross-validation gate for venue-discovered OB candidates.
 *
 * Why: User Impact reviewer P0 — a venue-page redesign that leaks
 * "Spring Gala 2026" as a fake show would otherwise land in shows.json,
 * trigger the opening-night orchestrator, and fire a real broadcast to
 * subscribers. Cross-validating against Playbill OB + Lortel before
 * promoting prevents this class of incident.
 *
 * Rule: a candidate promotes to shows.json ONLY if its title (normalized)
 * appears in either Playbill OB's schedule article OR Lortel's
 * currently-playing list within `windowHours` of the candidate's
 * discoveredAt timestamp. Otherwise it stays in staging.
 *
 * Admin escape hatch: scripts/promote-ob-venue-candidates.js --admin-force
 * bypasses this gate for a named title (e.g. a legitimate Atlantic show
 * that Playbill hasn't picked up yet).
 */

const { normalizeTitle, titleTokens, jaccard, foldDiacritics } = require('./title-match');
const { isKnownOffBroadwayVenue, OFF_BROADWAY_VENUES } = require('./venue-classification');
const { isShoutedTitle, isExemptFromTitleCase } = require('./title-display-case');
const { venuesMatch } = require('./deduplication');
// venue-write-guard-ok: venue strings here feed match decisions and gate
// shapes only; shows.json writes go through buildShowEntry's sanitizeVenueForWrite.

const JACCARD_FUZZY_MATCH_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Junk filters for venue-page candidates (BRO-4396)
// ---------------------------------------------------------------------------
// A venue's own site lists more than its productions: galas, festivals,
// readings, screenings, classes, CMS placeholders, a tour stop at another
// theatre. These patterns reject those before ANY corroboration route can
// confirm them, so widening what counts as evidence (TheaterMania, the
// venue's own dated listing) does not widen what gets in. Each pattern names
// a real row seen in data/audit/ob-venue-candidates.json.
const VENUE_CANDIDATE_JUNK = [
  [/\bfestival\b|(?<!mani)fest\b/i, 'festival'],                         // "Freshplay Festival 2026", "...Mixfest 2026", "FUERZAFest"; not "Manifest"
  [/\bgala\b|\bbenefit\b|fundraiser|^miscast\s*\d*$/i, 'gala/benefit'],     // "Miscast26" (MCC's annual gala)
  [/\bscreenings?\b|\bfilm series\b|\bcinema\b/i, 'screening'],
  [/\b(?:staged|play|concert|public|new play) readings?\b|\breading series\b/i, 'reading'],
  [/\btaping\b|\bwork[- ]in[- ]progress\b|\(wip\)|\bnew material\b|\bopen mic\b|\bshowcase\b|\bcomedy for \$/i, 'taping/work-in-progress/showcase'],
  [/\bmaster ?class(?:es)?\b|\bclasses\b|\bpanel\b|\btalk ?back\b|\bin conversation\b|\bseminars?\b|\bdiscussion group\b|\bq ?& ?a\b|\bbook (?:launch|signing)\b/i, 'class/talk'],
  [/^new portfolio item$|^project (?:one|two|three|four|five|six)\b|^untitled\b/i, 'CMS placeholder'], // Bedlam's Squarespace archive
  [/\s@\s/, 'plays another venue'],                                        // "Watch Me Walk @ Yale Rep"
  [/\b(?:boston|chicago|london|los angeles|philadelphia|washington)$/i, 'out-of-town engagement'], // "The Crucible Boston"
  [/\bthe series$/i, 'series page'],
  [/\binstallation\b|\bexhibition\b|\bpublic tours?\b/i, 'installation/exhibition'], // Park Avenue Armory's "Balkan Erotic Epic Installation"
];

/**
 * Why a venue-page candidate is not a production, or null when it may be one.
 * Checks the title patterns above and, when the reader captured dates, that
 * the booking is a run and not a single night.
 * @param {Object} candidate
 * @returns {string|null}
 */
function junkCandidateReason(candidate) {
  const title = String((candidate && candidate.title) || '');
  for (const [re, label] of VENUE_CANDIDATE_JUNK) {
    if (re.test(title)) return `${label}: "${title}"`;
  }
  const first = candidate && candidate.listingFirstDate;
  const last = candidate && candidate.listingLastDate;
  const count = candidate && candidate.listingPerformanceCount;
  if (first && last && first === last && !(typeof count === 'number' && count > 1)) {
    return `one-night event (${first})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TheaterMania as a corroborating source (BRO-4396)
// ---------------------------------------------------------------------------

function significantTokens(title) {
  return titleTokens(title);
}

// Venue-page link readers derive a title from a URL slug, which is often a
// truncation of the real one ("Diana Untold" for "Diana: The Untold and
// Untrue Story"). Every candidate token appearing in the listing title, with
// at least two of them, is the same production when the venue also agrees.
function isTokenSubset(candTokens, entryTokens) {
  if (candTokens.size < 2) return false;
  for (const t of candTokens) if (!entryTokens.has(t)) return false;
  return true;
}

// TheaterMania names a room loosely ("SoHo Playhouse" vs "Huron Club at the
// SoHo Playhouse"); the same house either way.
function venuesCompatible(a, b) {
  if (!a || !b) return false;
  if (venuesMatch(a, b)) return true;
  const norm = v => foldVenue(v);
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Whole words only ("soho playhouse" in "huron club soho playhouse", not
  // "art" in "martin"). Known residual: "Peter Jay Sharp Theater" (Playwrights
  // Horizons) reads as compatible with "...at Symphony Space".
  return shorter.split(' ').length >= 2 && ` ${longer} `.includes(` ${shorter} `);
}

function foldVenue(v) {
  return foldDiacritics(String(v || '')).toLowerCase()
    .replace(/&#0?39;|[‘’']/g, '')
    .replace(/\btheat(?:re|er)s?\b/g, ' ')
    .replace(/\b(?:the|at|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the TheaterMania OB listing that corroborates a venue candidate: same
 * title (exact, token-subset or jaccard >= 0.6), a compatible venue and at
 * least one date. Unlike Playbill/Lortel, a TheaterMania match must agree on
 * the venue: TM's Off-Broadway market is wide (hundreds of small bookings),
 * so a title alone ("Hamlet") is not enough.
 * @param {Object} candidate - { title, venue }
 * @param {Object[]} entries - parseTmOffBroadwayRow().candidate rows
 * @returns {{ entry: Object, kind: 'exact'|'subset'|'fuzzy' } | null}
 */
function findTheaterManiaCorroboration(candidate, entries) {
  if (!candidate || !candidate.title || !Array.isArray(entries)) return null;
  const want = normalizeTitle(candidate.title);
  const wantTokens = significantTokens(candidate.title);
  let best = null;
  const rank = { exact: 3, subset: 2, fuzzy: 1 };
  for (const e of entries) {
    if (!e || !e.title) continue;
    if (!(e.previewsStartDate || e.openingDate || e.closingDate)) continue;
    if (!venuesCompatible(candidate.venue, e.venue)) continue;
    let kind = null;
    if (normalizeTitle(e.title) === want) kind = 'exact';
    else {
      const eTokens = significantTokens(e.title);
      if (isTokenSubset(wantTokens, eTokens)) kind = 'subset';
      else if (wantTokens.size > 0 && jaccard(wantTokens, eTokens) >= JACCARD_FUZZY_MATCH_THRESHOLD) kind = 'fuzzy';
    }
    if (kind && (!best || rank[kind] > rank[best.kind])) best = { entry: e, kind };
  }
  return best;
}

/**
 * @param {Object} candidate - { title, venue, discoveredAt }
 * @param {Object} sources - { playbillEntries, lortelEntries }
 *   - playbillEntries: [{ title, firstPreview, opening }] from playbill-ob-schedule
 *   - lortelEntries: [{ title, firstPreview, openingNight }] (optional)
 * @param {Object} options
 * @param {number} options.windowHours - reserved for future cadence checks
 *   (right now the gate is "title appears at all", not "within last Nh")
 * @returns {{ confirmed: boolean, source: string|null, reason: string, matchedTitle?: string }}
 *   matchedTitle (BRO-3920) is the corroborating Playbill/Lortel entry's own
 *   title string, surfaced so the caller can prefer it over a venue-page
 *   heading that turns out to be shouted — Playbill/Lortel are curated
 *   editorial listings, not a rendered DOM heading, so they're the better
 *   casing source when they agree the show is the same one.
 */
function isCandidateConfirmed(candidate, sources, options = {}) {
  if (!candidate || !candidate.title) {
    return { confirmed: false, source: null, reason: 'candidate missing title' };
  }

  const want = normalizeTitle(candidate.title);
  if (!want) {
    return { confirmed: false, source: null, reason: 'title normalizes to empty string' };
  }
  const junk = junkCandidateReason(candidate);
  if (junk) {
    return { confirmed: false, source: null, reason: `not a production (${junk})` };
  }

  const playbill = sources?.playbillEntries || [];
  const lortel = sources?.lortelEntries || [];
  const wantTokens = titleTokens(candidate.title);

  // Pass 1: exact normalized match (cheap, catches most cases)
  for (const e of playbill) {
    if (e && e.title && normalizeTitle(e.title) === want) {
      return { confirmed: true, source: 'playbill', reason: `matched playbill entry "${e.title}" (exact)`, matchedTitle: e.title };
    }
  }
  for (const e of lortel) {
    if (e && e.title && normalizeTitle(e.title) === want) {
      return { confirmed: true, source: 'lortel', reason: `matched lortel entry "${e.title}" (exact)`, matchedTitle: e.title };
    }
  }

  // Pass 2: token-set jaccard >= 0.6. Catches venue-page-extracted variants
  // like "Girls Chance Music" matching Playbill's "||: GIRLS :||: CHANCE :||: MUSIC :||"
  // (the `|` chars aren't separators in normalizeTitle so the strings differ
  // after normalization, but the token sets agree).
  //
  // Deliberately NO matchedTitle on a fuzzy match (BRO-3920 adversarial
  // review finding): 0.6 jaccard is similar-enough-to-corroborate-existence,
  // not similar-enough-to-safely-RENAME. "LOVE LOSS HOPE LAUGHTER" and
  // "Love Loss Hope" both pass 0.6 but are different shows; swapping the
  // candidate's title to the matched entry's on fuzzy evidence risks
  // attaching a different show's name to this candidate's venue/source URL.
  // Only an exact normalized match (Pass 1) is safe to treat as "same title,
  // different casing".
  if (wantTokens.size > 0) {
    for (const e of playbill) {
      if (!e || !e.title) continue;
      const sim = jaccard(wantTokens, titleTokens(e.title));
      if (sim >= JACCARD_FUZZY_MATCH_THRESHOLD) {
        return { confirmed: true, source: 'playbill', reason: `matched playbill entry "${e.title}" (jaccard=${sim.toFixed(2)})` };
      }
    }
    for (const e of lortel) {
      if (!e || !e.title) continue;
      const sim = jaccard(wantTokens, titleTokens(e.title));
      if (sim >= JACCARD_FUZZY_MATCH_THRESHOLD) {
        return { confirmed: true, source: 'lortel', reason: `matched lortel entry "${e.title}" (jaccard=${sim.toFixed(2)})` };
      }
    }
  }

  // Pass 3 (BRO-4396): TheaterMania's Off-Broadway listing, same title AND
  // a compatible venue AND dated. An exact or token-subset match also hands
  // back TM's title and dates: TM is a curated editorial listing, and a
  // subset match is precisely the truncated-slug case where the venue-page
  // title is the wrong one to keep. A jaccard-only match corroborates
  // existence but never renames (the BRO-3920 rule above).
  const tm = findTheaterManiaCorroboration(candidate, sources?.theatermaniaEntries || []);
  if (tm) {
    const e = tm.entry;
    return {
      confirmed: true,
      source: 'theatermania',
      reason: `matched TheaterMania OB entry "${e.title}" at "${e.venue}" (${tm.kind})`,
      ...(tm.kind !== 'fuzzy' ? {
        matchedTitle: e.title,
        matchedDates: {
          previewsStartDate: e.previewsStartDate || null,
          openingDate: e.openingDate || null,
          openingDateSource: e.openingDateSource || null,
          closingDate: e.closingDate || null,
        },
      } : {}),
    };
  }

  return { confirmed: false, source: null, reason: `no Playbill/Lortel/TheaterMania match for "${candidate.title}"` };
}

// ---------------------------------------------------------------------------
// decideVenueListingPromotion (BRO-4396): the venue's own dated listing
// ---------------------------------------------------------------------------
// For a venue we already classify as Off-Broadway, that venue's own box
// office listing IS the primary source: if it sells N performances of a
// title over a date range, the production exists there. What it cannot tell
// us is whether the row is a production at all, so this gate leans on the
// junk filters above, on discovery's own non-theatre / one-night gates
// (injected, so this module never loads discover-new-shows.js), and on a
// minimum run: at least MIN_LISTING_PERFORMANCES performances when the
// reader counts them, or at least two distinct dates when it does not.
// Undated venue-page candidates (the slug-title link readers) never pass
// here; they still need Playbill/Lortel/TheaterMania.

// A run, not a weekend booking (ship-check, 2026-09-29): with a performance
// count, at least 5 (SoHo's 4-show improv and kids' weekends stay out); with
// no count, the dates must span at least 3 days (NYU Skirball's 3-night
// visiting productions are real, reviewed runs).
const MIN_LISTING_PERFORMANCES = 5;
const MIN_UNCOUNTED_SPAN_DAYS = 2;
const SPARSE_SERIES_MAX_COUNT = 8;
const SPARSE_SERIES_MIN_GAP_DAYS = 7;
const MAX_LISTING_LEAD_DAYS = 365;
const VENUE_LISTING_SOURCE_PREFIX = 'venue-page:';

function isIsoDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * @param {Object} candidate - venue-page candidate with listingFirstDate /
 *   listingLastDate / listingPerformanceCount from a dated reader
 * @param {Object} [options]
 * @param {string} [options.todayIso]
 * @param {(venue: string) => boolean} [options.isKnownVenue]
 * @param {{isNonTheaterContent?: Function, isOneNightShow?: Function}} [options.gates]
 * @returns {{ confirmed: boolean, source: string|null, reason: string }}
 */
function decideVenueListingPromotion(candidate, options = {}) {
  const {
    todayIso = new Date().toISOString().slice(0, 10),
    isKnownVenue = isKnownOffBroadwayVenue,
    gates = {},
  } = options;
  const no = reason => ({ confirmed: false, source: null, reason });
  if (!candidate || !candidate.title || !normalizeTitle(candidate.title)) return no('candidate missing title');
  if (!String(candidate.source || '').startsWith(VENUE_LISTING_SOURCE_PREFIX)) {
    return no(`source "${candidate.source}" is not a venue listing`);
  }
  const junk = junkCandidateReason(candidate);
  if (junk) return no(`not a production (${junk})`);
  let venueKnown;
  try { venueKnown = !!candidate.venue && isKnownVenue(candidate.venue); } catch { venueKnown = false; }
  if (!venueKnown) return no(`venue "${candidate.venue}" not in canonical Off-Broadway venue list`);

  if (candidate.listingEvidence === 'needs-corroboration') {
    return no('mixed-program venue: its listing alone does not show a row is a play');
  }
  const first = candidate.listingFirstDate;
  const last = candidate.listingLastDate;
  if (!isIsoDay(first) || !isIsoDay(last)) return no('venue listing has no run dates (undated reader)');
  if (last < first) return no(`listing dates out of order (${first} > ${last})`);
  if (last < todayIso) return no(`run already ended (${last})`);
  const lead = (Date.parse(`${first}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS;
  if (lead > MAX_LISTING_LEAD_DAYS) return no(`first performance ${first} is more than ${MAX_LISTING_LEAD_DAYS}d out`);
  const count = candidate.listingPerformanceCount;
  const spanDays = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS;
  if (typeof count === 'number') {
    if (count < MIN_LISTING_PERFORMANCES) return no(`only ${count} performance(s) listed — a short booking, not a run`);
    // A handful of dates spread over weeks is a recurring night (a monthly
    // comedy show), not a run. Rotating repertory (Repertorio Español: 20
    // performances over six months) has the density to pass.
    if (count < SPARSE_SERIES_MAX_COUNT && spanDays / (count - 1) >= SPARSE_SERIES_MIN_GAP_DAYS) {
      return no(`${count} performances over ${Math.round(spanDays)} days — a recurring series, not a run`);
    }
  } else if (first === last) {
    return no(`one-night event (${first})`);
  } else if (spanDays < MIN_UNCOUNTED_SPAN_DAYS) {
    return no(`listed ${first} to ${last} only — a short booking, not a run`);
  }

  const gateReason = discoveryGateReason({ ...candidate, listingFirstDate: first, listingLastDate: last }, gates);
  if (gateReason) return no(gateReason);

  const evidence = candidate.listingEvidence === 'editorial-listing' ? 'editorial venue listing' : "venue's own listing";
  return {
    confirmed: true,
    source: 'venue-listing',
    reason: `${evidence}: ${first} to ${last}${typeof count === 'number' ? `, ${count} performances` : ''}`,
  };
}

/**
 * Discovery's own non-theatre / one-night gates (injected), shared by the
 * venue-listing and TheaterMania routes. Fails closed on a throwing gate.
 * @returns {string|null} why the candidate fails, or null
 */
function discoveryGateReason(candidate, gates = {}) {
  const gateShape = {
    displayName: candidate.title,
    name: candidate.title,
    subcategories: [{ name: 'Off Broadway' }],
    venue: { name: candidate.venue },
    description: candidate.description || '',
    startDate: candidate.listingFirstDate || candidate.previewsStartDate || candidate.openingDate || undefined,
    endDate: candidate.listingLastDate || candidate.closingDate || undefined,
  };
  try {
    if (gates.isNonTheaterContent && gates.isNonTheaterContent(gateShape)) return 'discovery non-theatre gate (isNonTheaterContent)';
    if (gates.isOneNightShow && gates.isOneNightShow(gateShape)) return 'discovery one-night gate (isOneNightShow)';
  } catch (e) {
    return `discovery gate threw (${e.message}) — refusing to confirm`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// decideCriticListingPromotion — sibling gate for candidates sourced from a
// single-maintainer critic-listing blog (e.g. newyorktheater.me / 'nyt-theater',
// Sprint 1, task #997). isCandidateConfirmed above requires a Playbill OR
// Lortel match; Lortel is dead (404, no replacement — see
// scripts/enrich-off-broadway-dates.js) and Playbill's OB schedule article
// carries none of this source's shows (task #987). Widening isCandidateConfirmed
// to cover that gap would widen its blast radius for EVERY candidate source,
// present and future — the wrong fix (see header comment above + card 3b2637c5).
//
// This gate is deliberately SELF-SUFFICIENT instead: it confirms off what the
// candidate's own discovery already proved (title, a venue resolvable against
// the canonical Off-Broadway venue list, a plausible publish date, and a
// persisted source URL to audit against later) rather than requiring a SECOND
// source to corroborate it. Plan v1's fatal flaw (the #647/#772 dead-arm
// class) was a rule whose corroborators — TDF, BWW, a venue page — nobody was
// actually building, so it would have confirmed nothing. `corroborations[]`
// on the candidate (see aggregator-candidate-extract.js) stays optional
// provenance for future use; this rule never REQUIRES it to be non-empty.
// ---------------------------------------------------------------------------

// How stale the article can be relative to when it was discovered/staged
// before we refuse to trust it (a critic-listing post scraped from an old
// archive page, not the live monthly roundup).
const CRITIC_LISTING_MAX_STALENESS_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

// Source keys this gate is willing to confirm. Deliberately an ALLOWLIST, not
// "anything with a title/venue/URL/dates" — this gate skips the second-source
// corroboration isCandidateConfirmed relies on, so it MUST NOT be reachable
// for other candidate classes (venue-page:*, bww-roundup, ...). Without this,
// a venue-page-scrape bug that mints a phantom title at a real venue (the
// "Spring Gala 2026" incident this file's header describes) would sail
// through on a real venue + a real-looking discoveredAt (ship-check
// adversarial review finding, task #995).
const CRITIC_LISTING_SOURCES = new Set(['nyt-theater']);

/**
 * @param {Object} candidate - the aggregator-candidate-extract.js shape:
 *   { title, venue, source, sourceUrl, articlePublishedAt, discoveredAt, ... }
 * @param {Object} options
 * @param {(venue: string) => boolean} [options.isKnownVenue] - injectable
 *   canonical-venue check, defaults to the real Off-Broadway venue list.
 *   Tests use this to simulate a normal "venue not on the list" rejection.
 *   Wrapped in try/catch — a throwing check fails CLOSED (not confirmed),
 *   never crashes the caller's promotion loop.
 * @param {() => boolean} [options.venueDirectoryAvailable] - injectable
 *   liveness check for the canonical venue directory this gate depends on.
 *   Defaults to "the real, committed list loaded". Tests set this to `false`
 *   to exercise the "required source is unavailable" refusal path — distinct
 *   from an ordinary "venue not found" rejection: the directory itself
 *   couldn't be consulted, so this gate REFUSES to confirm rather than
 *   guessing either way (fetched-zero-results vs fetch-failed). Also wrapped
 *   in try/catch, fails closed.
 * @returns {{ confirmed: boolean, source: string|null, reason: string }}
 */
function decideCriticListingPromotion(candidate, options = {}) {
  const {
    isKnownVenue = isKnownOffBroadwayVenue,
    venueDirectoryAvailable = () => OFF_BROADWAY_VENUES.size > 0,
  } = options;

  if (!candidate || !candidate.title || !normalizeTitle(candidate.title)) {
    return { confirmed: false, source: null, reason: 'candidate missing title' };
  }
  if (!CRITIC_LISTING_SOURCES.has(candidate.source)) {
    return { confirmed: false, source: null, reason: `source "${candidate.source}" is not a critic-listing source — this gate only confirms ${[...CRITIC_LISTING_SOURCES].join(', ')}` };
  }
  if (!candidate.sourceUrl) {
    return { confirmed: false, source: null, reason: 'no persisted source URL — nothing to audit against later' };
  }
  if (!candidate.venue) {
    return { confirmed: false, source: null, reason: 'null venue' };
  }

  // "Required source unavailable" — the canonical venue directory itself
  // couldn't be consulted (fetch-failed class). REFUSE to confirm rather
  // than treat an outage as either a pass or a normal not-found reject.
  // A throwing check is treated the same way — fail closed, never crash.
  let directoryAvailable;
  try { directoryAvailable = venueDirectoryAvailable(); } catch { directoryAvailable = false; }
  if (!directoryAvailable) {
    return {
      confirmed: false, source: null,
      reason: 'canonical Off-Broadway venue directory unavailable — refusing to confirm (not a venue rejection)',
    };
  }
  // Directory was consulted fine; venue just isn't on it (fetched-zero-results).
  let venueKnown;
  try { venueKnown = isKnownVenue(candidate.venue); } catch { venueKnown = false; }
  if (!venueKnown) {
    return { confirmed: false, source: null, reason: `venue "${candidate.venue}" not in canonical Off-Broadway venue list` };
  }

  // Compatible dates: articlePublishedAt and discoveredAt must both exist,
  // parse, and roughly agree — discoveredAt should land at/after the
  // article's own publish date (staging always records discovery AFTER the
  // page existed) and not so long after it that this is stale archive
  // content masquerading as a current listing.
  const published = candidate.articlePublishedAt ? new Date(candidate.articlePublishedAt) : null;
  const discovered = candidate.discoveredAt ? new Date(candidate.discoveredAt) : null;
  if (!published || Number.isNaN(published.getTime()) || !discovered || Number.isNaN(discovered.getTime())) {
    return { confirmed: false, source: null, reason: 'missing or unparseable articlePublishedAt/discoveredAt' };
  }
  if (discovered.getTime() < published.getTime() - DAY_MS) {
    return {
      confirmed: false, source: null,
      reason: `date mismatch: discoveredAt (${candidate.discoveredAt}) precedes articlePublishedAt (${candidate.articlePublishedAt})`,
    };
  }
  const stalenessDays = (discovered.getTime() - published.getTime()) / DAY_MS;
  if (stalenessDays > CRITIC_LISTING_MAX_STALENESS_DAYS) {
    return {
      confirmed: false, source: null,
      reason: `date mismatch: articlePublishedAt is ${Math.round(stalenessDays)}d stale relative to discoveredAt`,
    };
  }

  return {
    confirmed: true, source: 'critic-listing',
    reason: `title + canonical venue "${candidate.venue}" + compatible dates + persisted source URL`,
  };
}

/**
 * BRO-3920 — decide whether to keep a confirmed candidate's own (venue-page)
 * title or swap in the corroborating Playbill/Lortel entry's title instead.
 *
 * Pulled out of the promotion loop as its own pure function per CLAUDE.md
 * §15 (extract decision logic, don't inline-and-hope) — this is the piece
 * that actually decides a stored title, so it needs its own test coverage
 * independent of the loop that calls it.
 *
 * Only swaps when the venue-page title is shouted AND the corroborating
 * title is not — never when both agree (nothing to fix) and never when both
 * are shouted (no evidence either is more correct; stays flagged by
 * validate-data.js's isShoutedTitle gate instead of guessing). Also never
 * swaps a title that's already a verified exemption (KEEP_SHOUTED_IDS/
 * TITLES) — that ALL-CAPS was already checked against the source and
 * confirmed correct, so a corroborating listing's own (possibly wrong)
 * casing must not silently override it.
 *
 * @param {string} candidateTitle - the venue-page-scraped title
 * @param {string|undefined} matchedTitle - isCandidateConfirmed()'s matchedTitle
 * @returns {{title: string, swapped: boolean}}
 */
function preferCorroboratingTitle(candidateTitle, matchedTitle) {
  if (
    matchedTitle
    && isShoutedTitle(candidateTitle)
    && !isShoutedTitle(matchedTitle)
    && !isExemptFromTitleCase(undefined, candidateTitle)
  ) {
    return { title: matchedTitle, swapped: true };
  }
  return { title: candidateTitle, swapped: false };
}

module.exports = {
  isCandidateConfirmed,
  decideVenueListingPromotion,
  discoveryGateReason,
  junkCandidateReason,
  findTheaterManiaCorroboration,
  venuesCompatible,
  MIN_LISTING_PERFORMANCES,
  decideCriticListingPromotion,
  preferCorroboratingTitle,
};
