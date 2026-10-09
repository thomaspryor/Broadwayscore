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
 *   openSignalFromReviews() in opening-signal.js used to watch only
 *   PRE_OPEN_STATUSES = {'previews', 'upcoming'} — a show that never got a
 *   previews/upcoming stamp and sat directly in 'announced' with a null
 *   openingDate had no flip path at all. Sherlock Holmes WE ran and closed
 *   (2026-05-02 to 2026-06-06 at Regent's Park Open Air Theatre) entirely
 *   while status stayed 'announced', so the review-driven backstop never
 *   looked at it and its score never published.
 *
 *   BRO-3091 (2026-09-13) added 'announced' to PRE_OPEN_STATUSES, so that
 *   backstop now DOES auto-flip the subset it can prove: an announced show
 *   with a clean, reached press night in reviews.json. This audit is still
 *   the wider net — it also flags stale previewsStartDate/openingDate, and
 *   review-texts collected but not yet scored into reviews.json, neither of
 *   which the flip acts on. Expect the two to overlap: a show this audit
 *   flags for collected review files will usually be flipped automatically
 *   on the next update-show-status run, once those reviews are scored.
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
const { hasHelpFlag } = require('./lib/cli-help.js');
const path = require('path');
const {
  loadAcks,
  addAck,
  saveAcks,
  evaluateAnnouncedShow,
  hasEvidenceOfOpening,
  describeOpeningEvidence,
} = require('./lib/stale-announced-audit');
const { explainExclusion } = require('./lib/review-guards');
const { evaluatePostponed } = require('./lib/postponed-production-detector');

const DATA_DIR = path.join(__dirname, '..', 'data');
const argvEarly = process.argv.slice(2);
const argValue = (name) => (argvEarly.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;
const SHOWS_FILE = argValue('shows-file') || path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = argValue('reviews-file') || path.join(DATA_DIR, 'reviews.json');
// BRO-4913: {"<showId>": "<official page text>"} — bypasses network fetch (tests/VERIFY)
const PAGES_FIXTURE = argValue('pages-fixture');
const NOW_OVERRIDE = argValue('now');
const DEMOTE = argvEarly.includes('--demote');
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

function hasPopulatedReviewTextsDir(showId, show) {
  return hasEvidenceOfOpening(REVIEW_TEXTS_DIR, showId, explainExclusion, show);
}

// Announced shows that have review files but ALL of them discounted as
// wrong-show contamination. Not flagged (the discount is deliberate), but
// reported, so the case is visible instead of silent.
function findSilencedByContamination(shows) {
  const out = [];
  for (const show of shows) {
    if (show.status !== 'announced') continue;
    const ev = describeOpeningEvidence(REVIEW_TEXTS_DIR, show.id, explainExclusion, show);
    if (ev.reviewFiles > 0 && !ev.hasEvidence) {
      out.push({ id: show.id, title: show.title, reviewFiles: ev.reviewFiles, excludedFiles: ev.excludedFiles });
    }
  }
  return out;
}

const USAGE = `Usage:
  node scripts/audit-stale-announced-shows.js                                  # report stale 'announced' shows
  node scripts/audit-stale-announced-shows.js --ack=<show-id> --ack-note="<why>"  # record a triage decision
`;

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
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

  const reviewTextsAvailable = fs.existsSync(REVIEW_TEXTS_DIR);
  if (!reviewTextsAvailable) {
    console.log(`  ⚠️  ${REVIEW_TEXTS_DIR} not found — review-texts signal is disabled in this environment (private repo not checked out); only date-based signals will fire`);
  }

  for (const show of showsData.shows) {
    if (show.status !== 'announced') continue;

    const reasons = evaluateAnnouncedShow(show, {
      now,
      staleDays: STALE_DAYS,
      hasReviews: hasPopulatedReviewTextsDir(show.id, show),
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

  const silencedByContamination = findSilencedByContamination(showsData.shows);
  const postponed = await findPostponed(showsData, now);

  const report = {
    generatedAt: now.toISOString(),
    staleDaysThreshold: STALE_DAYS,
    reviewTextsAvailable,
    flaggedCount: flagged.length,
    flagged,
    postponedCount: postponed.length,
    postponed,
    silencedByContaminationCount: silencedByContamination.length,
    silencedByContamination,
  };

  console.log(`audit-stale-announced-shows: ${flagged.length} stale 'announced' show(s) (stale-days=${STALE_DAYS})`);
  for (const f of flagged) {
    console.log(`  - ${f.id} (${f.title}): ${f.reasons.join('; ')}`);
  }
  console.log(`audit-stale-announced-shows: ${postponed.length} open/previews show(s) look postponed (official page shows a future date)`);
  for (const p of postponed) {
    console.log(`  - ${p.id} (${p.title}): ${p.reason}${p.demoted ? ' [demoted to upcoming]' : ''}`);
  }
  if (DEMOTE && postponed.length > 0 && !DRY_RUN) {
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2) + '\n');
  }
  if (silencedByContamination.length > 0) {
    console.log(
      `\n${silencedByContamination.length} announced show(s) have review files but ALL are wrong-show/wrong-production contamination —`
    );
    console.log(
      '  not flagged, but if any of those flags is a false positive the show has no other signal:'
    );
    for (const s of silencedByContamination) {
      console.log(`  - ${s.id} (${s.title}): ${s.excludedFiles}/${s.reviewFiles} review file(s) discounted`);
    }
  }

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2));
    console.log(`Wrote audit: ${AUDIT_FILE}`);
  }

  if (FAIL_ON_GAP && (flagged.length > 0 || postponed.length > 0)) {
    process.exit(1);
  }
}

// BRO-4913: open/previews shows with 0 reviews 48h+ past openingDate whose
// official/TodayTix page shows a future first-performance date → postponed.
async function findPostponed(showsData, now) {
  const reviewsData = loadJSON(REVIEWS_FILE, null);
  if (!reviewsData || !Array.isArray(reviewsData.reviews)) {
    console.log(`  ⚠️  ${REVIEWS_FILE} unreadable — postponed check skipped (fail closed)`);
    return [];
  }
  const reviews = reviewsData.reviews;
  const counts = new Map();
  for (const r of reviews) counts.set(r.showId, (counts.get(r.showId) || 0) + 1);
  const fixture = PAGES_FIXTURE ? loadJSON(PAGES_FIXTURE, {}) : null;
  const effNow = NOW_OVERRIDE ? new Date(NOW_OVERRIDE) : now;
  const out = [];
  for (const show of showsData.shows) {
    if (!['open', 'previews'].includes(show.status) || !show.openingDate) continue;
    if ((counts.get(show.id) || 0) > 0) continue;
    // Prefilter BEFORE any network fetch: inside the 48h grace window or no page to read.
    if (!evaluatePostponed(show, { now: effNow, reviewCount: 0, pageText: 'coming january 1, 2099' })) continue;
    if (!fixture && !show.officialUrl && !show.todaytixUrl) continue;
    let pageText = null;
    if (fixture) {
      pageText = fixture[show.id] || null;
    } else {
      const { fetchPage } = require('./lib/scraper');
      for (const url of [show.officialUrl, show.todaytixUrl].filter(Boolean)) {
        try {
          const r = await fetchPage(url);
          const hit = evaluatePostponed(show, { now: effNow, reviewCount: 0, pageText: r.content });
          if (hit) { pageText = r.content; break; }
        } catch (e) { /* page unreachable: no signal */ }
      }
    }
    const hit = evaluatePostponed(show, { now: effNow, reviewCount: 0, pageText });
    if (!hit) continue;
    let demoted = false;
    if (DEMOTE && !DRY_RUN) {
      show.status = 'upcoming';
      show.openingDate = hit.futureDate;
      show.previewsStartDate = hit.futureDate;
      show.openingDateSource = 'official-site';
      show.openingDateNote = `Auto-demoted by audit-stale-announced-shows (BRO-4913): official page shows ${hit.futureDate}`;
      demoted = true;
    }
    out.push({ id: show.id, title: show.title, openingDate: show.openingDate, futureDate: hit.futureDate, reason: hit.reason, demoted });
  }
  return out;
}

main().catch(e => { console.error(e); process.exit(1); });
