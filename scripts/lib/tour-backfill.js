'use strict';

/**
 * Tour backfill decisions (BRO-4211): which archived review files, flagged
 * wrongProduction on a Broadway show because they review the national tour,
 * move to that tour's own entry, and how each file is rewritten on the way.
 *
 * Pure functions so the rules are testable; scripts/sweep-tour-reviews.js does
 * the file moves.
 *
 * Pilot lessons encoded here (Beetlejuice, 2026-09-28):
 * - The tour text sits in wrongFullText, not fullText.
 * - Verdicts judged against the Broadway run (contentVerification*, verifiedBy,
 *   possibleTourReview, tourSignal) must not travel with the file: the rebuild
 *   CV-promoted one straight back into wrongProduction.
 * - Most files carry no publishDate, so a launch-date cut cannot be the main rule.
 */

const { isLikelyTourReview } = require('./review-guards');
const { isOverseasHost } = require('./domain-filters');

const TOUR_REASON_RE = /\btour(?:ing)?\b|national-tour|BWW regional\/tour/i;
// Pre-Broadway tryouts are their own production (regional), not the post-Broadway tour.
const TRYOUT_RE = /pre-Broadway|\btryout\b|out-of-town|world premiere/i;
// UK / West End tours are a different production from the North American tour.
const UK_RE = /\bUK tour\b|\bUK & Ireland\b|\.co\.uk\b|\bWest End\b/i;
// Same, read from the review text (Shucked's 2025 London run: 15 reviews on shucked-2023).
const UK_TEXT_RE = /\b(?:West End|London|Southwark|Edinburgh Fringe|UK (?:and|&) Ireland tour|UK tour)\b/;
// A UK production on the road: a UK tour, or a UK touring town (not London,
// which US reviews name as the show's origin).
// Only names no North American tour plays: Manchester, Birmingham, Dublin and
// the like are US tour stops too (BRO-4656 review).
const UK_TOUR_TEXT_RE = /\b(?:UK (?:and|&) Ireland|(?:UK|British) tour|Milton Keynes|Hull New Theatre|Bristol Hippodrome|Wolverhampton|Llandudno|Blackpool|Woking|Dartford|Cardiff|Edinburgh|Wimbledon)\b/;
// Stop cities that are also UK cities ("London, ON" on three tours): naming
// one says nothing about which country the critic was in, so these match a
// stop by venue only.
const UK_AMBIGUOUS_CITIES = new Set(['London', 'Manchester', 'Birmingham', 'Cambridge']);
// Reason labels that name two productions at once are not tour evidence:
// "Tour/regional/pre-Broadway" (contamination net) and "likely revival/tour
// review" (BWW-roundup year guard), which filed the 2023 Spamalot revival
// reviews on spamalot-2005 and sent them toward the tour (BRO-4656).
const AMBIGUOUS_REASON_RE = /Tour\/regional\/pre-Broadway(?: production)?|revival\/tour(?: review)?/gi;
// Tour language in the review itself.
const TOUR_TEXT_RE = /\b(?:national tour|north american tour|touring (?:production|company|cast|version)|(?:the|this|latest|new) tour\b(?! de force)|\b(?:now|currently|is|are) on tour\b|\bon tour (?:at|in|to)\b)/i;
// The text places the review on Broadway (a revival or return), not on the road.
const BROADWAY_TEXT_RE = /\b(?:returns? to|back on|back to|transfers? to|revival on|opens on|now on) Broadway\b|\bon Broadway (?:at|in) the\b/i;
// History most tour reviews recount ("opened on Broadway in April of 2023",
// "the 2023 Broadway revival"): Broadway evidence only when neither the text
// nor a tour-specific flag reason says tour (Shucked's BWW Cleveland and Spamalot's Bushnell
// reviews were held on Broadway by it, BRO-4656).
const BROADWAY_HISTORY_RE = /\bopened on Broadway\b|\bBroadway revival\b(?! (?:tour|production) )/i;
const STOP_BEFORE_MS = 14 * 86400000;
// Broadway opening to this tour's launch: past this, earlier tours likely exist.
const PERENNIAL_GAP_MS = 4 * 365 * 86400000;
const STOP_AFTER_MS = 30 * 86400000;

function cityName(city) {
  return String(city || '').split(',')[0].trim();
}

/**
 * The tour stop this review is about: published around that engagement
 * (two weeks before it opens to a month after it closes) and naming the stop's
 * city or venue in its text. Needs a publishDate; never reads the URL.
 */
function matchStop(data, stops, settingCities = null, genericVenues = null) {
  if (!Array.isArray(stops) || !stops.length) return null;
  const pub = toDate(data.publishDate);
  if (!pub) return null;
  const text = String(data.fullText || data.wrongFullText || '').slice(0, 6000);
  if (!text) return null;
  const inWindow = stops.filter((st) => {
    const a = Date.parse(st.start), b = Date.parse(st.end || st.start);
    // An end before the start is a bad schedule row, not an engagement.
    return !Number.isNaN(a) && !Number.isNaN(b) && b >= a
      && pub.getTime() >= a - STOP_BEFORE_MS && pub.getTime() <= b + STOP_AFTER_MS;
  });
  const venueIn = st => venueNamed(text, st.venue);
  const cityIn = (st) => {
    const city = cityName(st.city);
    return city.length >= 4 && !(settingCities && settingCities.has(city)) && !UK_AMBIGUOUS_CITIES.has(city)
      && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  };
  // Venue and city together, then a venue no other city (and no Broadway
  // house) shares, then the city: a city can be the story's (Gatsby's Daisy is
  // from Louisville), and "Music Hall" or "Orpheum Theatre" is in many cities.
  return inWindow.find(st => venueIn(st) && cityIn(st))
    || inWindow.find(st => venueIn(st) && !(genericVenues && genericVenues.has(st.venue)))
    || inWindow.find(cityIn)
    || null;
}

/** Whether the stop was named by a venue that identifies it on its own. */
function namedByVenue(text, st, genericVenues) {
  return venueNamed(text, st.venue) && !(genericVenues && genericVenues.has(st.venue));
}

/**
 * Whether the text names the venue. A leading "The" matches in either case
 * (the schedule says "The Bushnell", the review "the Bushnell") but must be
 * there: a bare "Playhouse" is Paper Mill's or Pasadena's, not Wilmington's
 * "The Playhouse". The name itself stays case-sensitive.
 */
function venueNamed(text, venue) {
  const m = /^the\s+(.+)$/i.exec(String(venue || '').trim());
  const name = m ? m[1] : String(venue || '').trim();
  if (name.length < 6) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // Lookarounds, not \b: a venue can end in punctuation ("Fox Theatre (St. Louis)").
  return new RegExp(`(?<![A-Za-z0-9])${m ? '[Tt]he\\s+' : ''}${esc}(?![A-Za-z0-9])`).test(text);
}

function reasonText(data) {
  return [data.wrongProductionReason, data.wrongProductionNote, data.wrongProductionDetail]
    .filter(Boolean).join(' | ');
}

function toDate(s) {
  if (!s) return null;
  // "April 29th, 2019" is Invalid Date as written; drop the ordinal suffix.
  const d = new Date(String(s).replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1'));
  return Number.isNaN(d.getTime()) ? null : d;
}

// A tour closes; later reviews of the same title belong to a later tour (Shucked
// has a second one from 2026). Reviews trail the last stop by a few weeks.
const AFTER_CLOSE_SLACK_MS = 60 * 86400000;

/** Earliest time the pipeline saw this file: the stand-in date for an undated review. */
function firstSeen(data) {
  const ts = [data.firstSeenAt, data.urlDiscoveredAt, data.textFetchedAt].map(toDate).filter(Boolean);
  return ts.length ? new Date(Math.min(...ts.map(d => d.getTime()))) : null;
}

/** Outlet id of a review file. */
function outletOf(data) {
  return data.outletId || null;
}

/**
 * Decide whether one file moves from a Broadway show to its tour.
 * Returns { action: 'move' | 'skip', reason }.
 * ctx: { broadwayOpeningDate?, tourLaunchDate?, tourClosingDate?, otherToursOfTitle?,
 *        nextTourLaunchDate?, siblingTourUndated?, stops?, ukOutlets? } (ISO strings may be
 * null; stops from data/tour-schedules.json, ukOutlets a Set of London outlet ids). With two
 * tours of one title, each dated review belongs to exactly one: a tour's window
 * ends where the next one's begins (nextTourLaunchDate); with either launch date
 * unknown the split can't be made (siblingTourUndated).
 */
function classifyTourBackfill(data, ctx = {}) {
  if (!data || data.wrongProduction !== true) return { action: 'skip', reason: 'not-flagged' };
  if (data.routedFromShowId) return { action: 'skip', reason: 'already-routed' };
  const why = reasonText(data);
  const textHead = String(data.fullText || data.wrongFullText || '').slice(0, 3000);
  const stop = matchStop(data, ctx.stops, ctx.settingCities, ctx.genericVenues);
  const textTour = TOUR_TEXT_RE.test(textHead);
  // A flag whose reason never mentions a tour (date guards, the 2026-06-21
  // contamination audit, "ambiguous-production", an empty reason) still holds
  // tour reviews: 8 Spamalot stop reviews sat on spamalot-2023 while the tour
  // page had none (BRO-4656). Those move only on the review's own words: it
  // names a stop the tour played when it was published, or says it is the tour.
  if (!TOUR_REASON_RE.test(why) && !stop && !textTour) return { action: 'skip', reason: 'flag-not-tour' };
  // An ambiguous label is not tour evidence on its own (BRO-4262 pre-mortem:
  // it would route regional stock and sit-down reviews into a tour). Needs a
  // tour-specific reason, a tour-stop URL, a matching stop, or tour language.
  const whySpecific = why.replace(AMBIGUOUS_REASON_RE, '');
  const tourEvidence = Boolean(stop) || textTour
    || TOUR_REASON_RE.test(whySpecific)
    || isLikelyTourReview(data.url, data.showId);
  if (!tourEvidence) return { action: 'skip', reason: 'no-tour-evidence' };
  if (data.isNonReview === true || data.isRoundupArticle === true) return { action: 'skip', reason: 'non-review' };
  if (data.duplicateOf || data.duplicateTextOf) return { action: 'skip', reason: 'duplicate' };
  if (data.wrongShow === true) return { action: 'skip', reason: 'wrong-show' };

  const text = textHead;
  // The contamination safety net's generic label "Tour/regional/pre-Broadway production"
  // names all three possibilities at once, so it is not tryout evidence on its own
  // (4 A Beautiful Noise tour-stop reviews carried it).
  const whyForTryout = why.replace(/Tour\/regional\/pre-Broadway/gi, '');
  if (TRYOUT_RE.test(whyForTryout) || TRYOUT_RE.test(text.slice(0, 1200))) return { action: 'skip', reason: 'tryout' };
  if (UK_RE.test(`${data.url || ''} ${why}`)) return { action: 'skip', reason: 'uk-production' };
  if (isOverseasHost(data.url)) return { action: 'skip', reason: 'overseas-production' };
  // A London outlet reviews the London run whatever stop its text names.
  if (ctx.ukOutlets && ctx.ukOutlets.has(outletOf(data))) return { action: 'skip', reason: 'uk-production' };
  if (!stop && UK_TEXT_RE.test(text.slice(0, 1500))) {
    return { action: 'skip', reason: 'uk-production' };
  }
  // A review that says the show is (back) on Broadway reviews a Broadway run,
  // unless it names a stop the tour was playing.
  const head = text.slice(0, 2000);
  if (!stop && (BROADWAY_TEXT_RE.test(head) || (!textTour && !TOUR_REASON_RE.test(whySpecific) && BROADWAY_HISTORY_RE.test(head)))) {
    return { action: 'skip', reason: 'broadway-production' };
  }

  const pub = toDate(data.publishDate);
  const bway = toDate(ctx.broadwayOpeningDate);
  const launch = toDate(ctx.tourLaunchDate);
  if (pub && bway && pub < bway) return { action: 'skip', reason: 'before-broadway-opening' };
  // Allow a week of slack: roundups and first-stop reviews can predate the official launch listing.
  if (pub && launch && pub.getTime() < launch.getTime() - 7 * 86400000) return { action: 'skip', reason: 'before-tour-launch' };
  if (ctx.siblingTourUndated) return { action: 'skip', reason: 'ambiguous-tour' };
  const next = toDate(ctx.nextTourLaunchDate);
  if (pub && next && pub.getTime() >= next.getTime() - 7 * 86400000) return { action: 'skip', reason: 'later-tour' };
  const close = toDate(ctx.tourClosingDate);
  if (pub && close && pub.getTime() > close.getTime() + AFTER_CLOSE_SLACK_MS) return { action: 'skip', reason: 'after-tour-close' };
  if (!pub) {
    // With two tours of one title an undated review can't be placed.
    if ((ctx.otherToursOfTitle || 0) > 0) return { action: 'skip', reason: 'ambiguous-tour' };
    // Nor one the pipeline found before this tour launched: it is about an
    // earlier production we don't track (Waitress's 2016 Broadway review,
    // Death Becomes Her's 2024 Chicago tryout, an older Jersey Boys tour;
    // BRO-4325). Unknown first-seen time, or an undated tour, counts as before.
    const seen = firstSeen(data);
    if (!launch || !seen || seen.getTime() < launch.getTime() - 7 * 86400000) return { action: 'skip', reason: 'undated-before-launch' };
    // A title first on Broadway years before this tour has had earlier tours we
    // don't track (Wicked since 2005, The Lion King since 2002, Mamma Mia!):
    // an undated "touring production" review can't be placed on this one.
    const first = toDate(ctx.firstBroadwayOpeningDate) || bway;
    if (first && launch.getTime() - first.getTime() > PERENNIAL_GAP_MS) return { action: 'skip', reason: 'undated-perennial' };
    // A closed tour only takes an undated review the pipeline saw before it closed;
    // one first seen later is more likely a review of the next production.
    if (close) {
      const seen = firstSeen(data);
      if (!seen || seen.getTime() > close.getTime() + AFTER_CLOSE_SLACK_MS) return { action: 'skip', reason: 'undated-after-close' };
    }
  }

  return { action: 'move', reason: 'tour-review' };
}

/**
 * Stop cities the show's own Broadway reviews keep naming: the story's setting
 * (The Outsiders and Tulsa: 46 of 53 reviews), so naming one says nothing about
 * where the critic saw it. A city named by at least a fifth of the reviews (and
 * at least three) matches by venue only.
 */
function settingCitiesOf(stops, texts) {
  const out = new Set();
  if (!Array.isArray(stops) || !texts.length) return out;
  for (const city of new Set(stops.map(s => cityName(s.city)).filter(c => c.length >= 4))) {
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const n = texts.filter(t => re.test(t)).length;
    if (n >= 3 && n >= 0.2 * texts.length) out.add(city);
  }
  return out;
}

/**
 * planTourSweep's options read from disk: tour stops (data/tour-schedules.json)
 * and the London outlets of data/outlet-registry.json. Missing files give
 * nulls, which leaves the date/stop rules and the UK filter as before.
 */
function loadSweepContext(root) {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8')); } catch { return null; } };
  const sched = read('tour-schedules.json');
  const reg = read('outlet-registry.json');
  const outlets = reg && (reg.outlets || reg);
  const ukOutlets = outlets && typeof outlets === 'object'
    ? new Set(Object.entries(outlets).filter(([, o]) => o && o.region === 'london').map(([id]) => id))
    : null;
  return { schedules: (sched && sched.tours) || null, ukOutlets, genericVenues: genericVenuesOf(sched && sched.tours, read('shows.json')) };
}

/**
 * Venue names that do not identify one stop: a name tour schedules give in two
 * or more cities ("Music Hall", "Orpheum Theatre"), or a Broadway house name
 * ("Majestic Theatre", "Shubert Theatre"), which a Broadway review names too.
 */
function genericVenuesOf(tours, showsFile) {
  const out = new Set();
  const cities = new Map();
  for (const t of Object.values(tours || {})) {
    for (const st of (t && t.stops) || []) {
      if (!st.venue) continue;
      if (!cities.has(st.venue)) cities.set(st.venue, new Set());
      cities.get(st.venue).add(cityName(st.city));
    }
  }
  for (const [venue, cs] of cities) if (cs.size > 1) out.add(venue);
  const shows = (showsFile && (showsFile.shows || showsFile)) || [];
  const broadway = new Set();
  for (const s of Array.isArray(shows) ? shows : []) {
    const v = s && s.venue && (s.venue.name || s.venue);
    if (typeof v === 'string' && (s.category || 'broadway') === 'broadway') broadway.add(v.replace(/^The /, '').trim());
  }
  for (const venue of cities.keys()) if (broadway.has(venue.replace(/^The /, '').trim())) out.add(venue);
  return out;
}

const BROADWAY_RELATIVE_FIELDS = [
  'contentVerification', 'contentVerificationPrev', 'contentVerificationPromoted',
  'verifiedBy', 'possibleTourReview', 'tourSignal',
];
const WRONG_PRODUCTION_FIELDS = [
  'wrongProduction', 'wrongProductionReason', 'wrongProductionNote', 'wrongProductionDetail',
  'wrongProductionDetectedAt', 'wrongProductionDetectedBy', 'wrongProductionFlaggedAt',
  'wrongProductionFlaggedBy', 'wrongProductionProvenance', 'wrongProductionSetBy',
  'wrongProductionConfidence', 'contentTierReason', 'incompleteReason', 'incompleteDetail',
];
// The scorer's give-up state for a flagged file ("Skipped fullText (wrongProduction
// flag)", abandoned after 5 tries). Left on a moved file it keeps the scorer away
// for good, so 3 moved Spamalot tour reviews stayed unscored.
// scoreStatus 'TO_BE_CALCULATED' is a discovery placeholder (no usable text
// yet) that every scoring path skips; on a moved file with its text it is
// stale (3 moved Lion King tour reviews).
const hasScorableText = (d) => typeof d.fullText === 'string' && d.fullText.length >= 200;
const FLAGGED_SCORING_FAILURE_FIELDS = [
  'manualClearFallbackFailedAt', 'manualClearFallbackFailureReason',
  'manualClearFallbackAttempts', 'manualClearFallbackAbandoned',
];

/**
 * Rewrite a file for its new home on the tour. Returns a new object; the input is untouched.
 * The prior flag and verdicts are kept under routedPriorVerdicts so the move is reversible.
 */
function prepareTourMove(data, { fromShowId, tourId, at = new Date().toISOString() }) {
  const out = { ...data };
  const prior = {};
  for (const k of [...WRONG_PRODUCTION_FIELDS, ...BROADWAY_RELATIVE_FIELDS, ...FLAGGED_SCORING_FAILURE_FIELDS]) {
    if (k in out) { prior[k] = out[k]; delete out[k]; }
  }
  // The scoreability check's 'wrong_production' rejection judged the text against the
  // Broadway run (8 of the first 113 moves); other rejections (not_a_review, garbage) stand.
  if (out.rejectionReason === 'wrong_production') {
    for (const k of ['rejectionReason', 'rejectionReasoning', 'rejectedBy', 'rejectedAt']) {
      if (k in out) { prior[k] = out[k]; delete out[k]; }
    }
  }
  if (out.wrongFullText && !out.fullText) out.fullText = out.wrongFullText;
  delete out.wrongFullText;
  if (out.scoreStatus === 'TO_BE_CALCULATED' && hasScorableText(out)) { prior.scoreStatus = out.scoreStatus; delete out.scoreStatus; }
  if (out.contentTier === 'invalid') {
    out.contentTier = out.fullText ? (out.textQuality === 'truncated' ? 'truncated' : 'complete') : 'excerpt';
  }
  out.showId = tourId;
  out.routedFromShowId = fromShowId;
  out.routedAt = at;
  out.routedReason = 'tour-backfill (BRO-4211): national tour review re-homed from the Broadway entry';
  if (Object.keys(prior).length) out.routedPriorVerdicts = prior;
  return out;
}

/**
 * A file already on its tour that still carries the scorer's give-up state from
 * its flagged period (moved before prepareTourMove set it aside). Returns the
 * repaired copy, or null when there is nothing to repair.
 */
function clearStaleScoringFailure(data) {
  if (!data || !data.routedFromShowId || data.wrongProduction) return null;
  // A give-up recorded after the move is the scorer's verdict on the tour file:
  // clearing it would reset the attempt count every daily run and retry forever.
  const failedAt = Date.parse(data.manualClearFallbackFailedAt || '');
  const routedAt = Date.parse(data.routedAt || '');
  const failedAfterMove = !Number.isNaN(failedAt) && !Number.isNaN(routedAt) && failedAt > routedAt;
  const stale = failedAfterMove ? [] : FLAGGED_SCORING_FAILURE_FIELDS.filter(k => data[k] != null);
  if (data.scoreStatus === 'TO_BE_CALCULATED' && hasScorableText(data)) stale.push('scoreStatus');
  if (!stale.length) return null;
  const out = { ...data, routedPriorVerdicts: { ...(data.routedPriorVerdicts || {}) } };
  // null, not delete: review-write-guard protects these fields from a write that
  // omits them, and accepts an explicit null (as clear-failure-flags.js does).
  for (const k of stale) { out.routedPriorVerdicts[k] = out[k]; out[k] = null; }
  return out;
}

const normTitle = (t) => String(t || '').trim().toLowerCase();

/**
 * One entry per tour: which show folders to sweep and the date context.
 * Every same-title production in the tourOf parent's category (Broadway,
 * Off-Broadway, regional, West End or Off-West End) plus every Broadway one is
 * a source (Beetlejuice tour reviews landed on beetlejuice-2022 and -2025, not
 * only the parent 2019); other markets never are (beetlejuice-west-end-2026 is
 * a different production when the parent is Broadway, and the UK filter only
 * catches files that say so). A standalone tour (no tourOf, BRO-4931) has no
 * production to sweep: its list is empty, so nothing moves.
 */
function planTourSweep(shows, { schedules = null, ukOutlets = null, genericVenues = null } = {}) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const tours = shows.filter(s => s.category === 'tour' && (!s.tourOf || byId.has(s.tourOf)));
  const titleOf = t => normTitle(t.tourOf ? byId.get(t.tourOf).title : t.title);
  return tours.map(tour => {
    const parent = tour.tourOf ? byId.get(tour.tourOf) : null;
    const title = titleOf(tour);
    const parentCategory = parent ? (parent.category || 'broadway') : null;
    const fromIds = !parent ? [] : shows
      .filter(s => s.category !== 'tour' && ((s.category || 'broadway') === 'broadway' || (s.category || 'broadway') === parentCategory)
        && normTitle(s.title) === title)
      .map(s => s.id)
      .sort();
    const siblings = tours.filter(t => t.id !== tour.id && titleOf(t) === title);
    const otherToursOfTitle = siblings.length;
    const siblingTourUndated = siblings.length > 0 && (!tour.openingDate || siblings.some(t => !t.openingDate));
    const firstOpen = fromIds.map(id => byId.get(id).openingDate).filter(Boolean).sort()[0] || null;
    const later = siblings.map(t => t.openingDate).filter(d => d && tour.openingDate && d > tour.openingDate).sort();
    return {
      tourId: tour.id,
      fromIds,
      ctx: {
        broadwayOpeningDate: (parent && parent.openingDate) || null,
        firstBroadwayOpeningDate: firstOpen,
        tourLaunchDate: tour.openingDate || null,
        tourClosingDate: tour.status === 'closed' ? (tour.closingDate || null) : null,
        otherToursOfTitle,
        nextTourLaunchDate: later[0] || null,
        siblingTourUndated,
        stops: (schedules && schedules[tour.id] && schedules[tour.id].stops) || null,
        ukOutlets,
        genericVenues,
      },
    };
  });
}

/**
 * Decide every file for one plan from planTourSweep. listFiles(showId) returns
 * [{ file, data }] for that show folder ([] when missing). Returns one row per
 * tour-flagged file: { fromId, file, data, key }, where key 'tour-review' means
 * move it. Duplicates are caught by URL, not filename: the same review can sit
 * on two Broadway folders under different bylines (denverpost--unknown vs
 * denverpost--john-moore). Shared by scripts/sweep-tour-reviews.js (which moves
 * the 'tour-review' rows in order) and validate-data's pending-sweep warning.
 */
function decideTourSweep(plan, listFiles) {
  const { normalizeUrl } = require('./review-normalization');
  const onTour = new Set();
  const tourFiles = new Set();
  for (const { file, data } of listFiles(plan.tourId)) {
    tourFiles.add(file);
    if (data && data.url) onTour.add(normalizeUrl(data.url));
  }
  const rows = [];
  const files = plan.fromIds.map(fromId => [fromId, listFiles(fromId)]);
  const ctx = plan.ctx.stops
    ? { ...plan.ctx, settingCities: settingCitiesOf(plan.ctx.stops, files.flatMap(([, fs]) => fs)
      .filter(f => f.data && !f.data.wrongProduction).map(f => String(f.data.fullText || '').slice(0, 6000))) }
    : plan.ctx;
  for (const [fromId, list] of files) {
    for (const { file, data } of list) {
      if (!data || file.startsWith('_')) continue;
      const d = classifyTourBackfill(data, ctx);
      if (d.reason === 'not-flagged' || d.reason === 'flag-not-tour') continue;
      let key = d.reason;
      if (d.action === 'move') {
        const u = data.url ? normalizeUrl(data.url) : null;
        if (u && onTour.has(u)) key = 'duplicate-on-tour';
        else if (tourFiles.has(file)) key = 'target-collision';
      }
      if (key === 'tour-review') {
        if (data.url) onTour.add(normalizeUrl(data.url));
        tourFiles.add(file);
      }
      rows.push({ fromId, file, data, key });
    }
  }
  return rows;
}

/**
 * Hard stop for the scheduled sweep (BRO-4262): a mop-up should move a handful
 * of files. More than maxMoves for one tour, or more than maxShare of any one
 * Broadway folder, means intake or a rule broke, so nothing moves.
 * @param {Array<{fromId}>} pending rows keyed 'tour-review'
 * @param {(id:string)=>number} folderSize files in a Broadway folder
 * @returns {string|null} why the tour is held, or null to proceed
 */
function sweepHoldReason(pending, fromIds, folderSize, { maxMoves = 20, maxShare = 0.10 } = {}) {
  if (pending.length > maxMoves) return `${pending.length} moves > cap ${maxMoves}`;
  for (const id of fromIds) {
    const n = pending.filter(r => r.fromId === id).length;
    // Tiny folders: a couple of moves is not a flood.
    if (n > 2 && n > maxShare * folderSize(id)) return `${n} of ${folderSize(id)} files in ${id} (> ${Math.round(maxShare * 100)}%)`;
  }
  return null;
}

/**
 * Limits for one tour's scheduled sweep. A reviewed backlog (a rule change that
 * rescues many files at once, BRO-4656) is let through by an unexpired entry in
 * data/tour-sweep-approvals.json: { tourId, maxMoves, expires: 'YYYY-MM-DD', issue }.
 * The entry lifts the per-folder share check and sets the move cap to the
 * reviewed count; a sweep that wants more than that is still held.
 */
function sweepLimits(approvals, tourId, { maxMoves = 20, now = new Date() } = {}) {
  const list = (approvals && approvals.approvals) || [];
  const a = list.find(x => x && x.tourId === tourId && Number(x.maxMoves) > 0
    && x.expires && now.getTime() <= Date.parse(`${x.expires}T23:59:59Z`));
  return a ? { maxMoves: Number(a.maxMoves), maxShare: 1, approvedBy: a.issue || 'approval' } : { maxMoves };
}

const counts = (d) => d && d.wrongProduction !== true && d.wrongShow !== true && d.isNonReview !== true
  && d.isRoundupArticle !== true && !d.duplicateOf && !d.duplicateTextOf && d.contentTier !== 'invalid';
// A person already ruled on where this file belongs, or locked it: the
// integrity pass never overrides that (the write guard would refuse a locked
// file anyway, every run).
const humanDecided = (d) => Boolean(d._locked || d.wrongProductionManualClear || d.wrongProductionOverride
  || d.humanReviewedWrongProduction);
const INTEGRITY_TAG = 'tour integrity (BRO-4656)';

/**
 * Reviews that count on the wrong page (BRO-4656 audit): a tour-stop review
 * counting on the Broadway show (Gatsby's Austin and Minneapolis reviews), or a
 * UK production's review counting on the North American tour (two Hull
 * reviews of the UK Jersey Boys on jersey-boys-tour-2026). Returns
 * [{ showId, file, reason }] to flag wrongProduction; a flagged Broadway file is
 * then the sweep's to move. Only strong evidence: on Broadway, a stop VENUE in
 * the text at that date, or the stop's city plus tour language; on the tour, a
 * London outlet, a .uk site, or UK text that names no stop of this tour at all.
 */
function decideTourIntegrity(plan, listFiles) {
  const out = [];
  const stops = plan.ctx.stops || [];
  const bway = plan.fromIds.map(id => [id, listFiles(id)]);
  const setting = settingCitiesOf(stops, bway.flatMap(([, fs]) => fs)
    .filter(f => f.data && !f.data.wrongProduction).map(f => String(f.data.fullText || '').slice(0, 6000)));
  for (const [fromId, list] of bway) {
    for (const { file, data } of list) {
      if (file.startsWith('_') || !counts(data) || humanDecided(data)) continue;
      const st = matchStop(data, stops, setting, plan.ctx.genericVenues);
      if (!st) continue;
      const text = String(data.fullText || '').slice(0, 6000);
      const byVenue = namedByVenue(text, st, plan.ctx.genericVenues);
      if (!byVenue && !TOUR_TEXT_RE.test(text.slice(0, 3000))) continue;
      out.push({ showId: fromId, file, kind: 'tour-on-broadway',
        reason: `National tour review: ${st.venue || ''}, ${st.city} stop (${st.start}); ${INTEGRITY_TAG}` });
    }
  }
  const names = stops.flatMap(st => [st.venue, cityName(st.city)])
    .filter(n => n && n.length >= 4 && !UK_AMBIGUOUS_CITIES.has(n));
  for (const { file, data } of listFiles(plan.tourId)) {
    if (file.startsWith('_') || !counts(data) || humanDecided(data)) continue;
    const text = String(data.fullText || '').slice(0, 6000);
    const ukOutlet = plan.ctx.ukOutlets && plan.ctx.ukOutlets.has(data.outletId);
    // "West End"/"London" alone is where a US tour came from (Operation
    // Mincemeat, Life of Pi); a UK town or a UK tour is where it is playing.
    const ukText = UK_TOUR_TEXT_RE.test(text);
    const namesStop = names.some(n => text.includes(n));
    if (ukOutlet || isOverseasHost(data.url) || (ukText && !namesStop)) {
      out.push({ showId: plan.tourId, file, kind: 'uk-on-tour',
        reason: `UK or overseas production reviewed, not the North American tour; ${INTEGRITY_TAG}` });
    }
  }
  return out;
}

// Lazy: scripts/lib is copied flat into fixtures and sparse checkouts that carry no subdirectory, so a top-level require would break them.
const laneBypasses = (...args) => require('./opening-night-lane/trust-model').laneBypasses(...args);

/** The flag write for one decideTourIntegrity row. Returns a new object. */
function applyIntegrityFlag(data, row, at = new Date().toISOString()) {
  const guard = require('./review-write-guard');
  // BRO-4807: an opening-night lane review is never flagged by the tour integrity pass.
  if (laneBypasses(data, 'tourCrossMarket')) return { ...data };
  const next = { ...data, wrongProduction: true, wrongProductionReason: row.reason,
    wrongProductionDetectedBy: 'tour-integrity', wrongProductionDetectedAt: at };
  guard.invalidateWrongProductionAutoClear(next);
  return next;
}

module.exports = {
  clearStaleScoringFailure, genericVenuesOf, decideTourIntegrity, applyIntegrityFlag, settingCitiesOf, sweepLimits, matchStop, loadSweepContext, sweepHoldReason, classifyTourBackfill, prepareTourMove, planTourSweep, decideTourSweep, BROADWAY_RELATIVE_FIELDS };
