#!/usr/bin/env node
'use strict';
/**
 * merge-wet-stars-urls.js
 *
 * WE historical pilot S2: Theatre Record supplies review text but neither the
 * original article URL nor the critic's explicit star rating (plan v2.2,
 * "TR's two hard limits"). This script joins the show's WET roundup
 * (scripts/lib/wet-roundup-discover.js) onto its TR-sourced review-text files
 * by outlet — WET rows carry outlet + critic + stars (+ often a URL) — so a
 * TR text file for a KNOWN_STAR_OUTLET gains an explicit `aggregatorStars`
 * rating and, if missing, a `url`.
 *
 * Writing `aggregatorStars` does NOT rescore the review itself — a review
 * already scored `llm-v6` (unanchored) stays that way until a scoring pass
 * re-reads the file. Follow this script with:
 *   node scripts/flag-late-star-reanchor.js --apply
 *   npx tsx scripts/llm-scoring/index.ts --needs-rescore --rescore-reason=late-star-anchor
 *
 * Usage:
 *   node scripts/merge-wet-stars-urls.js --show=ID [--apply] [--verbose]
 */

const fs = require('fs');
const path = require('path');

const { discoverWetRoundupRows } = require('./lib/wet-roundup-discover');
const { normalizeOutlet, normalizeCritic } = require('./lib/review-normalization');
const { resolveUrlEditionOutletId } = require('./lib/outlet-canonicalize');
const { safeWriteReview } = require('./lib/review-write-guard');
const { KNOWN_STAR_OUTLETS } = require('./lib/score-extractors');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `merge-wet-stars-urls.js — join WET roundup stars/URLs onto a show's TR review-text files by outlet.

Usage:
  node scripts/merge-wet-stars-urls.js --show=ID [options]

Options:
  --apply       Write changes (default: dry run, prints what would change)
  --verbose     Print per-file skip reasons
  --help, -h    print this usage and exit
`;


const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  return Array.isArray(shows) ? shows : Object.values(shows);
}

function starsToRating(stars) {
  const n = Number(stars);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return `${n}/5`;
}

function criticsMatch(a, b) {
  const na = normalizeCritic(a);
  const nb = normalizeCritic(b);
  if (na === 'unknown' || nb === 'unknown') return true;
  if (na === nb) return true;
  // Last-name fallback for minor formatting drift (middle initials, etc.)
  const lastA = na.split(' ').pop();
  const lastB = nb.split(' ').pop();
  return !!lastA && lastA === lastB;
}

/**
 * Match a review-text file's (outletId, criticName) against the show's WET
 * rows. A multi-critic outlet (e.g. "The Times" + "The Sunday Times" both
 * canonicalize to outletId "times-uk") needs the critic name to disambiguate
 * — collapsing by outlet alone silently cross-attaches one critic's star/URL
 * to a different critic's review (caught on Juno and the Paycock: Clive
 * Davis vs Dominic Maxwell, distinct URLs, same outletId).
 *
 * @returns {{row: object, ambiguous: boolean}|null}
 */
function matchWetRow(rowsByOutletId, outletId, criticName) {
  const candidates = rowsByOutletId.get(outletId);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return { row: candidates[0], ambiguous: false };
  const matches = candidates.filter(r => criticsMatch(r.critic, criticName));
  if (matches.length === 1) return { row: matches[0], ambiguous: false };
  // Multiple WET rows for this outlet and none (or more than one) match the
  // critic by name — too ambiguous to trust a specific star/URL.
  return { row: null, ambiguous: true };
}

/**
 * Pure merge decision for one review-text file against its matched WET row.
 * Stars only for outlets that print stars (KNOWN_STAR_OUTLETS) — a WET row
 * can carry WET's own summary stars for a no-star outlet. The URL for EVERY
 * matched outlet: TR texts have no URL at all, and gating the URL on star
 * outlets left non-star reviews URL-less (BRO-4851: 13 of 41 pilot reviews).
 * Never overwrites an existing rating or URL.
 * @returns {{patch: object, changes: string[]}}
 */
function planWetMerge(data, wetRow, outletId) {
  const isStarOutlet = KNOWN_STAR_OUTLETS.has(outletId);
  const newRating = isStarOutlet ? starsToRating(wetRow.stars) : null;
  const patch = {};
  const changes = [];
  if (newRating && !data.aggregatorStars && !data.originalRating && !data.originalScore) {
    patch.aggregatorStars = newRating;
    changes.push(`aggregatorStars=${newRating}`);
  }
  // matchWetRow returns a lone row for the outlet without checking the
  // critic; a different critic's URL must not land on this review.
  if (wetRow.url && !data.url && criticsMatch(wetRow.critic, data.criticName)) {
    patch.url = wetRow.url;
    changes.push(`url=${wetRow.url}`);
  }
  return { patch, changes };
}

/**
 * WET roundup publish window for this production: 30 days before the first
 * performance to 60 days after press night (opening, else first preview).
 * Roundups appear within days of press night. Anchoring the end on CLOSING
 * let the 2024 Wyndham's Oedipus (closed 2025-01-04) pick up the Old Vic
 * Oedipus roundup posted in Feb 2025 (BRO-4851). {} when no usable dates.
 */
function roundupWindow(show) {
  const DAY = 86400000;
  const first = Date.parse(show.previewsStartDate || show.openingDate || '');
  if (Number.isNaN(first)) return {};
  const pressNight = Date.parse(show.openingDate || show.previewsStartDate);
  const iso = t => new Date(t).toISOString().slice(0, 10);
  return { after: iso(first - 30 * DAY), before: iso(pressNight + 60 * DAY) };
}

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const apply = args.includes('--apply');
  const verbose = args.includes('--verbose');
  if (!showFilter) {
    console.error('Usage: node scripts/merge-wet-stars-urls.js --show=ID [--apply]');
    process.exit(2);
  }

  const shows = loadShows();
  const show = shows.find(s => s.id === showFilter || s.slug === showFilter);
  if (!show) {
    console.error(`Show not found: ${showFilter}`);
    process.exit(1);
  }

  console.log(`Fetching WET roundup rows for ${show.title} (${show.id})...`);
  let wetResult;
  try {
    wetResult = await discoverWetRoundupRows(show, roundupWindow(show));
  } catch (e) {
    console.error(`WET fetch failed: ${e.message}`);
    process.exit(1);
  }
  if (!wetResult || !Array.isArray(wetResult.rows) || wetResult.rows.length === 0) {
    console.log('No WET roundup rows found — nothing to merge.');
    return;
  }
  console.log(`Found ${wetResult.rows.length} WET row(s) from ${wetResult.post?.link || '(unknown post)'}`);

  // Index WET rows by canonical outletId (a list, not a single row — outlets
  // like times-uk cover both "The Times" and "The Sunday Times" as distinct
  // WET rows with distinct critics, URLs, and stars).
  // Keyed by the URL-edition outlet so a "Time Out" row with a
  // timeout.com/london URL matches the timeout-london file, not "timeout".
  const wetByOutletId = new Map();
  for (const row of wetResult.rows) {
    const outletId = resolveUrlEditionOutletId({ outletName: row.outlet, url: row.url }).outletId;
    if (!wetByOutletId.has(outletId)) wetByOutletId.set(outletId, []);
    wetByOutletId.get(outletId).push(row);
  }

  const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
  if (!fs.existsSync(showDir)) {
    console.log(`No review-texts directory for ${show.id} — nothing to merge.`);
    return;
  }

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  let merged = 0;
  let skipped = 0;

  for (const filename of files) {
    const filepath = path.join(showDir, filename);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
      if (verbose) console.log(`  ${filename}: unreadable (${e.message})`);
      continue;
    }

    const outletId = data.outletId || normalizeOutlet(data.outlet);
    const match = matchWetRow(wetByOutletId, outletId, data.criticName);
    if (!match) {
      if (verbose) console.log(`  ${filename}: no WET row for outlet "${outletId}"`);
      skipped++;
      continue;
    }
    if (match.ambiguous) {
      console.log(`  ${filename}: SKIPPED — multiple WET rows for outlet "${outletId}", none match critic "${data.criticName}"`);
      skipped++;
      continue;
    }
    const wetRow = match.row;

    const { patch, changes } = planWetMerge(data, wetRow, outletId);
    if (!changes.length) {
      if (verbose) console.log(`  ${filename}: already has rating/url (or no-star outlet with no URL) — nothing to add`);
      skipped++;
      continue;
    }

    console.log(`  ${filename}: ${apply ? 'MERGED' : 'would merge'} ${changes.join(', ')}`);
    merged++;

    if (apply) {
      safeWriteReview(filepath, { ...data, ...patch });
    }
  }

  console.log('');
  console.log(`${apply ? 'Merged' : 'Would merge'} ${merged} file(s), skipped ${skipped}.`);
  if (!apply) console.log('(dry run — pass --apply to write changes)');
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(2); });
}

module.exports = { planWetMerge, matchWetRow, starsToRating, roundupWindow };
