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

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { normalizeTitle } = require('./lib/title-match');
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
// aren't silently collapsed.
const { isSubtitleVariantOf, venuesMatch } = require('./lib/deduplication');

const { hasHelpFlag } = require('./lib/cli-help.js');

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

function buildShowEntry(r) {
  const titleSlug = slugify(r.title);
  const year = String((r.parsed?.titleParse?.year) || new Date().getFullYear());
  const id = `${titleSlug}-off-broadway-${year}`;
  const opening = r.parsed?.dates?.openingDate || r.parsed?.dates?.firstPreview || null;
  const closing = r.parsed?.dates?.closingDate || null;
  return {
    id,
    title: r.title,
    // validate-data.js requires OB slugs to contain "off-broadway". Use the
    // full id so the slug is unique even across cross-year revivals.
    slug: id,
    venue: r.parsed?.titleParse?.venue || r.venue,
    openingDate: opening,
    previewsStartDate: r.parsed?.dates?.firstPreview || null,
    closingDate: closing,
    status: 'closed',
    category: 'off-broadway',
    market: 'broadway',
    type: null,
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

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  const matches = (audit.results || []).filter(r => r.result === 'match' && r.playbillUrl);
  console.log(`Audit has ${audit.results?.length || 0} results; ${matches.length} promotable matches.`);

  const showsData = loadShows();
  const existingIds = new Set(showsData.shows.map(s => s.id));
  // Live pool of {title, venue} this run checks candidates against — starts
  // as shows.json and grows as candidates are promoted, so a second
  // candidate for the same show later in this run still gets caught. A flat
  // array + venuesMatch() scan (not a canonicalVenue-keyed Set/Map) because
  // title-match.js's canonicalVenue() falls back to the lowercased FIRST
  // WORD for any venue outside VENUE_ALIASES — two unrelated venues sharing
  // a leading word ("The X") would collapse to the same key and silently
  // skip a genuinely new show as a false "duplicate title+venue" (BRO-243).
  const knownShows = showsData.shows.filter(s => s.title && s.venue);

  function findExactDuplicate(candidateTitle, venue) {
    const norm = normalizeTitle(candidateTitle);
    return knownShows.find(s => normalizeTitle(s.title) === norm && venuesMatch(s.venue, venue)) || null;
  }

  function findSubtitleDuplicateTitle(candidateTitle, venue) {
    for (const s of knownShows) {
      if (venuesMatch(s.venue, venue) && isSubtitleVariantOf(candidateTitle, s.title)) return s.title;
    }
    return null;
  }

  const toPromote = [];
  const skipped = [];
  for (const r of matches) {
    const entry = buildShowEntry(r);
    const exactDup = findExactDuplicate(entry.title, entry.venue);
    const subtitleDup = !exactDup && findSubtitleDuplicateTitle(entry.title, entry.venue);
    if (exactDup) { skipped.push({ entry, reason: 'duplicate title+venue' }); continue; }
    if (subtitleDup) { skipped.push({ entry, reason: `subtitle-stripped duplicate of "${subtitleDup}"` }); continue; }
    if (existingIds.has(entry.id)) { skipped.push({ entry, reason: 'duplicate id' }); continue; }
    if (!entry.openingDate && !entry.closingDate) { skipped.push({ entry, reason: 'no opening or closing date from Playbill' }); continue; }
    toPromote.push(entry);
    knownShows.push({ title: entry.title, venue: entry.venue });
    existingIds.add(entry.id);
  }

  console.log('');
  console.log(`Will promote: ${toPromote.length}`);
  for (const e of toPromote) {
    console.log(`  + ${e.id} | ${e.title} | ${e.venue} | ${e.openingDate || '(no opening)'} → ${e.closingDate || '(no closing)'}`);
  }
  if (skipped.length) {
    console.log(`Skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`  - ${s.entry.title} (${s.reason})`);
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

main();
