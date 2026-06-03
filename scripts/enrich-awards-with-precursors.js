#!/usr/bin/env node
/**
 * Enrich awards.json with precursor-award data for Tony nominees.
 *
 * Five precursor bodies (used by the Tony Predictions Awards Score formula):
 *   - Drama Desk Awards            (tier weight 0.7 in Awards Score)
 *   - Outer Critics Circle Awards  (tier weight 0.9)
 *   - Drama League Awards          (tier weight 1.0)
 *   - NY Drama Critics' Circle     (tier weight 1.0; winners only — no nominees)
 *   - Pulitzer Prize for Drama     (tier weight 1.0; winner + 2 finalists)
 *
 * Coverage: Tony nominees in the 4 main categories (Best Musical, Best Play,
 * Best Revival of a Musical, Best Revival of a Play), seasons 2013-14 through
 * 2024-25 (the predictions-era window).
 *
 * Source data lives in `data/precursors/{drama-desk,outer-critics,drama-league,
 * nydcc,pulitzer}.json`, refreshed by the per-ceremony Wikipedia scrapers in
 * `scripts/scrape-{drama-desk,outer-critics,drama-league,nydcc,pulitzer}.js`
 * (mirrors the pattern in `scrape-tony-awards.js`). To update for a new year,
 * run the relevant scraper; the JSON files are the source of truth this script
 * consumes.
 *
 * Usage:
 *   node scripts/enrich-awards-with-precursors.js [--dry-run]
 *
 * Behavior:
 *   - Idempotent. Running twice produces byte-identical awards.json.
 *   - Migrates legacy Pulitzer shape {year, category} → {wins, finalist, year}.
 *   - Writes to public data/awards.json AND private repo
 *     (~/broadway-scorecard-data/awards.json) since both are sources for
 *     setup-local-data.sh consumers.
 *   - Asserts idempotency at end of run; fails loud if re-running would diverge.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./lib/title-match');
const { writeAwardsJsonAtomic } = require('./lib/awards-atomic-write');
const { validateAwardsObject, validatePrecursorSource } = require('./lib/awards-schema-validator');
const { canonicalizeAllShows, findSynonymDuplicates, canonicalizeAwardCategory } = require('./lib/award-category-canonical');
const { classifyCategory, KNOWN_UNSCORED_CATEGORIES } = require('./lib/classify-category');

const PUBLIC_AWARDS = path.join(__dirname, '..', 'data', 'awards.json');
// Private repo path. Defaults to ~/broadway-scorecard-data/awards.json so the
// script works for any developer / remote runner (env override available for
// non-standard layouts). Skipped at write time if the path doesn't exist —
// no failure mode for CI / contributors without the private checkout.
const PRIVATE_AWARDS = process.env.PRIVATE_AWARDS_PATH
  || path.join(process.env.HOME || '', 'broadway-scorecard-data', 'awards.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const PRECURSORS_DIR = path.join(__dirname, '..', 'data', 'precursors');
const TONY_NOMINATIONS_PATH = path.join(__dirname, '..', 'data', 'tony-nominations.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================
// SOURCE DATA — loaded from data/precursors/*.json
// ============================================================
//
// Each file's `.data` payload mirrors the schema this script consumes:
//   - Drama Desk / OCC / Drama League: { '<category>': [{year, winner, nominees}, ...] }
//     `nominees` MUST include the winner.
//   - NYDCCC: { '<category>': [{year, winner}, ...] }  (winners only)
//   - Pulitzer: [{year, winner, finalists}, ...]       (finalists exclude winner)
//
// The five JSON files are refreshed by the per-ceremony Wikipedia scrapers
// (scripts/scrape-{drama-desk,outer-critics,drama-league,nydcc,pulitzer}.js).
// Ceremony year → Tony season: year N → "(N-1)-N", e.g. 2014 → "2013-14".
// OB→Broadway transfer cases (Hamilton OB 2015 → Broadway 2015-16) are handled
// by the matcher: it searches all years for a title within the Tony-nominee pool.

// Track unknown category names across all loaded precursor files so a single
// summary line is emitted instead of one warning per file.
const _unknownCategoryWarnings = [];

function loadPrecursor(name) {
  const fp = path.join(PRECURSORS_DIR, `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  // Validate source-file shape + flag unknown category names. Schema
  // violations throw; classifyCategory misses are collected and printed
  // once at end-of-load (a typo like "Outstanding Direcetor" passes schema
  // but silently misses the +30 win bonus downstream).
  const { unknownCategories } = validatePrecursorSource(name, raw, {
    isKnownCategory: (cat) => classifyCategory(cat) !== null || KNOWN_UNSCORED_CATEGORIES.has(cat),
  });
  for (const cat of unknownCategories) {
    _unknownCategoryWarnings.push(`  ${name}.json: "${cat}"`);
  }
  return raw.data;
}

const DRAMA_DESK = loadPrecursor('drama-desk');
const OUTER_CRITICS = loadPrecursor('outer-critics');
const DRAMA_LEAGUE = loadPrecursor('drama-league');
const NYDCCC = loadPrecursor('nydcc');
const OBIE = loadPrecursor('obie');
const LORTEL = loadPrecursor('lortel');
const OBA = loadPrecursor('oba');
const CRITICS_CIRCLE = loadPrecursor('critics-circle');
const EVENING_STANDARD = loadPrecursor('evening-standard');
const WHATSONSTAGE = loadPrecursor('whatsonstage');
const PULITZER = loadPrecursor('pulitzer');
// Historic Pulitzer (pre-2014) uses explicit showIds — fuzzy title matching
// fails on multiple revival history (e.g. 5 Death of a Salesman entries).
// See data/precursors/pulitzer-historic.json header for full rationale.
const HISTORIC_PULITZER = loadPrecursor('pulitzer-historic');


// ============================================================
// MATCHING
// ============================================================

const TONY_CATS = ['Best Musical','Best Play','Best Revival of a Musical','Best Revival of a Play'];
const CAT_SET = new Set(TONY_CATS);
const PREDICTIONS_ERA = ['2013-14','2014-15','2015-16','2016-17','2017-18','2018-19','2019-20','2021-22','2022-23','2023-24','2024-25','2025-26'];
// Latest entry — used by the matcher to relax the "must have Tony noms"
// gate while Tony nominations for the active season haven't been announced yet.
const ACTIVE_SEASON = PREDICTIONS_ERA[PREDICTIONS_ERA.length - 1];
// "2025-26" → 2026 (the ceremony year that maps to ACTIVE_SEASON's Tony season).
// Source entries from prior years must NOT match active-season shows via pass 3/4
// (e.g. Drama League 2023 "Titanique" must not attribute to titanique-2026).
const ACTIVE_CEREMONY_YEAR = parseInt(ACTIVE_SEASON.split('-')[0], 10) + 1;

function ceremonyYearToTonySeason(y) {
  return `${y - 1}-${String(y).slice(2)}`;
}

/** Map a YYYY-MM-DD opening date to the Tony season it falls within ("2024-25"
 *  for May 1 2024 through April 30 2025), or null if outside PREDICTIONS_ERA.
 *  Used by pass 4 to attribute past-season DD/OCC/DL/Pulitzer noms to
 *  non-Tony-nominated Broadway shows that aren't already in awards.json. */
function seasonForOpeningDate(openingDate) {
  if (!openingDate || typeof openingDate !== 'string' || openingDate.length < 7) return null;
  const year = parseInt(openingDate.slice(0, 4), 10);
  const month = parseInt(openingDate.slice(5, 7), 10);
  if (Number.isNaN(year) || Number.isNaN(month)) return null;
  // Tony season: May Y → April Y+1 = season "Y-(Y+1)%100"
  const startYear = month >= 5 ? year : year - 1;
  const season = `${startYear}-${String(startYear + 1).slice(2)}`;
  return PREDICTIONS_ERA.includes(season) ? season : null;
}

/** Find a showId for a scraped title. Looks across the predictions-era pool of
 *  Tony nominees by title — handles OB→Broadway transfers (e.g. Hamilton's Tony
 *  is 2015-16 but DD 2015 OB win still matters).
 *
 *  For the ACTIVE_SEASON only, the strict "must have Tony noms" gate is loosened:
 *  Tony nominations for the current season may not be announced yet, but DD/OCC
 *  precursor noms drop earlier and need a place to land. Pass 3 matches active-season
 *  shows already in awards.json (regardless of nominatedFor); pass 4 falls back to
 *  shows.json for active-season Broadway shows missing from awards.json and
 *  lazy-creates a stub entry so the precursor field has somewhere to attach.
 *
 *  Returns null if no match. */
function findShowIdByTitle(scrapedTitle, awardsShows, titleById, opts = {}) {
  const norm = normalizeTitle(scrapedTitle);
  if (!norm) return null;

  // Pass 0 (season-match preference): when the source has a known year and
  // MULTIPLE Broadway productions of the same title exist in awards.json
  // (e.g. death-of-a-salesman-2022 + death-of-a-salesman-2026), prefer the
  // one whose tony.season matches the source year's Tony season — REGARDLESS
  // of whether that production also has top-category Tony noms. Without this
  // preference, the stricter Pass 1 gate (top-cat Tony noms required) picked
  // the wrong production: DD 2023 noms for "Death of a Salesman" were going
  // to death-of-a-salesman-2026 (which has Best Revival of a Play 2025-26)
  // instead of the actual 2022-23 production (which has only Best Actor +
  // Best Lighting noms, neither in the top-cat set).
  //
  // OB→Broadway transfer cases (Hamilton DD 2015 OB → hamilton-2015 in
  // 2015-16 Tony season) are unaffected — there's only ONE Hamilton in the
  // pool, so no Pass 0 preference triggers and Pass 1 still wins.
  const targetSeasonForP1 = opts.sourceYear ? ceremonyYearToTonySeason(opts.sourceYear) : null;
  // Pass 0a: exact title match in same Tony season. Works for both
  // PREDICTIONS_ERA and pre-PE seasons (historical scrape coverage extends
  // back to 1970). The season-match is strict enough to safely disambiguate
  // multiple productions of the same title.
  if (targetSeasonForP1) {
    for (const [showId, sh] of Object.entries(awardsShows)) {
      if (!sh.tony || sh.tony.season !== targetSeasonForP1) continue;
      const t = titleById[showId];
      if (!t) continue;
      if (normalizeTitle(t) === norm) return showId;
    }
  }
  if (targetSeasonForP1 && PREDICTIONS_ERA.includes(targetSeasonForP1)) {
    // Pass 0b: prefix-containment match in the same season — handles long-
    // subtitled show titles (e.g. source "Purlie Victorious" / show "Purlie
    // Victorious: A Non-Confederate Romp Through the Cotton Patch", or
    // source "A Beautiful Noise" / show "A Beautiful Noise, The Neil Diamond
    // Musical"). Pass 2 has the same prefix logic but with a 35-char diff
    // cap and a top-cat Tony noms gate; the season-match here is strict
    // enough to safely drop both restrictions for this case.
    //
    // Token requirement (≥2 tokens on the shorter side) preserved to avoid
    // the "Father Comes Home From the Wars" / "The Father" false-match class.
    if (norm.length >= 6) {
      const shorterNeeds2Tokens = norm.split(' ').filter(Boolean).length >= 2;
      if (shorterNeeds2Tokens) {
        for (const [showId, sh] of Object.entries(awardsShows)) {
          if (!sh.tony || sh.tony.season !== targetSeasonForP1) continue;
          const t = titleById[showId];
          if (!t) continue;
          const nT = normalizeTitle(t);
          if (nT.length < 6) continue;
          if (nT.startsWith(norm + ' ') || norm.startsWith(nT + ' ')) {
            return showId;
          }
        }
      }
    }
  }

  // Pass 1: exact match against Tony-nominated shows in predictions era (strict gate).
  let p1PreferredId = null;
  let p1FallbackId = null;
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.tony || !PREDICTIONS_ERA.includes(sh.tony.season)) continue;
    const noms = (sh.tony.nominatedFor || []).filter(c => CAT_SET.has(c));
    if (noms.length === 0) continue;
    const t = titleById[showId];
    if (!t) continue;
    if (normalizeTitle(t) !== norm) continue;
    if (targetSeasonForP1 && sh.tony.season === targetSeasonForP1) {
      p1PreferredId = showId;
      break;
    }
    if (!p1FallbackId) p1FallbackId = showId;
  }
  if (p1PreferredId) return p1PreferredId;
  // UK ceremonies (CC/ES/WOS/Olivier) set strictSeason: a season mismatch must
  // not silently attribute to a Broadway transfer in a different season. Let
  // Pass 4/5 (both season-gated) route to the correct WE/OWE production.
  // The fallback exists for non-UK ceremonies where Tony season ≠ ceremony year
  // is normal (e.g. DD recognizing pre-season productions).
  if (p1FallbackId && !opts.strictSeason) return p1FallbackId;

  // Pass 2: prefix containment — for cases like "Shuffle Along" matching the long form
  // "Shuffle Along, or, the Making of the Musical Sensation of 1921 ..."
  //
  // Require the SHORTER side to be ≥2 tokens. Single-token shorter sides
  // false-match: "Father Comes Home From the Wars" (Pulitzer 2015 finalist)
  // normalized to "father comes home from the wars" caught "The Father" (norm
  // "father", 1 token) and credited the-father-2016 with a Pulitzer it didn't
  // earn. ≥2 tokens preserves the Shuffle Along case (norm "shuffle along")
  // while killing the false-positive class.
  //
  // Same season-collision logic as Pass 1: prefer the production whose
  // tony.season matches the source year when multiple candidates fit.
  let p2PreferredId = null;
  let p2FallbackId = null;
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.tony || !PREDICTIONS_ERA.includes(sh.tony.season)) continue;
    const noms = (sh.tony.nominatedFor || []).filter(c => CAT_SET.has(c));
    if (noms.length === 0) continue;
    const t = titleById[showId];
    if (!t) continue;
    const nT = normalizeTitle(t);
    if (norm.length < 6 || nT.length < 6) continue;
    const shorter = nT.length < norm.length ? nT : norm;
    if (shorter.split(' ').filter(Boolean).length < 2) continue;
    if (!(nT.startsWith(norm + ' ') || norm.startsWith(nT + ' '))) continue;
    if (Math.abs(nT.length - norm.length) > 35) continue;
    if (targetSeasonForP1 && sh.tony.season === targetSeasonForP1) {
      p2PreferredId = showId;
      break;
    }
    if (!p2FallbackId) p2FallbackId = showId;
  }
  if (p2PreferredId) return p2PreferredId;
  // Same UK-ceremony strict-season guard as Pass 1 — see the comment above.
  if (p2FallbackId && !opts.strictSeason) return p2FallbackId;

  // Pass 3 (active season only): relaxed gate against awards.json — Tony noms may
  // not be published yet for the active season, so allow matching shows whose
  // tony.season is set but nominatedFor is empty.
  if (opts.sourceYear === ACTIVE_CEREMONY_YEAR) {
    for (const [showId, sh] of Object.entries(awardsShows)) {
      if (!sh.tony || sh.tony.season !== ACTIVE_SEASON) continue;
      const t = titleById[showId];
      if (!t) continue;
      if (normalizeTitle(t) === norm) return showId;
    }
  }

  // Pass 4: shows.json fallback for any PREDICTIONS_ERA season — match the
  // Broadway production whose opening date falls in the source year's Tony
  // season window (May Y-1 → April Y for ceremony year Y). Lazy-creates an
  // awards.json stub or backfills tony.season on existing entries that lack it.
  //
  // Year-gating is essential: prior-year nominations for OB shows that later
  // transferred to Broadway as a DIFFERENT production (e.g. DL 2023 "Titanique"
  // OB → titanique-2026 Broadway revival) would false-attribute without it.
  // Pass 1+2 still search across ALL PREDICTIONS_ERA years for the Tony-nominee
  // pool, which correctly handles the OB→Broadway transfer cases (Hamilton DD
  // 2015 OB matches hamilton-2015 in 2015-16 Tony season via pass 1).
  if (opts.broadwayShowsBySeason && opts.sourceYear) {
    const targetSeason = ceremonyYearToTonySeason(opts.sourceYear);
    if (PREDICTIONS_ERA.includes(targetSeason)) {
      const candidates = opts.broadwayShowsBySeason.get(targetSeason) || [];
      const matchAndApply = (sh) => {
        if (!awardsShows[sh.id]) {
          awardsShows[sh.id] = { tony: { season: targetSeason, nominatedFor: [] } };
          if (opts.onCreate) opts.onCreate(sh.id);
        } else {
          // Backfill tony.season on existing entries (e.g. giant-2026 had only
          // an Olivier block; without tony.season, downstream consumers like
          // data-tony-predictions.ts:384 filter the show out).
          if (!awardsShows[sh.id].tony) {
            awardsShows[sh.id].tony = { season: targetSeason, nominatedFor: [] };
            if (opts.onBackfillTony) opts.onBackfillTony(sh.id);
          } else if (!awardsShows[sh.id].tony.season) {
            awardsShows[sh.id].tony.season = targetSeason;
            if (opts.onBackfillTony) opts.onBackfillTony(sh.id);
          }
        }
        titleById[sh.id] = sh.title;
        return sh.id;
      };
      // Pass 4a: exact match by normalized title.
      for (const sh of candidates) {
        if (normalizeTitle(sh.title) !== norm) continue;
        return matchAndApply(sh);
      }
      // Pass 4b: prefix-containment match for shows with long subtitles
      // (e.g. source "A Beautiful Noise" / show "A Beautiful Noise, The Neil
      // Diamond Musical"). Same season-gate as Pass 4a — the season match is
      // the strict guard against false-positive cross-production attribution
      // (the colliding-titles case that Pass 0/1/2 also guard against). Token
      // requirement preserves the "Father Comes Home From the Wars" /
      // "The Father" disambiguation rule.
      if (norm.length >= 6 && norm.split(' ').filter(Boolean).length >= 2) {
        for (const sh of candidates) {
          const nT = normalizeTitle(sh.title);
          if (nT.length < 6) continue;
          if (nT.startsWith(norm + ' ') || norm.startsWith(nT + ' ')) {
            return matchAndApply(sh);
          }
        }
      }
    }
  }

  // Pass 5: OB/OWE shows.json fallback — same season-gate as Pass 4 but for
  // off-broadway/off-west-end shows. Creates a stub WITHOUT a tony field (OB
  // shows are not Tony-eligible). Used for Lortel, Obie, Drama Desk OB noms,
  // and Critics' Circle that cover OB nominees.
  if (opts.obShowsBySeason && opts.sourceYear) {
    const targetSeason = ceremonyYearToTonySeason(opts.sourceYear);
    if (PREDICTIONS_ERA.includes(targetSeason)) {
      const candidates = opts.obShowsBySeason.get(targetSeason) || [];
      const matchAndApplyOB = (sh) => {
        if (!awardsShows[sh.id]) {
          awardsShows[sh.id] = {}; // No tony stub — OB shows aren't Tony-eligible
          if (opts.onCreateOB) opts.onCreateOB(sh.id);
        }
        titleById[sh.id] = sh.title;
        return sh.id;
      };
      // Pass 5a: exact match
      for (const sh of candidates) {
        if (normalizeTitle(sh.title) !== norm) continue;
        return matchAndApplyOB(sh);
      }
      // Pass 5b: prefix-containment match for long subtitles
      if (norm.length >= 6 && norm.split(' ').filter(Boolean).length >= 2) {
        for (const sh of candidates) {
          const nT = normalizeTitle(sh.title);
          if (nT.length < 6) continue;
          if (nT.startsWith(norm + ' ') || norm.startsWith(nT + ' ')) {
            return matchAndApplyOB(sh);
          }
        }
      }
    }
  }

  return null;
}

// ============================================================
// MERGE (idempotent)
// ============================================================

/** Sort + dedupe an array. Mutates returned new array. */
function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

/** Ensure a precursor field exists with sorted+deduped wins/nominatedFor.
 *  Mutates the show object. */
function ensurePrecursorField(sh, key, defaultSeason) {
  if (!sh[key]) sh[key] = {};
  const f = sh[key];
  if (!f.season && defaultSeason) f.season = defaultSeason;
  f.wins = Array.isArray(f.wins) ? uniqSorted(f.wins) : [];
  f.nominatedFor = Array.isArray(f.nominatedFor) ? uniqSorted(f.nominatedFor) : [];
  // Preserve existing `nominations` count if present (used by AwardsCard "noms" display)
}

/** Migrate Pulitzer field to canonical shape: { wins?, finalist?, year? }.
 *  Drops legacy {category} key (always "Drama" — redundant). */
function migratePulitzer(sh) {
  if (!sh.pulitzer) return;
  const p = sh.pulitzer;
  // Legacy {year, category} ALWAYS represented a win in pre-enrichment data.
  // If we see {year, category} without wins/finalist, treat it as a win record.
  if (typeof p.year === 'number' && p.category && !Array.isArray(p.wins) && !Array.isArray(p.finalist)) {
    sh.pulitzer = { wins: ['Drama'], finalist: [], year: p.year };
    return;
  }
  // Hybrid: has both legacy and new keys. Keep year, normalize the rest.
  const out = {
    wins: Array.isArray(p.wins) ? uniqSorted(p.wins) : [],
    finalist: Array.isArray(p.finalist) ? uniqSorted(p.finalist) : [],
  };
  if (typeof p.year === 'number') out.year = p.year;
  sh.pulitzer = out;
}

// Lazy-loaded Tony nominations for person-name winner → showId lookup.
// Acting categories (DD Lead/Featured Performance, OCC Lead/Featured Performer)
// store person names as winners rather than show titles. We resolve their showId
// via Tony nominations rather than the title map.
let _tonyNominations = null;
function getTonyNoms() {
  if (!_tonyNominations) {
    _tonyNominations = JSON.parse(fs.readFileSync(TONY_NOMINATIONS_PATH, 'utf8')).nominations || [];
  }
  return _tonyNominations;
}

/** For a person-name winner, return showIds they're Tony-nominated for in the given season. */
function lookupWinnerShowIds(personName, season, awardsShows) {
  const norm = normalizeTitle(personName);
  const ids = new Set();
  for (const n of getTonyNoms()) {
    if (n.season === season && normalizeTitle(n.name) === norm && awardsShows[n.showId]) {
      ids.add(n.showId);
    }
  }
  return [...ids];
}

/** Apply DD/OCC/DL source data to awards.json. Adds nominatedFor (and `wins`
 *  for the matching Tony category, when scraped winner matches).
 *
 *  Acting categories (DD Lead/Featured Performance, OCC Lead/Featured Performer)
 *  store person names as `winner`/`winners`. For these, we look up the winner's
 *  showId via Tony nominations and write both `wins` and `winnerNames`. */
function applyDDOCCDL(source, fieldKey, awardsShows, titleById, opts) {
  // UK ceremonies must not silently fall back to a Broadway transfer in a
  // different season than the one the ceremony recognized. e.g. WOS 2024
  // (season 2023-24) awarded Best New Musical to Operation Mincemeat — the
  // WE production opened May 2023 (season 2023-24) but Pass 1's cross-season
  // fallback was attributing the win to the BW transfer (season 2024-25).
  // strictSeason disables that fallback for UK ceremonies; Pass 4/5 then
  // route correctly via their built-in season gate.
  const UK_CEREMONIES = new Set(['criticsCircle', 'eveningStandard', 'whatsOnStage', 'olivier']);
  const strictSeason = UK_CEREMONIES.has(fieldKey);
  let matched = 0;
  const unmatched = [];
  for (const [rawScrapedCategory, years] of Object.entries(source)) {
    // Canonicalize the scraped category up front so EVERYTHING downstream —
    // wins/nominatedFor writes, winnerNames keys, AND the cross-show stale-winner
    // cleanup below (which matches by scrapedCategory) — operates in canonical
    // space. Without this, a future "Direction of a Musical" scrape would write
    // canonical "Director..." but its cleanup would search for the raw string and
    // miss already-canonicalized entries, leaving a stale winner on the wrong show.
    const scrapedCategory = canonicalizeAwardCategory(fieldKey, rawScrapedCategory);
    for (const yearEntry of years) {
      const callOpts = { ...opts, sourceYear: yearEntry.year, strictSeason };

      // Explicit tie co-winners from the year-page parser: each winner is
      // paired with its OWN production in the markup (e.g. DD 2026 Lead
      // Performance in a Musical: Henry + Levy, both Ragtime; Lead Play:
      // Lithgow/Giant + Manville/Oedipus). When present we attribute each
      // person to their paired show directly — no nominee-adjacency or Tony
      // fallback guessing. Only trust it when every entry has BOTH person+show.
      const explicitWinnerEntries = Array.isArray(yearEntry.winnerEntries)
        && yearEntry.winnerEntries.length > 0
        && yearEntry.winnerEntries.every((e) => e && e.person && e.show)
        ? yearEntry.winnerEntries
        : null;

      // Resolve winner titles — may be show titles OR person names (acting categories).
      const winnerTitles = explicitWinnerEntries
        ? explicitWinnerEntries.map((e) => e.person)
        : (Array.isArray(yearEntry.winners) && yearEntry.winners.length > 0
            ? yearEntry.winners
            : (yearEntry.winner ? [yearEntry.winner] : []));

      // Detect person-name winners: if NONE of the winner titles resolve to a show, they're people.
      const anyWinnerIsShow = winnerTitles.some(
        (w) => findShowIdByTitle(w, awardsShows, titleById, callOpts) != null,
      );
      const winnerIsPersonName = winnerTitles.length > 0 && !anyWinnerIsShow;

      // Year-page-aware short-circuit: if winnerPersonName is populated, the
      // year-page scraper is telling us the winner field stores the SHOW NAME
      // (not a person). When that show isn't tracked in shows.json, do NOT
      // fall into person-winner adjacency — adjacency picks a random alphabetical
      // neighbor and credits a wrong show (e.g. Featured Musical Kuhn/Baker's-Wife
      // → schmigadoon-2026 because Baker's Wife isn't tracked). The correct
      // behavior is to skip the win attribution entirely; nominees still flow
      // into nominatedFor below.
      const winnerShowUntracked = yearEntry.winnerPersonName && !anyWinnerIsShow;

      // For person-name winners: map each winner to a showId. Resolution rules:
      //   1. If winner IS in the nominees array (the common case): use the
      //      ADJACENT show — Wikipedia DD/OCC/DL/Lortel tables list nominees as
      //      [person, show, person, show, ...]. This is the scraper's own
      //      statement of which show won. Do NOT fall back to Tony when the
      //      paired show isn't tracked in our data — Tony can return a
      //      DIFFERENT show the person is nominated for (e.g. Tom Gibbons
      //      DD 2026 Sound Design won for "Initiative" but is Tony-nominated
      //      for Oedipus — crediting Oedipus is wrong).
      //   2. If winner is NOT in the nominees array (tie winners listed only
      //      in `winners`, e.g. DD 2026 Lead Performance in a Play tie:
      //      Lithgow appears in nominees, Manville does not): fall back to
      //      Tony lookup for the season.
      //
      // The pair-primary rule handles off-Broadway shows (Kenrex, Mexodus,
      // etc) that aren't Tony-nominated and were silently dropped by the
      // prior Tony-only logic.
      const personWinnerShowMap = new Map(); // normalizedName → showId[]
      if (explicitWinnerEntries) {
        // Authoritative person→show pairing straight from the year-page markup.
        for (const e of explicitWinnerEntries) {
          const sid = findShowIdByTitle(e.show, awardsShows, titleById, callOpts);
          if (!sid) {
            unmatched.push(`${fieldKey}/${scrapedCategory}/${yearEntry.year}: tie winner "${e.person}" → show "${e.show}" not tracked in shows.json`);
            continue;
          }
          const key = normalizeTitle(e.person);
          const arr = personWinnerShowMap.get(key) || [];
          if (!arr.includes(sid)) arr.push(sid);
          personWinnerShowMap.set(key, arr);
        }
      } else if (winnerIsPersonName && !winnerShowUntracked) {
        const season = ceremonyYearToTonySeason(callOpts.sourceYear);
        const noms = yearEntry.nominees || [];
        for (const w of winnerTitles) {
          let showIds = [];
          const normW = normalizeTitle(w);
          const widx = noms.findIndex((n) => normalizeTitle(n) === normW);
          if (widx >= 0) {
            // Winner is in nominees — scan forward for the next entry that
            // resolves to a show. Usually that's immediately at idx+1, but
            // multi-person nominees (e.g. DD 2026 Featured Play row contains
            // "Linda Emond","David Greenspan","Prince F****t" — two leads
            // sharing one show) and composer teams ("Stan Mathabane (composer)
            // and Munir Zakee (musician)" can land person-name entries
            // adjacent to the winner. Scan up to 4 positions forward. If
            // nothing resolves, do NOT fall back to Tony — that would credit
            // a show the person is Tony-nominated for but didn't DD-win at.
            const scanLimit = Math.min(widx + 5, noms.length);
            for (let i = widx + 1; i < scanLimit; i++) {
              const candidateShowId = findShowIdByTitle(noms[i], awardsShows, titleById, callOpts);
              if (candidateShowId) { showIds = [candidateShowId]; break; }
            }
          } else {
            // Winner not in nominees (tie listed separately) — fall back to Tony.
            showIds = lookupWinnerShowIds(w, season, awardsShows);
          }
          if (showIds.length > 0) {
            personWinnerShowMap.set(normalizeTitle(w), showIds);
          } else if (widx >= 0) {
            unmatched.push(`${fieldKey}/${scrapedCategory}/${yearEntry.year}: person-winner "${w}" paired with show "${noms[widx + 1] || '<end of list>'}" not tracked in shows.json`);
          } else {
            unmatched.push(`${fieldKey}/${scrapedCategory}/${yearEntry.year}: person-winner "${w}" not in nominees and no Tony nominations in ${season}`);
          }
        }
      }

      // Targeted cleanup: the prior Tony-only matcher could miscredit a
      // person-name win to a Tony-nominated show that isn't the actual DD
      // winner (e.g. Lithgow DD 2026 Lead Performance went to giant-2026 via
      // Tony lookup because Lithgow is Tony-nominated for Giant; the actual
      // DD-winning show is well-ill-let-you-go). To clean these stale
      // attributions WITHOUT wiping legitimate OB→Broadway transfer wins
      // (e.g. Hamilton's DD 2015 OB wins live on hamilton-2015 whose
      // dramadesk.season is 2015-16, the same as DD 2016 Broadway-eligible
      // shows), we operate PER-WINNER: for each winner W, if the OLD Tony
      // lookup gave a different show than the NEW pair-based answer, strip
      // W's name from the Tony-attributed show's winnerNames and remove the
      // category from wins only if no other person remains for that category.
      //
      // Must be per-winner (not aggregated across all tie-winners) — a tie
      // with two winners going to two different shows (e.g. DD 2026 Lead
      // Performance in a Musical: Henry@ragtime + Levy@chess) means one
      // winner's correct show may equal another winner's Tony show. A
      // set-based correctShowIds vs tonyAttributedShowIds comparison would
      // miss the per-winner mis-attribution.
      if (winnerIsPersonName && personWinnerShowMap.size > 0) {
        const season = ceremonyYearToTonySeason(callOpts.sourceYear);
        for (const w of winnerTitles) {
          const normW = normalizeTitle(w);
          const correctIds = new Set(personWinnerShowMap.get(normW) || []);
          const tonyIds = new Set(lookupWinnerShowIds(w, season, awardsShows));
          for (const otherId of tonyIds) {
            if (correctIds.has(otherId)) continue;
            const otherFK = awardsShows[otherId] && awardsShows[otherId][fieldKey];
            if (!otherFK) continue;
            // Strip this winner's name from the category's winnerNames.
            if (otherFK.winnerNames && Array.isArray(otherFK.winnerNames[scrapedCategory])) {
              otherFK.winnerNames[scrapedCategory] = otherFK.winnerNames[scrapedCategory].filter((n) => normalizeTitle(n) !== normW);
              if (otherFK.winnerNames[scrapedCategory].length === 0) {
                delete otherFK.winnerNames[scrapedCategory];
              }
              if (Object.keys(otherFK.winnerNames).length === 0) delete otherFK.winnerNames;
            }
            // Remove the category from wins only if no winnerNames remain
            // for it AND the category isn't claimed via show-name path.
            const stillHasName = otherFK.winnerNames && Array.isArray(otherFK.winnerNames[scrapedCategory]) && otherFK.winnerNames[scrapedCategory].length > 0;
            if (!stillHasName && Array.isArray(otherFK.wins) && otherFK.wins.includes(scrapedCategory)) {
              otherFK.wins = otherFK.wins.filter((c) => c !== scrapedCategory);
            }
          }
        }
      }

      for (const nomineeName of yearEntry.nominees) {
        const showId = findShowIdByTitle(nomineeName, awardsShows, titleById, callOpts);
        if (!showId) {
          // Silently skip person names that appear in acting-category nominees lists.
          // They're expected (DD tables list person+show on separate cells) and
          // cause unmatched noise that isn't actionable.
          if (!winnerIsPersonName) {
            unmatched.push(`${fieldKey}/${scrapedCategory}/${yearEntry.year}: ${nomineeName}`);
          }
          continue;
        }
        const sh = awardsShows[showId];
        const season = (sh.tony && sh.tony.season) || ceremonyYearToTonySeason(callOpts.sourceYear);
        ensurePrecursorField(sh, fieldKey, season);
        if (!sh[fieldKey].nominatedFor.includes(scrapedCategory)) {
          sh[fieldKey].nominatedFor.push(scrapedCategory);
          sh[fieldKey].nominatedFor = uniqSorted(sh[fieldKey].nominatedFor);
        }

        const normalizedNominee = normalizeTitle(nomineeName);
        // Show-title winner check (production categories).
        const isWinner = !winnerIsPersonName &&
          winnerTitles.some((w) => normalizeTitle(w) === normalizedNominee);

        // Person-name winner check: which winners come from this show?
        const winnerPersonsForShow = winnerIsPersonName
          ? winnerTitles.filter((w) => {
              const wShowIds = personWinnerShowMap.get(normalizeTitle(w));
              return wShowIds && wShowIds.includes(showId);
            })
          : [];

        if (isWinner || winnerPersonsForShow.length > 0) {
          if (!sh[fieldKey].wins.includes(scrapedCategory)) {
            sh[fieldKey].wins.push(scrapedCategory);
            sh[fieldKey].wins = uniqSorted(sh[fieldKey].wins);
          }
          // Write winnerNames for person-name winners (acting categories).
          if (winnerPersonsForShow.length > 0) {
            if (!sh[fieldKey].winnerNames) sh[fieldKey].winnerNames = {};
            const existing = sh[fieldKey].winnerNames[scrapedCategory] || [];
            for (const p of winnerPersonsForShow) {
              if (!existing.includes(p)) existing.push(p);
            }
            sh[fieldKey].winnerNames[scrapedCategory] = existing.sort();
          }
          // Write winnerNames from OCC-style winnerPersonName (show-title winner with stored person).
          if (isWinner && yearEntry.winnerPersonName) {
            if (!sh[fieldKey].winnerNames) sh[fieldKey].winnerNames = {};
            const existing = sh[fieldKey].winnerNames[scrapedCategory] || [];
            if (!existing.includes(yearEntry.winnerPersonName)) existing.push(yearEntry.winnerPersonName);
            sh[fieldKey].winnerNames[scrapedCategory] = existing.sort();
          }
        }
        matched++;
      }
    }
  }
  return { matched, unmatched };
}

/** Apply NYDCCC source. Winners only — `wins` populated; no nominatedFor.
 *  noAward entries ({year, noAward:true}) are skipped — they represent
 *  years the Circle voted to give no award; there is no show to attach them to. */
function applyNYDCCC(source, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const [category, years] of Object.entries(source)) {
    for (const yearEntry of years) {
      if (yearEntry.noAward) continue;
      if (!yearEntry.winner) continue;
      const callOpts = { ...opts, sourceYear: yearEntry.year };
      const showId = findShowIdByTitle(yearEntry.winner, awardsShows, titleById, callOpts);
      if (!showId) {
        unmatched.push(`NYDCCC/${category}/${yearEntry.year}: ${yearEntry.winner}`);
        continue;
      }
      const sh = awardsShows[showId];
      const nydSeason = (sh.tony && sh.tony.season) || ceremonyYearToTonySeason(callOpts.sourceYear);
      ensurePrecursorField(sh, 'nyDramaCritics', nydSeason);
      if (!sh.nyDramaCritics.wins.includes(category)) {
        sh.nyDramaCritics.wins.push(category);
        sh.nyDramaCritics.wins = uniqSorted(sh.nyDramaCritics.wins);
      }
      matched++;
    }
  }
  return { matched, unmatched };
}

/** Apply Obie source. Winners only (Wikipedia has no nominees list for Obie Awards).
 *  Per-category keyed, same source shape as DD/OCC/DL but only `winner` present. */
function applyObie(source, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const [category, years] of Object.entries(source)) {
    for (const yearEntry of years) {
      if (!yearEntry.winner) continue;
      const callOpts = { ...opts, sourceYear: yearEntry.year };
      const showId = findShowIdByTitle(yearEntry.winner, awardsShows, titleById, callOpts);
      if (!showId) {
        unmatched.push(`obie/${category}/${yearEntry.year}: ${yearEntry.winner}`);
        continue;
      }
      const sh = awardsShows[showId];
      const obieSeason = (sh.tony && sh.tony.season) || ceremonyYearToTonySeason(callOpts.sourceYear);
      ensurePrecursorField(sh, 'obie', obieSeason);
      if (!sh.obie.wins.includes(category)) {
        sh.obie.wins.push(category);
        sh.obie.wins = uniqSorted(sh.obie.wins);
      }
      matched++;
    }
  }
  return { matched, unmatched };
}

/** Apply Pulitzer source. Sets wins (winner) or finalist per show, records year. */
function applyPulitzer(source, awardsShows, titleById, opts) {
  let matched = 0;
  const unmatched = [];
  for (const e of source) {
    const callOpts = { ...opts, sourceYear: e.year };
    // Winner
    const wId = findShowIdByTitle(e.winner, awardsShows, titleById, callOpts);
    if (!wId) unmatched.push(`Pulitzer/${e.year} winner: ${e.winner}`);
    else {
      const sh = awardsShows[wId];
      if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
      if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
      if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
      if (!sh.pulitzer.wins.includes('Drama')) sh.pulitzer.wins.push('Drama');
      sh.pulitzer.wins = uniqSorted(sh.pulitzer.wins);
      sh.pulitzer.year = e.year;
      matched++;
    }
    // Finalists
    for (const f of e.finalists) {
      const fId = findShowIdByTitle(f, awardsShows, titleById, callOpts);
      if (!fId) { unmatched.push(`Pulitzer/${e.year} finalist: ${f}`); continue; }
      const sh = awardsShows[fId];
      if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
      if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
      if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
      // If show is also a winner in same year, don't add to finalist
      if (!sh.pulitzer.wins.includes('Drama') && !sh.pulitzer.finalist.includes('Drama')) {
        sh.pulitzer.finalist.push('Drama');
      }
      sh.pulitzer.finalist = uniqSorted(sh.pulitzer.finalist);
      // Record finalist year only if no winner year already set
      if (typeof sh.pulitzer.year !== 'number') sh.pulitzer.year = e.year;
      matched++;
    }
  }
  return { matched, unmatched };
}

/** Apply HISTORIC_PULITZER (pre-2014 winners + finalists) by explicit showId.
 *  Direct lookup, no fuzzy matching — historic titles + revivals are too
 *  ambiguous for the predictions-era matcher. Skips entries whose showId is
 *  missing from awards.json (e.g. OB-only winners and finalists). */
function applyHistoricPulitzerById(source, awardsShows) {
  let matched = 0;
  const missing = [];
  for (const e of source) {
    if (e.winnerId) {
      const sh = awardsShows[e.winnerId];
      if (!sh) {
        missing.push(`Pulitzer/${e.year} winner: ${e.winnerId} (not in awards.json)`);
      } else {
        if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
        if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
        if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
        if (!sh.pulitzer.wins.includes('Drama')) sh.pulitzer.wins.push('Drama');
        sh.pulitzer.wins = uniqSorted(sh.pulitzer.wins);
        sh.pulitzer.year = e.year;
        matched++;
      }
    }
    if (Array.isArray(e.finalistIds)) {
      for (const fId of e.finalistIds) {
        const sh = awardsShows[fId];
        if (!sh) {
          missing.push(`Pulitzer/${e.year} finalist: ${fId} (not in awards.json)`);
          continue;
        }
        if (!sh.pulitzer) sh.pulitzer = { wins: [], finalist: [] };
        if (!Array.isArray(sh.pulitzer.wins)) sh.pulitzer.wins = [];
        if (!Array.isArray(sh.pulitzer.finalist)) sh.pulitzer.finalist = [];
        if (!sh.pulitzer.wins.includes('Drama') && !sh.pulitzer.finalist.includes('Drama')) {
          sh.pulitzer.finalist.push('Drama');
        }
        sh.pulitzer.finalist = uniqSorted(sh.pulitzer.finalist);
        if (typeof sh.pulitzer.year !== 'number') sh.pulitzer.year = e.year;
        matched++;
      }
    }
  }
  return { matched, missing };
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log('=== ENRICH AWARDS WITH PRECURSORS ===');
  if (_unknownCategoryWarnings.length > 0) {
    console.warn(`⚠ ${_unknownCategoryWarnings.length} unknown precursor category name(s) — will not contribute to the awards-score noms tail:`);
    for (const w of _unknownCategoryWarnings) console.warn(w);
    console.warn('  Fix: add the category to scripts/lib/classify-category.js + mirror in src/lib/awards-scoring.ts');
  }
  if (DRY_RUN) console.log('DRY RUN — no files will be written\n');

  const awards = JSON.parse(fs.readFileSync(PUBLIC_AWARDS, 'utf8'));
  const showsJson = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = Array.isArray(showsJson) ? showsJson : (showsJson.shows || []);
  const titleById = {};
  for (const sh of showsArr) {
    if (sh.id && sh.title) titleById[sh.id] = sh.title;
  }
  const awardsShows = awards.shows || awards;

  // Snapshot tony.eligible and tony.note BEFORE enrichment so they survive a full-file
  // rewrite started from a stale base. These are human-curated fields (Tony Administration
  // Committee rulings) that no automated script should remove. Pattern mirrors the
  // spread-merge protection added to scrape-tony-awards.js in Sprint 1 (commit 2ccdaf6e).
  const eligibilitySnapshot = new Map();
  for (const [showId, sh] of Object.entries(awardsShows)) {
    const t = sh.tony;
    if (!t) continue;
    const snap = {};
    if (t.eligible !== undefined) snap.eligible = t.eligible;
    if (t.note !== undefined) snap.note = t.note;
    if (Object.keys(snap).length > 0) eligibilitySnapshot.set(showId, snap);
  }

  // Broadway shows from shows.json bucketed by Tony season (PREDICTIONS_ERA only).
  // Used by matcher pass 4 to attribute DD/OCC/DL/Pulitzer noms to non-Tony-nominated
  // Broadway shows that aren't currently in awards.json. Year-gated by source year
  // so a DD 2015 entry only matches Broadway shows opened in 2014-15 season.
  const broadwayShowsBySeason = new Map();
  for (const s of showsArr) {
    if (!s || !s.id || !s.title || s.category !== 'broadway') continue;
    const season = seasonForOpeningDate(s.openingDate || s.previewsStartDate);
    if (!season) continue;
    if (!broadwayShowsBySeason.has(season)) broadwayShowsBySeason.set(season, []);
    broadwayShowsBySeason.get(season).push(s);
  }

  // OB/OWE/WE shows bucketed by season — used by matcher Pass 5 to attribute
  // Lortel, Obie, Drama Desk OB, Critics' Circle, and Evening Standard noms
  // to off-broadway / off-west-end / west-end shows not yet in awards.json.
  // Olivier has its own ingestion path (scripts/enrich-olivier-awards.js)
  // and does not flow through Pass 5. Same year-gate as Pass 4. West End
  // added 2026-05-20 after Critics' Circle Best Actress 2026 (Inter Alia)
  // failed to match because Pass 5 excluded west-end category.
  // CAVEAT: bucket uses Tony season (May 1 – April 30). A WE show opening
  // 1–31 May could theoretically land in the wrong season bucket relative
  // to Olivier-season cutoffs, but Olivier doesn't flow through here, and
  // CC/ES ceremonies align with calendar-year UK output in practice.
  const obShowsBySeason = new Map();
  for (const s of showsArr) {
    if (!s || !s.id || !s.title) continue;
    if (s.category !== 'off-broadway' && s.category !== 'off-west-end' && s.category !== 'west-end') continue;
    const season = seasonForOpeningDate(s.openingDate || s.previewsStartDate);
    if (!season) continue;
    if (!obShowsBySeason.has(season)) obShowsBySeason.set(season, []);
    obShowsBySeason.get(season).push(s);
  }

  const createdEntries = [];
  const createdOBEntries = [];
  const backfilledTony = [];
  const matcherOpts = {
    broadwayShowsBySeason,
    obShowsBySeason,
    onCreate: (id) => createdEntries.push(id),
    onCreateOB: (id) => createdOBEntries.push(id),
    onBackfillTony: (id) => backfilledTony.push(id),
  };

  // 1) Migrate Pulitzer schema for ALL shows (idempotent)
  let migrated = 0;
  for (const [showId, sh] of Object.entries(awardsShows)) {
    if (!sh.pulitzer) continue;
    const before = JSON.stringify(sh.pulitzer);
    migratePulitzer(sh);
    if (JSON.stringify(sh.pulitzer) !== before) migrated++;
  }
  console.log(`Pulitzer schema migrated for ${migrated} shows (legacy → canonical)`);

  // 2) Apply each precursor source
  const ddRes = applyDDOCCDL(DRAMA_DESK, 'dramadesk', awardsShows, titleById, matcherOpts);
  const occRes = applyDDOCCDL(OUTER_CRITICS, 'outerCriticsCircle', awardsShows, titleById, matcherOpts);
  const dlRes = applyDDOCCDL(DRAMA_LEAGUE, 'dramaLeague', awardsShows, titleById, matcherOpts);
  const nydRes = applyNYDCCC(NYDCCC, awardsShows, titleById, matcherOpts);
  const obieRes = applyObie(OBIE, awardsShows, titleById, matcherOpts);
  const lortelRes = applyDDOCCDL(LORTEL, 'lortel', awardsShows, titleById, matcherOpts);
  // OBA ceremony year Y honors productions opening (Y-1)-Y Broadway season —
  // matches ceremonyYearToTonySeason(Y) without a source-year shift. Standard
  // applyDDOCCDL routing through Pass 5 (obShowsBySeason) handles OB-only shows.
  const obaRes = applyDDOCCDL(OBA, 'oba', awardsShows, titleById, matcherOpts);
  const ccRes = applyDDOCCDL(CRITICS_CIRCLE, 'criticsCircle', awardsShows, titleById, matcherOpts);
  const esRes = applyDDOCCDL(EVENING_STANDARD, 'eveningStandard', awardsShows, titleById, matcherOpts);
  const wosRes = applyDDOCCDL(WHATSONSTAGE, 'whatsOnStage', awardsShows, titleById, matcherOpts);
  const pulRes = applyPulitzer(PULITZER, awardsShows, titleById, matcherOpts);
  const histPulRes = applyHistoricPulitzerById(HISTORIC_PULITZER, awardsShows);

  // Collapse synonym-variant categories (e.g. DD/OCC "Direction of a Musical" +
  // "Director of a Musical" — one award scraped twice). Runs AFTER all apply*
  // so it normalizes whatever the scrapers produced this run. See
  // scripts/lib/award-category-canonical.js and feedback_awards_duplicate_categories.
  const canonChanged = canonicalizeAllShows(awardsShows);
  if (canonChanged > 0) console.log(`Canonicalized synonym-variant categories on ${canonChanged} show(s)`);

  console.log('\nMatch stats:');
  console.log(`  Drama Desk:           ${ddRes.matched} matched, ${ddRes.unmatched.length} unmatched (mostly OB shows not in awards.json)`);
  console.log(`  Outer Critics:        ${occRes.matched} matched, ${occRes.unmatched.length} unmatched`);
  console.log(`  Drama League:         ${dlRes.matched} matched, ${dlRes.unmatched.length} unmatched`);
  console.log(`  NY Drama Critics:     ${nydRes.matched} matched, ${nydRes.unmatched.length} unmatched`);
  console.log(`  Obie Awards:          ${obieRes.matched} matched, ${obieRes.unmatched.length} unmatched`);
  console.log(`  Lortel Awards:        ${lortelRes.matched} matched, ${lortelRes.unmatched.length} unmatched`);
  console.log(`  OBA Awards:           ${obaRes.matched} matched, ${obaRes.unmatched.length} unmatched`);
  console.log(`  Critics' Circle:      ${ccRes.matched} matched, ${ccRes.unmatched.length} unmatched`);
  console.log(`  Evening Standard:     ${esRes.matched} matched, ${esRes.unmatched.length} unmatched`);
  console.log(`  WhatsOnStage:         ${wosRes.matched} matched, ${wosRes.unmatched.length} unmatched`);
  console.log(`  Pulitzer Drama:       ${pulRes.matched} matched, ${pulRes.unmatched.length} unmatched`);
  console.log(`  Pulitzer (historic):  ${histPulRes.matched} matched, ${histPulRes.missing.length} missing showIds`);
  if (histPulRes.missing.length > 0) {
    for (const m of histPulRes.missing) console.log(`    ! ${m}`);
  }
  if (createdEntries.length > 0) {
    console.log(`\nLazy-created ${createdEntries.length} awards.json stub(s) for Broadway shows missing entries:`);
    for (const id of createdEntries) console.log(`  + ${id}`);
  }
  if (createdOBEntries.length > 0) {
    console.log(`\nLazy-created ${createdOBEntries.length} awards.json stub(s) for OB/OWE shows:`);
    for (const id of createdOBEntries) console.log(`  + ${id}`);
  }
  if (backfilledTony.length > 0) {
    console.log(`\nBackfilled tony.season on ${backfilledTony.length} existing entries (had non-Tony awards data only):`);
    for (const id of backfilledTony) console.log(`  ~ ${id}`);
  }

  // 2.5) Restore human-curated tony.eligible and tony.note from snapshot.
  // The enrichment passes above don't touch tony.eligible/note, but a "surgical reset"
  // step (manually deleting stale precursor data before re-enriching) can inadvertently
  // start from a stale awards.json that pre-dates manual eligibility rulings. This pass
  // ensures those rulings survive regardless of the input base.
  let eligibilityRestored = 0;
  for (const [showId, snap] of eligibilitySnapshot) {
    const sh = awardsShows[showId];
    if (!sh || !sh.tony) continue;
    let changed = false;
    if ('eligible' in snap && sh.tony.eligible !== snap.eligible) {
      sh.tony.eligible = snap.eligible;
      changed = true;
    }
    if ('note' in snap && sh.tony.note !== snap.note) {
      sh.tony.note = snap.note;
      changed = true;
    }
    if (changed) eligibilityRestored++;
  }
  if (eligibilityRestored > 0) {
    console.log(`⚠️  Restored tony.eligible/note for ${eligibilityRestored} show(s) that were clobbered by stale input.`);
  }

  // 3) Update _meta
  if (!awards._meta) awards._meta = {};
  awards._meta.lastUpdated = new Date().toISOString();
  const sources = new Set(awards._meta.sources || []);
  sources.add('Wikipedia (Tony, Drama Desk, Outer Critics Circle, Drama League, NY Drama Critics\' Circle, Pulitzer Drama)');
  awards._meta.sources = [...sources];

  // 4) Idempotency self-check: serialize, deserialize, re-apply, deep-equal
  const serialized = JSON.stringify(awards, null, 2);
  if (!DRY_RUN) {
    // Compare against current on-disk to determine if anything changed
    const onDisk = fs.readFileSync(PUBLIC_AWARDS, 'utf8');
    const sameAsDisk = serialized === onDisk;
    console.log(`\nDiff vs on-disk: ${sameAsDisk ? 'IDENTICAL (idempotent on already-enriched data)' : 'CHANGED'}`);
  }

  // 5) Verify idempotency: run a second pass on the just-enriched data and assert no diff
  const second = JSON.parse(serialized);
  const secondShows = second.shows || second;
  let migrated2 = 0;
  for (const sh of Object.values(secondShows)) {
    if (!sh.pulitzer) continue;
    const before = JSON.stringify(sh.pulitzer);
    migratePulitzer(sh);
    if (JSON.stringify(sh.pulitzer) !== before) migrated2++;
  }
  // Idempotency check uses the same matcher opts so pass 4 lookups behave consistently.
  applyDDOCCDL(DRAMA_DESK, 'dramadesk', secondShows, titleById, matcherOpts);
  applyDDOCCDL(OUTER_CRITICS, 'outerCriticsCircle', secondShows, titleById, matcherOpts);
  applyDDOCCDL(DRAMA_LEAGUE, 'dramaLeague', secondShows, titleById, matcherOpts);
  applyNYDCCC(NYDCCC, secondShows, titleById, matcherOpts);
  applyObie(OBIE, secondShows, titleById, matcherOpts);
  applyDDOCCDL(LORTEL, 'lortel', secondShows, titleById, matcherOpts);
  applyDDOCCDL(OBA, 'oba', secondShows, titleById, matcherOpts);
  applyDDOCCDL(CRITICS_CIRCLE, 'criticsCircle', secondShows, titleById, matcherOpts);
  applyDDOCCDL(EVENING_STANDARD, 'eveningStandard', secondShows, titleById, matcherOpts);
  applyDDOCCDL(WHATSONSTAGE, 'whatsOnStage', secondShows, titleById, matcherOpts);
  applyPulitzer(PULITZER, secondShows, titleById, matcherOpts);
  applyHistoricPulitzerById(HISTORIC_PULITZER, secondShows);
  canonicalizeAllShows(secondShows);
  // Don't update _meta on second pass (timestamp would diverge); strip before compare
  const firstNoMeta = JSON.parse(serialized);
  delete firstNoMeta._meta;
  delete second._meta;
  const firstStr = JSON.stringify(firstNoMeta);
  const secondStr = JSON.stringify(second);
  if (firstStr !== secondStr) {
    console.error('\n✗ IDEMPOTENCY ASSERTION FAILED — second pass diverged from first');
    process.exit(1);
  }
  console.log(`✓ Idempotency assertion passed (Pulitzer migrate-stable: ${migrated2 === 0})`);

  // 6) Schema validation — throws if any precursor entry violates the shape
  //    (Pre-mortem PRIMARY mitigation from 6-reviewer plan-review 2026-05-01).
  try {
    validateAwardsObject(awards);
    console.log('✓ JSON Schema validation passed (all precursor entries well-formed)');
  } catch (e) {
    console.error('\n✗ JSON Schema validation FAILED:');
    console.error(e.message);
    process.exit(1);
  }

  // 6b) Synonym-duplicate guard — no ceremony node may list two name variants of
  //     the same award (the forum-reported double-count/double-display bug).
  const synonymDupes = findSynonymDuplicates(awards.shows || awards);
  if (synonymDupes.length > 0) {
    console.error(`\n✗ Synonym-duplicate categories survived canonicalization (${synonymDupes.length}):`);
    console.error(JSON.stringify(synonymDupes.slice(0, 10), null, 2));
    process.exit(1);
  }
  console.log('✓ No synonym-duplicate categories');

  // 7) Atomic dual-repo write — public + private succeed together or both
  //    roll back. Prevents silent drift on partial failure (Codex P1).
  if (!DRY_RUN) {
    if (fs.existsSync(PRIVATE_AWARDS)) {
      const r = writeAwardsJsonAtomic(awards, { publicPath: PUBLIC_AWARDS, privatePath: PRIVATE_AWARDS });
      console.log(`Wrote ${PUBLIC_AWARDS} (${r.publicBytes} bytes)`);
      console.log(`Wrote ${PRIVATE_AWARDS} (${r.privateBytes} bytes, byte-identical)`);
    } else {
      fs.writeFileSync(PUBLIC_AWARDS, serialized);
      console.log(`Wrote ${PUBLIC_AWARDS}`);
      console.log(`(skipped private repo write — ${PRIVATE_AWARDS} not found)`);
    }
  }
}

main();
