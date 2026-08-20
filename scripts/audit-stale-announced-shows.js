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
 * human/pipeline follow-up. Decision logic lives in
 * scripts/lib/stale-announced-audit.js (CLAUDE.md §15) so the test exercises
 * the real predicate.
 *
 * Triage (BRO-93): once a flagged show has actually been looked at — its real
 * previewsStartDate/openingDate corrected in shows.json, or confirmed to have
 * no announced date yet — record that with --ack so it stops reappearing in
 * the report every run. The ack does not change shows.json; it only silences
 * the audit for a show a human has already triaged.
 *
 * Usage:
 *   node scripts/audit-stale-announced-shows.js
 *   node scripts/audit-stale-announced-shows.js --stale-days=30
 *   node scripts/audit-stale-announced-shows.js --fail-on-gap
 *   node scripts/audit-stale-announced-shows.js --ack=<show-id> --ack-note="..."
 *   node scripts/audit-stale-announced-shows.js --unack=<show-id>
 *
 * Output: data/audit/stale-announced-shows.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadAcks,
  addAck,
  saveAcks,
  evaluateAnnouncedShow,
} = require('./lib/stale-announced-audit');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_FILE = path.join(DATA_DIR, 'audit', 'stale-announced-shows.json');

const argv = process.argv.slice(2);
const STALE_DAYS = parseInt((argv.find(a => a.startsWith('--stale-days=')) || '').replace('--stale-days=', ''), 10) || 30;
const FAIL_ON_GAP = argv.includes('--fail-on-gap');
const DRY_RUN = argv.includes('--dry-run');
const ACK_ID = (argv.find(a => a.startsWith('--ack=')) || '').replace('--ack=', '') || null;
const ACK_NOTE = (argv.find(a => a.startsWith('--ack-note=')) || '').replace('--ack-note=', '') || '';
const UNACK_ID = (argv.find(a => a.startsWith('--unack=')) || '').replace('--unack=', '') || null;

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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

  // --ack=<id>: record a triage decision and exit — doesn't run the audit.
  // Requires the id to be a real, currently-'announced' show, so a typo or a
  // not-yet-discovered id can't pre-silence a future real flag.
  if (ACK_ID) {
    if (!ACK_NOTE) {
      console.error('--ack requires --ack-note="<why this show is known-stale>"');
      process.exit(1);
    }
    const show = showsData.shows.find(s => s.id === ACK_ID);
    if (!show) {
      console.error(`--ack=${ACK_ID}: no show with this id in ${SHOWS_FILE}`);
      process.exit(1);
    }
    if (show.status !== 'announced') {
      console.error(`--ack=${ACK_ID}: show status is '${show.status}', not 'announced' — nothing to ack`);
      process.exit(1);
    }
    const acks = addAck(loadAcks(), ACK_ID, ACK_NOTE, new Date().toISOString());
    saveAcks(acks);
    console.log(`Acked ${ACK_ID}: ${ACK_NOTE}`);
    return;
  }

  // --unack=<id>: remove a previously-recorded ack and exit.
  if (UNACK_ID) {
    const acks = loadAcks();
    const remaining = acks.filter(a => a.id !== UNACK_ID);
    if (remaining.length === acks.length) {
      console.error(`--unack=${UNACK_ID}: no ack found for this id`);
      process.exit(1);
    }
    saveAcks(remaining);
    console.log(`Unacked ${UNACK_ID}`);
    return;
  }

  // --ack=<id>: record a triage decision and exit — doesn't run the audit.
  // Requires the id to be a real, currently-'announced' show, so a typo or a
  // not-yet-discovered id can't pre-silence a future real flag.
  if (ACK_ID) {
    if (!ACK_NOTE) {
      console.error('--ack requires --ack-note="<why this show is known-stale>"');
      process.exit(1);
    }
    const show = showsData.shows.find(s => s.id === ACK_ID);
    if (!show) {
      console.error(`--ack=${ACK_ID}: no show with this id in ${SHOWS_FILE}`);
      process.exit(1);
    }
    if (show.status !== 'announced') {
      console.error(`--ack=${ACK_ID}: show status is '${show.status}', not 'announced' — nothing to ack`);
      process.exit(1);
    }
    const acks = addAck(loadAcks(), ACK_ID, ACK_NOTE, new Date().toISOString());
    saveAcks(acks);
    console.log(`Acked ${ACK_ID}: ${ACK_NOTE}`);
    return;
  }

  // --unack=<id>: remove a previously-recorded ack and exit.
  if (UNACK_ID) {
    const acks = loadAcks();
    const remaining = acks.filter(a => a.id !== UNACK_ID);
    if (remaining.length === acks.length) {
      console.error(`--unack=${UNACK_ID}: no ack found for this id`);
      process.exit(1);
    }
    saveAcks(remaining);
    console.log(`Unacked ${UNACK_ID}`);
    return;
  }

  const now = new Date();
  const acks = loadAcks();
  const flagged = [];

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.log(`  ⚠️  ${REVIEW_TEXTS_DIR} not found — review-texts signal is disabled in this environment (private repo not checked out); only date-based signals will fire`);
  }

  for (const show of showsData.shows) {
    if (show.status !== 'announced') continue;

    const reasons = evaluateAnnouncedShow(show, {
      now,
      staleDays: STALE_DAYS,
      hasReviews: hasPopulatedReviewTextsDir(show.id),
      acks,
    });

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
