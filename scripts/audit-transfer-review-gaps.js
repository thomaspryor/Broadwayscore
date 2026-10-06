#!/usr/bin/env node
/**
 * audit-transfer-review-gaps.js  (BRO-1361)
 *
 * Detector: Off-Broadway transfer shows sitting at ZERO reviews because their
 * reviews belong to an earlier, undeclared prior run.
 *
 * Why this exists: an OB transfer (small nonprofit/showcase venue -> a
 * commercial house) gets discovered as a brand-new shows.json record (usually
 * via TodayTix). The new record's openingDate is the TRANSFER date, so any
 * reviews from the original run predate it and are either never discovered
 * (no priorRuns window to search) or get excluded as wrongProduction. The
 * show then sits at 0 reviews and reads as "unreviewed" on the site, even
 * though real coverage exists. `dad-dont-read-this-off-broadway-2026` was
 * only caught because a user flagged it (see its priorRuns block in
 * data/shows.json). This script finds OTHER shows in the same shape.
 *
 * This is a STRUCTURAL/no-network detector by default: for each 0-review OB
 * candidate it looks for a same-title SIBLING entry already in shows.json
 * (an earlier run that was discovered/scored as its own separate record
 * instead of being folded into this one via priorRuns) via
 * lib/title-normalization's normalizeTitle. That is the deterministic,
 * no-network signal, and it is narrow: it only catches a transfer whose
 * earlier run already exists as its OWN shows.json record. The motivating
 * case, dad-dont-read-this-off-broadway-2026, has no sibling record (its
 * prior run lives only in the hand-added priorRuns block), so this tier would
 * have classed it needs-manual-check; only --serp or a human catches that shape.
 *
 * `--serp` adds a best-effort SECOND signal: a SERP search for a Playbill/BWW
 * "transfers to" / "returns" announcement naming a prior venue, for
 * candidates with no sibling entry (the harder case — the original run was
 * never in our system at all, e.g. a workshop only covered by a local blog).
 * This degrades gracefully (serpQuery returns null with no SB/BD keys
 * configured; a failed lookup just leaves the candidate needs-manual-check).
 * A SERP hit is surfaced as raw evidence (url + snippet) only — never a
 * structured venue/date suggestion, since "X transfers TO Y" names the
 * DESTINATION venue, which regex extraction can't reliably tell apart from
 * the prior one.
 *
 * This script NEVER writes priorRuns — declaring a prior run is a content
 * decision (confirming it's really the SAME production, not a different
 * revival) that stays with a human. Only the deterministic sibling-entry
 * tier emits a suggested priorRuns block (real venue + dates from an
 * existing shows.json record); the SERP tier never does.
 *
 * Output: data/audit/transfer-review-gaps.json
 *
 * Modes:
 *   (default)          write audit + print console digest
 *   --show=ID           restrict to one show (debugging)
 *   --min-days-open=N   skip shows that opened too recently to have reviews
 *                       yet (default 14 — give the normal pipeline time to
 *                       collect organically before flagging a "gap")
 *   --window-days=N     upper bound on days-since-opening (default 240)
 *   --serp              also attempt the best-effort SERP transfer-
 *                       announcement search for candidates with no sibling
 *   --json              print the audit JSON to stdout only (no file write)
 *   --ci                exit 1 if any high-confidence (sibling-found)
 *                        candidate exists (no baseline diff yet: an accepted
 *                        collision keeps it red)
 *   --serp-limit=N      with --serp, search at most N candidates (default 15)
 *   --dry-run           don't write the audit file
 *   --verbose           log per-candidate detail to stdout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-transfer-review-gaps.js — detect OB transfer shows sitting at 0 reviews (priorRuns candidates).

Usage:
  node scripts/audit-transfer-review-gaps.js
  node scripts/audit-transfer-review-gaps.js --show=some-show-off-broadway-2026
  node scripts/audit-transfer-review-gaps.js --serp --verbose
  node scripts/audit-transfer-review-gaps.js --ci

Modes:
  --show=ID            restrict to one show (debugging)
  --min-days-open=N     minimum days since opening before flagging (default 14)
  --window-days=N       maximum days since opening to still flag (default 240)
  --serp                also attempt a best-effort SERP transfer-announcement search
  --json                print the audit JSON to stdout only
  --ci                  exit 1 if any high-confidence (sibling-found) candidate exists (no baseline diff yet, so an accepted collision keeps it red)
  --serp-limit=N        with --serp, search at most N candidates per run (default 15)
  --dry-run             don't write the audit file
  --verbose             log per-candidate detail
  --help, -h            print this usage and exit

Output: data/audit/transfer-review-gaps.json`;

const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log(USAGE);
  process.exit(0);
}

const { parseDate } = require('./lib/date-utils');
const { normalizeTitle } = require('./lib/title-normalization');
const { sanitizeVenueForWrite } = require('./lib/venue-classification');
const {
  DAY_MS, isEligibleCandidate, findSiblingCandidate, buildSuggestedPriorRun, isPerpetualRepertoryVenue, hasSameVenueSibling,
} = require('./lib/transfer-review-gaps');

const ROOT = path.resolve(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'transfer-review-gaps.json');

const getOpt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const ONLY_SHOW = getOpt('show', null);
const MIN_DAYS_OPEN = parseInt(getOpt('min-days-open', '14'), 10);
const WINDOW_DAYS = parseInt(getOpt('window-days', '240'), 10);
const USE_SERP = argv.includes('--serp');
const SERP_LIMIT = parseInt(getOpt('serp-limit', '15'), 10);
const JSON_ONLY = argv.includes('--json');
const CI_MODE = argv.includes('--ci');
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

function loadReviewCounts() {
  const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const arr = Array.isArray(data) ? data : (data.reviews || []);
  const counts = new Map();
  for (const r of arr) {
    if (!r || !r.showId) continue;
    counts.set(r.showId, (counts.get(r.showId) || 0) + 1);
  }
  return counts;
}

// Best-effort SERP signal for candidates with no sibling entry. Extracts a
// plausible prior-venue name from a Playbill/BWW-style "transfers to" /
// "returns to" sentence. Returns null on any failure (no keys, no results,
// no matching sentence) — never throws, this is a bonus signal only.
async function findSerpSignal(show, { log }) {
  let serpQuery;
  try {
    ({ serpQuery } = require('./lib/url-discovery'));
  } catch (e) {
    log(`  serp: url-discovery unavailable (${e.message})`);
    return null;
  }
  const title = show.title;
  const query = `"${title}" (transfers OR "moves to" OR returns) off-broadway review`;
  let results;
  try {
    results = await serpQuery(query, { nbResults: 5, log });
  } catch (e) {
    log(`  serp: query failed for ${show.id}: ${e.message}`);
    return null;
  }
  if (!results || !results.length) return null;

  // NOTE (ship-check finding): "X transfers TO Y" names Y as the
  // DESTINATION venue, which for an already-open candidate is usually the
  // CURRENT venue, not the prior one — the regex below cannot tell which
  // side of "to/at" it landed on. `possibleVenueMention` is kept as a
  // read-it-yourself hint, never copied into a suggestedPriorRun block —
  // this tier only ever returns evidence (url + snippet), never a
  // paste-ready venue/date suggestion.
  const TRANSFER_RE = /\b(?:transfer(?:s|red|ring)?|moves?|moved|returns?|returned)\b[^.]{0,60}\b(?:to|at)\s+(?:the\s+)?([A-Z][A-Za-z0-9'&.\s]{2,60}?(?:Theat(?:er|re)|Playhouse|Space|Stage|Center|Centre|Club|House))/;
  for (const r of results) {
    const hay = `${r.title || ''} ${r.snippet || ''}`;
    const m = hay.match(TRANSFER_RE);
    if (m) {
      return {
        url: r.url || r.link || null,
        possibleVenueMention: m[1].trim(),
        snippet: (r.snippet || r.title || '').slice(0, 240),
      };
    }
  }
  return null;
}

async function main() {
  const now = new Date();
  const shows = loadShows();
  const reviewCounts = loadReviewCounts();

  const byTitle = new Map();
  for (const s of shows) {
    if (!s || !s.title) continue;
    const key = normalizeTitle(s.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }

  const showList = ONLY_SHOW ? shows.filter((s) => s && s.id === ONLY_SHOW) : shows;
  const opts = { minDaysOpen: MIN_DAYS_OPEN, windowDays: WINDOW_DAYS };
  const log = VERBOSE ? console.log : () => {};

  const candidates = [];
  let serpUsed = 0;
  for (const show of showList) {
    const reviewCount = reviewCounts.get(show.id) || 0;
    const sameTitleShows = byTitle.get(normalizeTitle(show.title)) || [];
    const { eligible, daysSinceOpen } = isEligibleCandidate(show, reviewCount, now, opts, sameTitleShows);
    if (!eligible) continue;

    const sibling = findSiblingCandidate(show, sameTitleShows, reviewCounts);

    let classification;
    let suggestedPriorRun = null;
    let serpSignal = null;

    if (sibling) {
      classification = 'sibling-entry-found';
      suggestedPriorRun = buildSuggestedPriorRun(sibling, reviewCounts);
    } else if (USE_SERP && serpUsed < SERP_LIMIT) {
      serpUsed++;
      // No suggestedPriorRun for this tier — a SERP snippet is unverified
      // evidence (see findSerpSignal's note on venue-side ambiguity), never a
      // paste-ready venue/date block. A human reads serpSignal.snippet and
      // does their own confirmation + dating before touching priorRuns.
      serpSignal = await findSerpSignal(show, { log });
      classification = serpSignal ? 'serp-signal-found' : 'needs-manual-check';
    } else {
      classification = 'needs-manual-check';
    }

    candidates.push({
      showId: show.id,
      title: show.title,
      venue: sanitizeVenueForWrite(show.venue || ''),
      category: show.category,
      status: show.status,
      openingDate: show.openingDate || null,
      previewsStartDate: show.previewsStartDate || null,
      daysSinceOpen,
      classification,
      siblingShowId: sibling ? sibling.id : null,
      serpSignal,
      suggestedPriorRun,
    });
    log(`  ${show.id}: ${classification} (${daysSinceOpen}d since open)`);
  }

  candidates.sort((a, b) => a.daysSinceOpen - b.daysSinceOpen);

  const siblingFound = candidates.filter((c) => c.classification === 'sibling-entry-found');
  const serpSignalFound = candidates.filter((c) => c.classification === 'serp-signal-found');
  const needsManualCheck = candidates.filter((c) => c.classification === 'needs-manual-check');

  const audit = {
    generatedAt: now.toISOString().slice(0, 10),
    params: { minDaysOpen: MIN_DAYS_OPEN, windowDays: WINDOW_DAYS, serpEnabled: USE_SERP },
    summary: {
      totalCandidates: candidates.length,
      siblingFound: siblingFound.length,
      serpSignalFound: serpSignalFound.length,
      needsManualCheck: needsManualCheck.length,
    },
    candidates,
  };

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
  } else {
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      fs.writeFileSync(OUT_PATH, JSON.stringify(audit, null, 2) + '\n');
    }
    console.log(
      `\nOB transfer-review-gap scan — ${candidates.length} candidate(s) at 0 reviews ` +
      `(${siblingFound.length} sibling-found, ${serpSignalFound.length} SERP-signal, ${needsManualCheck.length} needs-manual-check)\n`
    );
    for (const c of candidates.slice(0, 50)) {
      const tag = c.classification === 'sibling-entry-found'
        ? `sibling → ${c.siblingShowId}`
        : c.classification === 'serp-signal-found'
          ? `SERP hit (unverified, read snippet) → ${c.serpSignal.possibleVenueMention || c.serpSignal.url}`
          : 'needs manual check';
      console.log(`${String(c.daysSinceOpen).padStart(4)}d  ${c.showId}`.padEnd(60) + `| ${tag}`);
    }
    if (siblingFound.length) {
      console.log('\nHigh-confidence (sibling entry found) — confirm + add priorRuns:');
      siblingFound.forEach((c) =>
        console.log(`  • ${c.showId} — prior run ${c.siblingShowId} (${c.suggestedPriorRun.venue || 'venue unknown'}, opened ${c.suggestedPriorRun.openingDate || '?'})`));
    }
    if (!DRY_RUN) console.log(`\nWrote ${OUT_PATH}`);
  }

  if (CI_MODE && siblingFound.length) {
    console.error(`\n::warning::${siblingFound.length} OB show(s) appear to be transfers sitting at 0 reviews with a same-title sibling entry already in shows.json: ${siblingFound.map((c) => c.showId).join(', ')}`);
    process.exit(1);
  }
}

module.exports = { isEligibleCandidate, findSiblingCandidate, buildSuggestedPriorRun, isPerpetualRepertoryVenue, hasSameVenueSibling };

if (require.main === module) {
  main().catch((e) => {
    console.error(`::error::audit-transfer-review-gaps.js failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
