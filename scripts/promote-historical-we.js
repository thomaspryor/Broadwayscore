#!/usr/bin/env node
/**
 * promote-historical-we.js
 *
 * WE historical backfill, promotion (BRO-4851, plan v3.1:
 * docs/specs/west-end-historical-backfill-v3.md). Reads
 * data/audit/we-historical-candidates-<season>.json (written by
 * discover-historical-shows-we.js) and writes the promotable rows into
 * shows.json as closed historical West End productions.
 *
 * Promotable = the candidate's decideWeHistoricalPromotion() verdict, unless
 * data/audit/we-historical-approvals.json overrides it for that season+title:
 *   { "2024-2025": { "Ballet Shoes": { "decision": "approve", "reason": "NT play WOS tagged as dance" } } }
 * An "approve" still needs a West End venue and a start + closing date: an
 * approval can overrule judgement calls (genre, missing review signal), not
 * missing facts.
 *
 * Rows are written WITHOUT `provisional`: the dated WOS listing is the
 * validation (same rule as "the roundup IS the validation" for roundup-
 * promoted rows, validate-show-venue.js isExemptFromPlaybillCheck), and a
 * provisional row would join the paid daily Playbill sweep, which has no
 * pages for UK-only productions. No `todaytixId` is ever written, so
 * update-show-status.js can never reopen an old production.
 *
 * Usage:
 *   node scripts/promote-historical-we.js --season=2024-2025                 dry run (default)
 *   node scripts/promote-historical-we.js --season=2024-2025 --apply
 *   node scripts/promote-historical-we.js --season=2024-2025 --only="Kyoto" --only="Unicorn" --apply
 *   node scripts/promote-historical-we.js --season=2024-2025 --revert [--apply]
 *     Removes rows this script promoted for the season that have no reviews
 *     yet (no data/review-texts/<id>/ dir and no reviews.json rows). Undo for
 *     a bad promotion caught before review gathering; after reviews land,
 *     fix forward instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { titleSaysMusical } = require('./lib/title-says-musical');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./lib/venue-title-dedup-pool');
const { foldDiacritics, normalizeTitle } = require('./lib/title-match');
const { venuesMatch } = require('./lib/deduplication');
const { sanitizeVenueForWrite, isWestEndVenue } = require('./lib/venue-classification');
const { withMarketSuffix } = require('./lib/market-slug');
const { productionIdYear } = require('./lib/todaytix-dates');
const { venueFamily, decideWeHistoricalPromotion } = require('./lib/we-historical-corroboration');
const { candidatesPath } = require('./discover-historical-shows-we');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');

const USAGE = `promote-historical-we.js — Promote West End historical candidates into shows.json.

Usage:
  node scripts/promote-historical-we.js --season=YYYY-YYYY [options]

Options:
  --apply           Write changes (default: dry run)
  --only=<title>    Promote only this candidate title (repeatable)
  --revert          Remove this season's promoted rows that have no reviews yet
  --help, -h        print this usage and exit
`;

// venue-write-guard-ok: the shows.json venue is written through sanitizeVenueForWrite in buildShowEntry; other venue uses are title-normaliser input, the in-memory dedup pool and the audit log.

const ROOT = path.join(__dirname, '..');
const APPROVALS_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-approvals.json');
const LOG_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-promotion-log.jsonl');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const DAY_MS = 86400000;
const DISCOVERY_SOURCE = 'we-historical:wos';

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** "BRACE BRACE" → "Brace Brace". Leaves mixed-case titles alone. */
function fixAllCapsTitle(title) {
  const letters = String(title).replace(/[^A-Za-z]/g, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return title;
  return String(title).toLowerCase().split(/(\s+)/).map((w, i) =>
    (i > 0 && SMALL_WORDS.has(w)) ? w : w.replace(/^([^a-z]*)([a-z])/, (_, p, c) => p + c.toUpperCase())
  ).join('');
}

function slugify(s) {
  return foldDiacritics(String(s || '')).toLowerCase()
    .replace(/['‘’"“”]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Approvals file → effective decision for one candidate.
 * @returns {{promotable: boolean, reason: string}}
 */
function effectiveDecision(candidate, approvals, today = new Date().toISOString().slice(0, 10)) {
  const override = approvals?.[candidate.season]?.[candidate.title];
  const base = candidate.decision || decideWeHistoricalPromotion(candidate);
  if (!override) return base;
  if (override.decision === 'reject') return { promotable: false, reason: `rejected in approvals file: ${override.reason || 'no reason given'}` };
  if (override.decision === 'approve') {
    if (!candidate.venue || !isWestEndVenue(candidate.venue)) return { promotable: false, reason: 'approved, but no West End venue' };
    if (!(candidate.openingDate || candidate.previewsStartDate) || !candidate.closingDate) return { promotable: false, reason: 'approved, but start or closing date missing' };
    // Rows are written status:'closed'; an approval can't close a running show.
    if (candidate.closingDate >= today) return { promotable: false, reason: `approved, but not closed yet (closes ${candidate.closingDate})` };
    return { promotable: true, reason: `approved: ${override.reason || 'no reason given'}` };
  }
  return base;
}

/**
 * Most common existing West End spelling per venue family, so promoted rows
 * say "The Old Vic" / "Royal Court" like the rows already on the site rather
 * than WOS's "Old Vic Theatre" / "Royal Court Theatre". National Theatre
 * stages are left alone (one family, several distinct stages).
 */
function buildVenueSpellings(shows) {
  const counts = new Map();
  for (const s of shows) {
    if (s.market !== 'west-end' || !s.venue) continue;
    const fam = venueFamily(s.venue);
    if (fam === 'national-theatre') continue;
    if (!counts.has(fam)) counts.set(fam, new Map());
    const m = counts.get(fam);
    m.set(s.venue, (m.get(s.venue) || 0) + 1);
  }
  const best = new Map();
  for (const [fam, m] of counts) best.set(fam, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

// WOS leaves genres empty on some listings, and an empty list used to mean
// 'play': 2023-24 stored Sunset Boulevard, Next to Normal, The Witches, Old
// Friends, Just for One Day and The Time Traveller's Wife as plays (BRO-4884).
// Order: hand override (approvals[season][title].type) > WOS genre or a title
// that says musical > a same-titled musical already in shows.json > 'play',
// flagged as guessed so the dry run lists it for the hand check.
function inferShowType(candidate, musicalTitles = new Set()) {
  if (candidate.type === 'musical' || candidate.type === 'play') return { type: candidate.type, guessed: false };
  const genres = candidate.genres || [];
  if (genres.includes('musical') || titleSaysMusical(candidate.title)) return { type: 'musical', guessed: false };
  // Only when WOS gave no genre: an explicit 'play' wins. The 2019 Lyttelton
  // Three Sisters (Inua Ellams' play) went in as a musical because a 1996
  // musical "The Three Sisters" is in shows.json (BRO-4884).
  if (!genres.length && musicalTitles.has(normalizeTitle(candidate.title))) return { type: 'musical', guessed: false };
  return { type: 'play', guessed: !genres.length };
}

function buildShowEntry(candidate, venueVocabulary, venueSpellings = new Map(), musicalTitles = new Set()) {
  // BRO-3863 — normalise BEFORE the slug/id are derived from the title, with
  // the same normaliser the validate-data.js gate uses.
  // Straight apostrophes, matching shows.json ("Mrs Warren's Profession").
  const plainTitle = fixAllCapsTitle(candidate.title).replace(/[\u2018\u2019]/g, "'");
  const normalizedTitle = normalizeShowTitle({ title: plainTitle, venue: candidate.venue }, { venueVocabulary }).title;
  const year = productionIdYear({ openingDate: candidate.openingDate, previewsStartDate: candidate.previewsStartDate });
  if (!year) return null;
  // Historical rows use the full id as the slug (Broadway/OB historical
  // precedent): same-title productions in different years stay distinct.
  const id = `${withMarketSuffix(slugify(normalizedTitle), 'west-end')}-${year}`;
  const evidenceUrls = [candidate.sourceUrls?.wos, candidate.sourceUrls?.wosReview].filter(Boolean);
  return {
    id,
    title: normalizedTitle,
    slug: id,
    venue: sanitizeVenueForWrite(venueSpellings.get(venueFamily(candidate.venue)) || candidate.venue),
    previewsStartDate: candidate.previewsStartDate || null,
    openingDate: candidate.openingDate || null,
    closingDate: candidate.closingDate,
    status: 'closed',
    category: 'west-end',
    market: 'west-end',
    // validate-market-expansion requires a type for non-announced west-end
    // rows (BRO-3716); see inferShowType for the order.
    type: inferShowType(candidate, musicalTitles).type,
    tags: ['historical'],
    season: candidate.season,
    discoverySource: DISCOVERY_SOURCE,
    discoveredAt: new Date().toISOString(),
    ...(candidate.openingDate ? { openingDateSource: 'whatsonstage' } : {}),
    closingDateSource: 'whatsonstage',
    ...(evidenceUrls.length ? { evidenceUrls } : {}),
  };
}

function sameVenue(a, b) {
  return venuesMatch(a, b) || venueFamily(a) === venueFamily(b);
}

/**
 * Pure planning step: candidates + shows.json → {toPromote, skipped}.
 * Re-checks duplicates against the CURRENT shows.json (the candidates file
 * may be days old) with the same date-aware rules discovery used.
 */
function planPromotions({ candidates, shows, approvals, only, today }) {
  const existingIds = new Set(shows.map(s => s.id));
  const pool = buildVenueTitlePool(shows);
  const westEndIds = new Set(shows.filter(s => s.market === 'west-end').map(s => s.id));
  const venueVocabulary = buildVenueVocabulary(shows);
  const venueSpellings = buildVenueSpellings(shows);
  const musicalTitles = new Set(shows.filter(s => s.type === 'musical').map(s => normalizeTitle(s.title)));
  const toPromote = [];
  const typeGuessed = [];
  const skipped = [];
  for (const c of candidates) {
    if (only && only.size && !only.has(c.title)) continue;
    const decision = effectiveDecision(c, approvals, today);
    if (!decision.promotable) { skipped.push({ title: c.title, reason: decision.reason }); continue; }
    // WOS censors some titles ("P*rn Play" is "Porn Play" everywhere else), so
    // review search matches nothing. A censored title needs the real one set as
    // approvals[season][title].title before promotion (BRO-4851).
    const titleOverride = approvals?.[c.season]?.[c.title]?.title;
    const typeOverride = approvals?.[c.season]?.[c.title]?.type;
    const cand = { ...c, ...(titleOverride ? { title: titleOverride } : {}), ...(typeOverride ? { type: typeOverride } : {}) };
    if (/[a-z]\*+[a-z]/i.test(cand.title)) {
      skipped.push({ title: c.title, reason: 'censored title; set the real title as approvals[season][title].title' });
      continue;
    }
    const entry = buildShowEntry(cand, venueVocabulary, venueSpellings, musicalTitles);
    if (!entry) { skipped.push({ title: c.title, reason: 'no usable date for the id year' }); continue; }
    if (!entry.venue) { skipped.push({ title: c.title, reason: `venue "${c.venue}" failed sanitizeVenueForWrite` }); continue; }
    const startDate = entry.openingDate || entry.previewsStartDate;
    const dupOpts = { withinYears: 1, startDate, venueEquals: sameVenue };
    const dup = findExactDuplicate(pool, entry.title, entry.venue, dupOpts)
      || pool.find(s => s.startDate && westEndIds.has(s.id) && normalizeTitle(s.title) === normalizeTitle(entry.title)
        && Math.abs(Date.parse(s.startDate) - Date.parse(startDate)) <= 7 * DAY_MS);
    if (dup) { skipped.push({ title: c.title, reason: `duplicate of ${dup.id || dup.title}` }); continue; }
    const subtitleDup = findSubtitleDuplicateTitle(pool, entry.title, entry.venue, dupOpts);
    if (subtitleDup) { skipped.push({ title: c.title, reason: `subtitle-variant duplicate of "${subtitleDup}"` }); continue; }
    if (existingIds.has(entry.id)) { skipped.push({ title: c.title, reason: `id ${entry.id} already exists` }); continue; }
    toPromote.push(entry);
    if (inferShowType(cand, musicalTitles).guessed) typeGuessed.push(entry.id);
    pool.push({ title: entry.title, venue: entry.venue, startDate, id: entry.id });
    existingIds.add(entry.id);
  }
  return { toPromote, skipped, typeGuessed };
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function logEntry(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
}

function promotedIdsForSeason(season) {
  if (!fs.existsSync(LOG_PATH)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.season !== season) continue;
      if (e.kind === 'promote-historical-we') ids.add(e.id);
      if (e.kind === 'revert-historical-we') ids.delete(e.id);
    } catch { /* skip malformed line */ }
  }
  return ids;
}

function hasAnyReviews(id, reviews) {
  const dir = path.join(REVIEW_TEXTS_DIR, id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'))) return true;
  return reviews.some(r => r.showId === id);
}

function save(showsData, apply) {
  if (!apply) { console.log('\n[DRY RUN — pass --apply to write shows.json]'); return false; }
  try {
    const r = saveShows(showsData);
    console.log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
    return true;
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) { console.error(`::error::${e.message}`); process.exit(1); }
    throw e;
  }
}

function revert(season, apply) {
  const ids = promotedIdsForSeason(season);
  const showsData = loadShows();
  const reviewsJson = readJson(REVIEWS_PATH, []);
  const reviews = Array.isArray(reviewsJson) ? reviewsJson : (reviewsJson.reviews || []);
  const removable = showsData.shows.filter(s => ids.has(s.id) && s.discoverySource === DISCOVERY_SOURCE && !hasAnyReviews(s.id, reviews));
  const kept = [...ids].filter(id => !removable.some(s => s.id === id));
  console.log(`Season ${season}: ${ids.size} promoted by this script; removable (no reviews yet): ${removable.length}`);
  for (const s of removable) console.log(`  - ${s.id}`);
  if (kept.length) console.log(`Kept (has reviews or no longer present): ${kept.join(', ')}`);
  if (!removable.length) return;
  const drop = new Set(removable.map(s => s.id));
  showsData.shows = showsData.shows.filter(s => !drop.has(s.id));
  if (save(showsData, apply)) for (const id of drop) logEntry({ kind: 'revert-historical-we', id, season });
}

function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  const apply = args.includes('--apply');
  const only = new Set(args.filter(a => a.startsWith('--only=')).map(a => a.slice('--only='.length)));
  if (!season) { console.error('Usage: node scripts/promote-historical-we.js --season=YYYY-YYYY [--apply]'); process.exit(2); }
  if (args.includes('--revert')) return revert(season, apply);

  const file = candidatesPath(season);
  if (!fs.existsSync(file)) {
    console.error(`No candidates file at ${path.relative(ROOT, file)} — run discover-historical-shows-we.js --season=${season} first.`);
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  const approvals = readJson(APPROVALS_PATH, {});
  const showsData = loadShows();
  const { toPromote, skipped, typeGuessed } = planPromotions({ candidates: audit.candidates || [], shows: showsData.shows, approvals, only });

  const unknownOnly = [...only].filter(t => !(audit.candidates || []).some(c => c.title === t));
  if (unknownOnly.length) console.log(`--only titles not in the candidates file: ${unknownOnly.join(' | ')}`);
  console.log(`Candidates: ${audit.candidates?.length || 0} (file generated ${audit.generatedAt})`);
  console.log(`Will promote: ${toPromote.length}`);
  for (const e of toPromote) console.log(`  + ${e.id} | ${e.title} | ${e.venue} | ${e.previewsStartDate || '?'} / ${e.openingDate || '?'} → ${e.closingDate}`);
  if (typeGuessed.length) {
    console.log(`Type guessed as 'play' (WOS gave no genre), check each and set approvals[season][title].type = 'musical' where wrong:`);
    for (const id of typeGuessed) console.log(`  ? ${id}`);
  }
  if (only.size || process.argv.includes('--verbose')) {
    for (const s of skipped) console.log(`  - ${s.title}: ${s.reason}`);
  } else {
    console.log(`Skipped: ${skipped.length} (pass --verbose for reasons)`);
  }
  if (!toPromote.length) { console.log('Nothing to promote.'); return; }

  showsData.shows.push(...toPromote);
  if (save(showsData, apply)) {
    for (const e of toPromote) logEntry({ kind: 'promote-historical-we', id: e.id, title: e.title, venue: e.venue, season });
  }
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main();
}

module.exports = { buildShowEntry, buildVenueSpellings, planPromotions, effectiveDecision, fixAllCapsTitle, inferShowType };
