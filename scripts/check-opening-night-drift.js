#!/usr/bin/env node
'use strict';

/**
 * check-opening-night-drift.js
 *
 * Compares local review-texts count (isIncludableForRebuild) vs reviews.json count
 * vs the live `rc` field from the production JSON API for shows near their opening night.
 *
 * Usage:
 *   node scripts/check-opening-night-drift.js
 *   node scripts/check-opening-night-drift.js --show=show-id-2026
 *   node scripts/check-opening-night-drift.js --threshold=3 --json
 *   node scripts/check-opening-night-drift.js --window=7   # days ± around openingDate
 *
 * Exit codes:
 *   0 — no drift above threshold (or cooldown suppressed the alert)
 *   1 — drift detected above threshold that warrants an alert
 *   2 — argument or data error
 */

const fs = require('fs');
const path = require('path');
const { countLocalIncluded, countAggregate, fetchLiveRc, computeDrift } = require('./lib/review-count-probe');

// ── Args ─────────────────────────────────────────────────────────────────────

const RAW_ARGS = process.argv.slice(2);
const flags = {};
RAW_ARGS.forEach(a => {
  const m = a.match(/^--([a-z-]+)(?:=(.+))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
});

const SPECIFIC_SHOW   = flags.show || null;
const THRESHOLD       = parseInt(flags.threshold || '2', 10);
const WINDOW_DAYS     = parseInt(flags.window || '7', 10);
const JSON_OUTPUT     = !!flags.json;
const STATE_FILE      = flags['state-file'] || path.join('data', 'audit', 'drift-state.json');
const REVIEW_TEXTS    = flags['review-texts-root'] || path.join('data', 'review-texts');
const REVIEWS_JSON    = path.join('data', 'reviews.json');
const SHOWS_JSON      = path.join('data', 'shows.json');

// Cooldown: re-alert only after 6h if fingerprint unchanged
const SAME_FP_COOLDOWN_MS  = 6 * 60 * 60 * 1000;
// Grace window: only alert if same fingerprint on 2+ consecutive runs
const GRACE_CONSECUTIVE    = 2;

// ── Load data ────────────────────────────────────────────────────────────────

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadState() {
  try {
    return loadJson(STATE_FILE);
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ── Show resolution ───────────────────────────────────────────────────────────

function getTargetShows() {
  const showsData = loadJson(SHOWS_JSON);
  const shows = showsData.shows || showsData;

  if (SPECIFIC_SHOW) {
    const s = shows.find(s => s.id === SPECIFIC_SHOW || s.slug === SPECIFIC_SHOW);
    if (!s) {
      console.error(`Show not found: ${SPECIFIC_SHOW}`);
      process.exit(2);
    }
    return [s];
  }

  const now = Date.now();
  const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return shows.filter(s => {
    if (!s.openingDate) return false;
    const opening = new Date(s.openingDate).getTime();
    if (isNaN(opening)) return false;
    return Math.abs(now - opening) <= windowMs;
  });
}

// ── Fingerprint logic ─────────────────────────────────────────────────────────

function makeFingerprint(local, agg, live) {
  return `${local}:${agg}:${live ?? 'null'}`;
}

/**
 * Returns true if we should fire an alert for this show given the current
 * fingerprint and state entry.
 *
 * Alert fires when:
 *   - New fingerprint (drift just appeared or changed)
 *   - Same fingerprint AND >6h since last alert AND observed 2+ consecutive runs
 */
function shouldAlert(showId, fingerprint, drift, state) {
  if (drift <= THRESHOLD) return false;

  const entry = state[showId];
  if (!entry || entry.fingerprint !== fingerprint) {
    // New or changed fingerprint — start grace window
    return false; // Wait for next run to confirm
  }

  // Same fingerprint as previous run
  const consecutiveCount = (entry.consecutiveCount || 1) + 1;
  if (consecutiveCount < GRACE_CONSECUTIVE) return false;

  const now = Date.now();
  if (!entry.lastAlertTs) return true;
  return (now - entry.lastAlertTs) >= SAME_FP_COOLDOWN_MS;
}

function updateState(state, showId, fingerprint, didAlert) {
  const entry = state[showId];
  const now = Date.now();

  if (!entry || entry.fingerprint !== fingerprint) {
    state[showId] = {
      fingerprint,
      firstSeen: now,
      consecutiveCount: 1,
      lastAlertTs: didAlert ? now : null,
    };
  } else {
    state[showId] = {
      ...entry,
      consecutiveCount: (entry.consecutiveCount || 1) + 1,
      lastAlertTs: didAlert ? now : entry.lastAlertTs,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const targetShows = getTargetShows();

  if (targetShows.length === 0) {
    if (!JSON_OUTPUT) console.log('No shows in opening window — nothing to check.');
    process.exit(0);
  }

  let reviewsDoc;
  try {
    reviewsDoc = loadJson(REVIEWS_JSON);
  } catch {
    console.error('Cannot read data/reviews.json — is core data checked out?');
    process.exit(2);
  }

  const state = loadState();
  const results = [];
  let anyAlert = false;

  for (const show of targetShows) {
    const showId = show.id;
    const local  = countLocalIncluded(showId, REVIEW_TEXTS);
    const agg    = countAggregate(showId, reviewsDoc);
    const live   = await fetchLiveRc(showId);
    const drift  = computeDrift({ local: local.included, aggregate: agg, live: live.rc });

    const fingerprint = makeFingerprint(local.included, agg, live.rc);
    const alert       = shouldAlert(showId, fingerprint, drift.drift, state);
    updateState(state, showId, fingerprint, alert);

    if (alert) anyAlert = true;

    results.push({
      showId,
      title: show.title || showId,
      openingDate: show.openingDate,
      local: local.included,
      localTotal: local.total,
      localExcluded: local.excluded,
      aggregate: agg,
      live: live.rc,
      liveErr: live.err,
      drift: drift.drift,
      threshold: THRESHOLD,
      alert,
      fingerprint,
    });
  }

  saveState(state);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    // Table output
    const header = ['Show', 'Opening', 'Local', 'Agg', 'Live', 'Drift', 'Alert'].join('\t');
    console.log('\n' + header);
    console.log('─'.repeat(80));
    for (const r of results) {
      const alertMark = r.alert ? '🔴 YES' : r.drift > THRESHOLD ? '⏳ grace' : '✅ ok';
      const liveFmt = r.live != null ? String(r.live) : `err(${r.liveErr})`;
      console.log([r.showId, r.openingDate || '?', r.local, r.aggregate, liveFmt, r.drift, alertMark].join('\t'));
    }
    console.log();

    const driftShows = results.filter(r => r.drift > THRESHOLD);
    if (driftShows.length === 0) {
      console.log(`✅ All ${results.length} show(s) within threshold (≤${THRESHOLD}).`);
    } else {
      console.log(`⚠️  ${driftShows.length}/${results.length} show(s) above drift threshold (>${THRESHOLD}):`);
      for (const r of driftShows) {
        console.log(`   ${r.showId}: local=${r.local}, agg=${r.aggregate}, live=${r.live ?? 'n/a'}, drift=${r.drift}`);
        console.log(`   Fix: node scripts/verify-review-recovery.js --show=${r.showId} --production`);
      }
    }

    const alertShows = results.filter(r => r.alert);
    if (alertShows.length > 0) {
      console.log(`\n🔴 Alerting on ${alertShows.length} show(s) (grace window passed, cooldown clear).`);
    }
  }

  process.exit(anyAlert ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(2);
});
