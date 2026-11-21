#!/usr/bin/env node
/**
 * audit-opening-date-vs-reviews.js (BRO-5156)
 *
 * Lists shows whose stored openingDate is later than the date most of their
 * critics reviewed them. A too-late date makes the ingest anticipatory gate
 * hold real first-night reviews back as "pre-opening posts" (Hercules WE 2025:
 * stored 2025-07-10, press night 2025-06-24, five reviews dropped).
 * Decision logic: scripts/lib/opening-date-contradiction.js.
 *
 * Report only: it never edits shows.json. For each flagged show, confirm press
 * night against Playbill / IBDB / a dated first-night review, then fix the date
 * with a data-edit pending-fix plan (template data/pending-fixes/bro-5156.json);
 * the rebuild then releases the held reviews. If the early reviews belong to a
 * different run, flag them wrongProduction instead, or record the decision with
 * --ack (an ack covers that stored date only; editing the date re-checks it).
 *
 * The daily health check runs the same scan ("Data quality: opening date vs
 * review dates").
 *
 * Usage:
 *   node scripts/audit-opening-date-vs-reviews.js            # report, exit 0
 *   node scripts/audit-opening-date-vs-reviews.js --json
 *   node scripts/audit-opening-date-vs-reviews.js --strict   # exit 1 when any unacked
 *   node scripts/audit-opening-date-vs-reviews.js --ack=<show-id> --ack-note="<why>"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  ACK_PATH,
  loadAcks,
  addAck,
  findOpeningDateContradiction,
  readShowReviewFiles,
  scanOpeningDateContradictions,
} = require('./lib/opening-date-contradiction');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');

const USAGE = `audit-opening-date-vs-reviews.js: shows whose stored openingDate is later than their review cluster (BRO-5156).

  node scripts/audit-opening-date-vs-reviews.js            report (exit 0)
  node scripts/audit-opening-date-vs-reviews.js --json     machine-readable
  node scripts/audit-opening-date-vs-reviews.js --strict   exit 1 when any unacked show is flagged
  node scripts/audit-opening-date-vs-reviews.js --ack=<show-id> --ack-note="<why>"`;

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.shows || []);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;

  if (argv.includes('--ack') || argv.includes('--ack-note')) {
    console.error('[audit-opening-date-vs-reviews] use --ack=<show-id> --ack-note="<why>" (with =)');
    process.exit(2);
  }
  if (!fs.existsSync(REVIEW_TEXTS)) {
    console.error('[audit-opening-date-vs-reviews] data/review-texts missing: run ./scripts/setup-local-data.sh');
    process.exit(2);
  }
  const shows = loadShows();
  const acks = loadAcks();

  const ackId = arg('ack');
  if (ackId) {
    const show = shows.find((s) => s.id === ackId);
    const finding = show && findOpeningDateContradiction(show, readShowReviewFiles(REVIEW_TEXTS, show.id));
    if (!finding) {
      console.error(`[audit-opening-date-vs-reviews] ${ackId} is not flagged; nothing to ack`);
      process.exit(2);
    }
    const next = addAck(acks, finding, arg('ack-note') || '', new Date().toISOString());
    fs.mkdirSync(path.dirname(ACK_PATH), { recursive: true });
    fs.writeFileSync(ACK_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`acked ${ackId} @ ${finding.openingDate}`);
    return;
  }

  const { flagged, acked } = scanOpeningDateContradictions(shows, REVIEW_TEXTS, acks);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ flagged, acked }, null, 2));
  } else {
    for (const f of flagged) {
      console.log(`${f.id}: stored ${f.openingDate} (${f.openingDateSource || 'no source'}), press night ${f.pressNight}, ${f.earlyOutlets}/${f.outlets} outlets early`);
    }
    console.log(`${flagged.length} flagged, ${acked.length} acked`);
  }
  if (argv.includes('--strict') && flagged.length > 0) process.exit(1);
}

main();
