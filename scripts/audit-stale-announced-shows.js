#!/usr/bin/env node
/**
 * audit-stale-announced-shows.js
 *
 * Flags shows stuck in status='announced' whose run has demonstrably already
 * started or finished — the same class of bug as the previews/upcoming stuck-
 * status detector in scripts/lib/opening-signal.js, but for the 'announced'
 * status specifically.
 *
 * Why this exists (sherlock-holmes-west-end-2026, 2026-07):
 *   openSignalFromReviews() in opening-signal.js only watches
 *   PRE_OPEN_STATUSES = {'previews', 'upcoming'} — a show that never got a
 *   previews/upcoming stamp and sits directly in 'announced' with a null
 *   openingDate has no flip path at all. Sherlock Holmes WE ran and closed
 *   (2026-05-02 to 2026-06-06 at Regent's Park Open Air Theatre) entirely
 *   while status stayed 'announced', so the review-driven backstop never
 *   looked at it and its score never published.
 *
 * This script does NOT auto-flip status (an 'announced' show can legitimately
 * be pre-sale/unconfirmed and previewsStartDate can slip) — it flags for
 * human/pipeline follow-up. Two independent signals, either fires:
 *   - previewsStartDate is set and > STALE_DAYS in the past
 *   - data/review-texts/{id}/ exists and contains at least one file
 *
 * Usage:
 *   node scripts/audit-stale-announced-shows.js
 *   node scripts/audit-stale-announced-shows.js --stale-days=30
 *   node scripts/audit-stale-announced-shows.js --fail-on-gap
 *
 * Output: data/audit/stale-announced-shows.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_FILE = path.join(DATA_DIR, 'audit', 'stale-announced-shows.json');

const argv = process.argv.slice(2);
const STALE_DAYS = parseInt((argv.find(a => a.startsWith('--stale-days=')) || '').replace('--stale-days=', ''), 10) || 30;
const FAIL_ON_GAP = argv.includes('--fail-on-gap');
const DRY_RUN = argv.includes('--dry-run');

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function daysSince(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

function hasPopulatedReviewTextsDir(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  try {
    return fs.readdirSync(dir).some(f => f.endsWith('.json'));
  } catch {
    return false;
  }
}

function main() {
  const showsData = loadJSON(SHOWS_FILE);
  if (!showsData || !Array.isArray(showsData.shows)) {
    console.error(`Could not load ${SHOWS_FILE}`);
    process.exit(1);
  }

  const now = new Date();
  const flagged = [];

  for (const show of showsData.shows) {
    if (show.status !== 'announced') continue;

    const reasons = [];

    const pastDays = show.previewsStartDate ? daysSince(show.previewsStartDate, now) : null;
    if (pastDays !== null && pastDays > STALE_DAYS) {
      reasons.push(`previewsStartDate ${show.previewsStartDate} is ${pastDays}d in the past`);
    }

    const hasReviews = hasPopulatedReviewTextsDir(show.id);
    if (hasReviews) {
      reasons.push('data/review-texts/ has collected review file(s)');
    }

    if (reasons.length > 0) {
      flagged.push({
        id: show.id,
        title: show.title,
        venue: show.venue || null,
        category: show.category || null,
        previewsStartDate: show.previewsStartDate || null,
        openingDate: show.openingDate || null,
        todaytixId: show.todaytixId || null,
        reasons,
      });
    }
  }

  const report = {
    generatedAt: now.toISOString(),
    staleDaysThreshold: STALE_DAYS,
    flaggedCount: flagged.length,
    flagged,
  };

  console.log(`audit-stale-announced-shows: ${flagged.length} stale 'announced' show(s) (stale-days=${STALE_DAYS})`);
  for (const f of flagged) {
    console.log(`  - ${f.id} (${f.title}): ${f.reasons.join('; ')}`);
  }

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2));
    console.log(`Wrote audit: ${AUDIT_FILE}`);
  }

  if (FAIL_ON_GAP && flagged.length > 0) {
    process.exit(1);
  }
}

main();
