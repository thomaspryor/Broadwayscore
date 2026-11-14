#!/usr/bin/env node
/**
 * promote-ob-historical.js
 *
 * Promote Playbill-validated OB historical candidates into shows.json with
 * proper closed-show metadata. Different write-path from
 * scripts/promote-ob-venue-candidates.js, which assumes a provisional stub
 * (status:'announced', openingDate:null) for current-season discoveries.
 *
 * Historical shows have known dates from Playbill, so we write:
 *   status: 'closed'
 *   openingDate: <Playbill firstPreview if no openingDate else openingDate>
 *   closingDate: <Playbill closingDate>
 *   venue: <Playbill venue, as parsed — no lossy canonicalization>
 *
 * Input: data/audit/venue-date-mismatches.json — only results with
 *   result==='match' AND playbillUrl + parsed.dates present.
 *
 * Usage:
 *   node scripts/promote-ob-historical.js --dry-run   (default)
 *   node scripts/promote-ob-historical.js --apply     (writes shows.json)
 *
 * Skip rule: if normalizeTitle(title) matches AND venuesMatch(venue) against
 * an existing shows.json entry, skip (dedup against cross-source entries).
 * venuesMatch (deduplication.js), not title-match.js's canonicalVenue() —
 * see findExactDuplicate below for why (BRO-243).
 */

'use strict';

const { knownShowType } = require('./lib/title-says-musical');
const { normalizeTitle } = require('./lib/title-match');
// A retired id must not be re-minted (BRO-5557: promote-ob-venue-candidates re-added one).
const { matchesRetired } = require('./lib/retired-show-ids');
const fs = require('fs');
const path = require('path');
const { duplicateOfCandidate } = require('./lib/shows-duplicate-rule');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
// Cousin fix of scripts/promote-ob-venue-candidates.js (task: subtitle-variant
// dedup gap, 2026-08-04). title-match.js's normalizeTitle does NOT strip
// colon/dash subtitles ("Ectoplasm" vs "Ectoplasm: Spit and Vigor" produce
// different keys here), so this script's exact title+venue key can miss a
// same-venue subtitle variant entirely -- worse than the jaccard fallback the
// venue-candidates script had, since there's no fallback at all here.
// isSubtitleVariantOf (shared with promote-ob-venue-candidates.js, extracted
// 2026-08-05) strips the subtitle and applies the both-subtitled-but-differ
// carve-out (Angels in America: Millennium Approaches vs : Perestroika shape)
// so two genuinely distinct works sharing a base title at the same venue
// aren't silently collapsed. buildVenueTitlePool/findExactDuplicate/
// findSubtitleDuplicateTitle (extracted BRO-243, shared with
// promote-historical-we.js — see that file's identical dedup pattern) wrap
// both of these plus venuesMatch().
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./lib/venue-title-dedup-pool');
const { sanitizeVenueForWrite, venueSlug } = require('./lib/venue-classification');
const { isDistinctTransfer } = require('./lib/theatermania-ob');
const { withMarketSuffix } = require('./lib/market-slug');
const { productionIdYear } = require('./lib/todaytix-dates');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');

const USAGE = `promote-ob-historical.js — Promote Playbill-validated OB historical candidates into shows.json with.

Usage:
  node scripts/promote-ob-historical.js [options]
  node scripts/promote-ob-historical.js --help, -h    print this usage and exit
`;
const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'venue-date-mismatches.json');
const LOG_PATH = path.join(ROOT, 'data', 'audit', 'ob-historical-promotion-log.jsonl');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[''""‘’“”]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// BRO-6506: 'play' used to be the only fallback when the title lacked the
// word "musical", so the BRO-6489 audit found 15 Off-Broadway musicals stored
// as plays (The Connector, Wesley, Kilgallen ...). Order: Playbill's own
// Play/Musical tag-line > the TheaterMania genre (listingGenre, from
// parseTmOffBroadwayRow) > a title that says musical > a title the catalog
// only knows as a musical (still flagged: Peter Pan, Three Sisters and 24
// other titles are both a play and a musical, so those never count) > 'play',
// flagged. Flagged rows are listed in the dry run for a hand check. Callers
// pass the normalized title (the one written). Cf. promote-historical-we.js
// inferShowType.
// Type is required for closed rows (BRO-3716), so it cannot stay null.
function inferObShowType(r, musicalTitles = new Set()) {
  const tag = r?.parsed?.tagLine?.showType;
  if (tag === 'musical' || tag === 'play') return { type: tag, guessed: false };
  const fromGenre = knownShowType(r?.title, r?.listingGenre);
  if (fromGenre) return { type: fromGenre, guessed: false };
  // TM genres are discrete names: an explicit "Play" counts even beside
  // "Comedy", which knownShowType reads as no type.
  if (/(?:^|;\s*)play(?:\s*;|$)/i.test(r?.listingGenre || '')) return { type: 'play', guessed: false };
  // The catalog only speaks when the source gave no genre at all.
  if (!r?.listingGenre && musicalTitles.has(normalizeTitle(r?.title || ''))) return { type: 'musical', guessed: true };
  return { type: 'play', guessed: true };
}

/** Normalized titles every catalog row of which is a musical. */
function onlyMusicalTitles(shows) {
  const types = new Map();
  for (const s of shows) {
    const k = normalizeTitle(s.title || '');
    if (!types.has(k)) types.set(k, new Set());
    types.get(k).add(s.type);
  }
  return new Set([...types].filter(([, t]) => t.size === 1 && t.has('musical')).map(([k]) => k));
}

function buildShowEntry(r, venueVocabulary, musicalTitles = new Set()) {
  // BRO-3863 — normalise BEFORE the slug/id are derived from the title.
  // Aggregator listings disambiguate same-title productions by appending the
  // venue ("The Cherry Orchard (Park Avenue Armory)"); taken verbatim, that
  // suffix reaches the reader AND the row's slug and id. Same canonical
  // normaliser the validate-data.js gate and fix-show-titles.js use, so a row
  // written here can never fail the gate that guards it.
  const normalizedTitle = normalizeShowTitle({ title: r.title, venue: r.venue }, { venueVocabulary }).title;
  const titleSlug = slugify(normalizedTitle);

  // BRO-2026: the production's own dates decide the id year (same helper and
  // opening → previews precedence as discover-new-shows.js); the title's
  // parsed year is next, and only then the run-date year, flagged provisional.
  const opening = r.parsed?.dates?.openingDate || r.parsed?.dates?.firstPreview || null;
  const datedYear = productionIdYear({
    openingDate: r.parsed?.dates?.openingDate,
    previewsStartDate: r.parsed?.dates?.firstPreview,
  }) || (/^\d{4}$/.test(String(r.parsed?.titleParse?.year)) ? String(r.parsed.titleParse.year) : null);
  // A row admitted on a closing date alone (see main()) is closed: its closing
  // year is a far better guess than the run year, but still provisional.
  const closingYear = /^(\d{4})-/.exec(String(r.parsed?.dates?.closingDate || ''))?.[1] || null;
  const year = datedYear || closingYear || String(new Date().getFullYear());
  // withMarketSuffix() is idempotent -- guards against the same doubled-suffix
  // class as BRO-3237 if titleSlug already carries "-off-broadway".
  const id = `${withMarketSuffix(titleSlug, 'off-broadway')}-${year}`;
  const closing = r.parsed?.dates?.closingDate || null;
  return {
    id,
    ...(datedYear ? {} : { idYearProvisional: true }),
    title: normalizedTitle,
    // validate-data.js requires OB slugs to contain "off-broadway". Use the
    // full id so the slug is unique even across cross-year revivals.
    slug: id,
    // sanitizeVenueForWrite (card #994) refuses a placeholder/neighbourhood-
    // blob venue string, returning null — main()'s promotion loop must skip
    // a null-venue entry rather than write it (card #1922, cousin of #1921).
    // Sanitize each source BEFORE falling back, not after: sanitizing the
    // combined `titleParse.venue || r.venue` would let a placeholder
    // titleParse.venue (e.g. "TBA") suppress a genuinely valid r.venue,
    // losing an otherwise-promotable candidate (ship-check adversarial
    // review finding, 2026-08-26).
    venue: sanitizeVenueForWrite(r.parsed?.titleParse?.venue) || sanitizeVenueForWrite(r.venue),
    openingDate: opening,
    previewsStartDate: r.parsed?.dates?.firstPreview || null,
    closingDate: closing,
    status: 'closed',
    category: 'off-broadway',
    market: 'broadway',
    // Never null (inferObShowType falls back to a flagged 'play') — off-broadway
    // is gated by validate-market-expansion.js's required-fields check,
    // which only exempts type when status==='announced'; 'closed' is not
    // exempt. Same fix, same reasoning, as the aggregator-roundup builders
    // in promote-we-aggregator-candidates.js / promote-ob-venue-candidates.js
    // (BRO-3716 — a null type here would reproduce that exact CI-red
    // incident the next time this script runs).
    type: inferObShowType({ ...r, title: normalizedTitle }, musicalTitles).type,
    discoverySource: 'historical-backfill',
    discoveredAt: new Date().toISOString(),
    playbillUrl: r.playbillUrl || null,
  };
}

function logEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

/**
 * BRO-6153: the promotion selection, shared with plan-ob-historical-cohort.js.
 * Takes validate-show-venue results (result === 'match', with parsed dates)
 * and the current shows, returns the entries to add and the skipped ones with
 * reasons. Pure apart from the optional onSkipInvalidVenue logger.
 */
function selectPromotable(matches, shows, { onSkipInvalidVenue = () => {} } = {}) {
  const existingIds = new Map(shows.map(s => [s.id, s]));
  // Live pool of {title, venue} this run checks candidates against — starts
  // as shows.json and grows as candidates are promoted, so a second
  // candidate for the same show later in this run still gets caught.
  const knownShows = buildVenueTitlePool(shows);
  // BRO-3863 — the gate (validate-data.js) builds the corpus venue vocabulary
  // and this writer must too, or the two disagree: a "(Bridge)" suffix would
  // survive promotion here and then fail validation because some OTHER show's
  // venue is "Bridge". Writer/gate equivalence is the point of routing both
  // through normalizeShowTitle (adversarial review finding).
  const venueVocabulary = buildVenueVocabulary(shows);
  const musicalTitles = onlyMusicalTitles(shows);

  const toPromote = [];
  const skipped = [];
  const typeGuessed = [];
  // new venue-scoped id -> id of the other production it was split from
  const transferOf = new Map();
  for (const r of matches) {
    const entry = buildShowEntry(r, venueVocabulary, musicalTitles);
    // sanitizeVenueForWrite (card #994) returns null for a placeholder/
    // neighbourhood-blob venue — refuse to write a garbage venue string
    // rather than silently promoting it (card #1922, cousin of BRO-160/#1921).
    if (!entry.venue) {
      const rawVenue = r.parsed?.titleParse?.venue || r.venue;
      const reason = `venue "${rawVenue}" failed sanitizeVenueForWrite (placeholder/neighbourhood blob)`;
      skipped.push({ entry, reason });
      onSkipInvalidVenue({ kind: 'skip-invalid-venue', title: entry.title, venue: rawVenue, reason });
      continue;
    }
    const exactDup = findExactDuplicate(knownShows, entry.title, entry.venue);
    const subtitleDup = !exactDup && findSubtitleDuplicateTitle(knownShows, entry.title, entry.venue);
    if (exactDup) { skipped.push({ entry, reason: 'duplicate title+venue' }); continue; }
    if (subtitleDup) { skipped.push({ entry, reason: `subtitle-stripped duplicate of "${subtitleDup}"` }); continue; }
    // BRO-6254: a same-title transfer in the same year (Prince Faggot,
    // Playwrights Horizons then Studio Seaview, 2025) mints the id the other
    // run holds. When the holder is another production (isDistinctTransfer),
    // put the venue in the id, the shape the catalog already uses for this
    // (kramerfauci-st-anns-off-broadway-2026). Playbill's "Org/Space" venues
    // name the house by its first part.
    if (existingIds.has(entry.id) && isDistinctTransfer(entry, existingIds.get(entry.id))) {
      const vs = venueSlug(entry.venue.split('/')[0]);
      const venueId = vs && entry.id.replace(/-off-broadway-(\d{4})$/, `-${vs}-off-broadway-$1`);
      if (venueId && venueId !== entry.id) { transferOf.set(venueId, entry.id); entry.id = venueId; entry.slug = venueId; }
    }
    // venue-write-guard-ok: read-only probe of the retired registry, nothing is written to a venue field
    const retiredHit = matchesRetired({ id: entry.id, title: entry.title, venue: entry.venue });
    if (retiredHit) { skipped.push({ entry, reason: `matches retired ${retiredHit.id} by ${retiredHit.matchedBy}` }); continue; }
    if (existingIds.has(entry.id)) { skipped.push({ entry, reason: 'duplicate id' }); continue; }
    if (!entry.openingDate && !entry.closingDate) { skipped.push({ entry, reason: 'no opening or closing date from Playbill' }); continue; }
    const duplicate = duplicateOfCandidate([...shows, ...toPromote], entry);
    if (duplicate) { skipped.push({ entry, reason: `exists as ${duplicate.existing.id}` }); continue; }
    toPromote.push(entry);
    if (inferObShowType({ ...r, title: entry.title }, musicalTitles).guessed) typeGuessed.push(entry.id);
    knownShows.push({ title: entry.title, venue: entry.venue });
    existingIds.set(entry.id, entry);
  }
  return { toPromote, skipped, transferOf, typeGuessed };
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  const matches = (audit.results || []).filter(r => r.result === 'match' && r.playbillUrl);
  console.log(`Audit has ${audit.results?.length || 0} results; ${matches.length} promotable matches.`);

  const showsData = loadShows();
  const { toPromote, skipped, typeGuessed } = selectPromotable(matches, showsData.shows, { onSkipInvalidVenue: logEntry });

  console.log('');
  console.log(`Will promote: ${toPromote.length}`);
  for (const e of toPromote) {
    console.log(`  + ${e.id} | ${e.title} | ${e.venue} | ${e.openingDate || '(no opening)'} → ${e.closingDate || '(no closing)'}`);
  }
  if (skipped.length) {
    console.log(`Skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`  - ${s.entry.title} (${s.reason})`);
  }
  if (typeGuessed.length) {
    console.log(`Type guessed as 'play' (no Playbill tag, genre or title signal; check by hand): ${typeGuessed.length}`);
    for (const id of typeGuessed) console.log(`  ? ${id}`);
  }

  if (!apply) {
    console.log('');
    console.log('[DRY RUN — pass --apply to write shows.json]');
    return;
  }

  if (toPromote.length === 0) {
    console.log('Nothing to promote.');
    return;
  }

  for (const entry of toPromote) {
    showsData.shows.push(entry);
    logEntry({ kind: 'promote-historical', id: entry.id, title: entry.title, venue: entry.venue });
  }
  try {
    const r = saveShows(showsData);
    console.log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildShowEntry, selectPromotable, inferObShowType, onlyMusicalTitles };
