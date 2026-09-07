#!/usr/bin/env node
/**
 * check-missed-broadcasts.js — daily sweep for opening-night emails that never
 * reached subscribers.
 *
 * opening-night-broadcast.yml only considers shows opened within a 2-day
 * lookback window. A show that stays gate-blocked longer than that leaves the
 * window and is never reconsidered — no send, and no alert either, because the
 * overdue pager is gated on that same window. Electra / Persona opened
 * 2026-09-01, was checklist-blocked on every run, and left the pipeline
 * unannounced; the owner discovered it a week later.
 *
 * Runs from data-health-check.yml alongside the other lifetime sweeps, which
 * exist for the same structural reason: a check that only ever runs inside the
 * opening-night window cannot see anything that ages out of it.
 *
 * Predicate + rationale: scripts/lib/missed-broadcasts.js (pure, unit-tested).
 * This file is I/O and alert routing only (CLAUDE.md §15).
 *
 * Usage:
 *   node scripts/check-missed-broadcasts.js              # report + alert
 *   node scripts/check-missed-broadcasts.js --dry-run    # report only, no alert, no snapshot write
 *   node scripts/check-missed-broadcasts.js --json       # machine-readable to stdout
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  findMissedBroadcasts,
  DEFAULT_MAX_ALERT_AGE_DAYS: MAX_ALERT_AGE_DAYS,
} = require('./lib/missed-broadcasts');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const AS_JSON = args.includes('--json');

const DATA_DIR = path.join(process.cwd(), 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'audit', 'missed-broadcasts.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function fileExists(file) {
  return fs.existsSync(path.join(DATA_DIR, file));
}

/**
 * Per-state remediation. These are NOT interchangeable: 'draft-stuck' already
 * has a draft waiting in Resend (re-running would make a second one), and
 * 'draft-unknown' may ALREADY have gone out (re-running would email real
 * subscribers twice — CLAUDE.md §17). Only 'never-drafted' gets a send command.
 */
function remediationFor(m) {
  const checklist = `  node scripts/opening-night-checklist.js --show=${m.id}`;
  if (m.state === 'draft-stuck') {
    return (
      'A Resend draft EXISTS for this show and was never sent — the pipeline did its job and the ' +
      'send is waiting on a human. Do NOT re-run the broadcast (that creates a second draft).\n\n' +
      `Open the draft and send or delete it:\n  ${m.draftUrl || 'https://resend.com/broadcasts'}`
    );
  }
  if (m.state === 'draft-unknown') {
    return (
      'A draft existed for this show and Resend now returns 404 for it, with no confirmed send on ' +
      'record. This is genuinely ambiguous: Resend also reaps SUCCESSFULLY SENT broadcasts within ' +
      'hours, so this may already have reached subscribers.\n\n' +
      'VERIFY IN RESEND FIRST — check whether this broadcast was delivered:\n' +
      '  https://resend.com/broadcasts\n\n' +
      'Do NOT force-send on the strength of this alert alone; if it did go out, re-sending emails ' +
      'every subscriber a second time.'
    );
  }
  return (
    'No Resend draft was ever created, so subscribers received nothing. The automated pipeline will ' +
    'NOT retry — opening-night-broadcast.yml only considers shows opened within the last 2 days, and ' +
    'this show is past that window. Acting on this alert is the only remaining path to the send.\n\n' +
    `Check what blocked it:\n${checklist}\n\n` +
    'Then send (force_broadcast=true is required while QA errors remain):\n' +
    `  gh workflow run "Opening Night Broadcast" -f lookback_days=${m.daysSinceOpening + 1} -f force_broadcast=true`
  );
}

const STATE_LABEL = {
  'never-drafted': 'no draft ever created',
  'draft-stuck': 'draft created but never sent',
  'draft-unknown': 'draft 404s in Resend — may or may not have sent',
};

async function main() {
  const showsRaw = readJson('shows.json', null);
  // Fail loudly rather than reporting a cheerful zero off a missing/partial
  // core-data checkout — "no missed broadcasts" read off no shows at all is
  // exactly the confident-wrong-answer this sweep exists to prevent.
  if (!showsRaw || !Array.isArray(showsRaw.shows) || showsRaw.shows.length === 0) {
    console.error('::error::shows.json missing or empty — cannot check for missed broadcasts');
    process.exit(1);
  }

  const reviewsRaw = readJson('reviews.json', []);
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  if (!reviews.length) {
    console.error('::error::reviews.json missing or empty — cannot evaluate broadcast readiness');
    process.exit(1);
  }

  // Fail closed on a tracker that is absent, unparseable, or the wrong shape —
  // not merely empty. This file is gitignored in the public repo and arrives
  // via checkout-core-data, whose own canary validates only shows.json and
  // reviews.json, so a partial copy would not be caught upstream. Reading a
  // missing tracker as "nothing was ever drafted" would page for every
  // qualifying show at once: a confident, entirely wrong alert naming shows
  // that DID send. An existing-but-empty tracker is legitimate (nothing
  // drafted yet), so only absence or corruption is fatal.
  if (!fileExists('opening-night-sent.json')) {
    console.error('::error::opening-night-sent.json absent — cannot tell drafted from never-drafted (expected via checkout-core-data)');
    process.exit(1);
  }
  const sentRaw = readJson('opening-night-sent.json', null);
  if (!sentRaw || typeof sentRaw !== 'object' || typeof sentRaw.shows !== 'object' || sentRaw.shows === null) {
    console.error('::error::opening-night-sent.json is unparseable or missing its `shows` object — refusing to report every show as never-drafted');
    process.exit(1);
  }

  const missed = findMissedBroadcasts({
    shows: showsRaw.shows,
    sentShows: sentRaw.shows,
    reviews,
    now: Date.now(),
  });

  const alertable = missed.filter((m) => m.alertable);
  const aged = missed.filter((m) => !m.alertable);

  // The snapshot is UNBOUNDED by age on purpose. Alerting stops at
  // MAX_ALERT_AGE_DAYS, but dropping aged shows from the record entirely would
  // recreate this sweep's own bug at a longer horizon — health-check.js reads
  // this file for the daily digest, so an aged-out show stays visible there
  // instead of disappearing.
  const snapshot = {
    generatedAt: new Date().toISOString(),
    missedCount: missed.length,
    alertableCount: alertable.length,
    agedOutCount: aged.length,
    missed,
  };
  if (!DRY_RUN) {
    try {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      console.error(`::warning::could not write ${SNAPSHOT_PATH}: ${err.message}`);
    }
  }

  if (AS_JSON) console.log(JSON.stringify(snapshot, null, 2));

  if (!missed.length) {
    console.log('No missed opening-night broadcasts.');
    // Close any open ledger conditions so a resolved show doesn't sit "open"
    // forever and its NEXT occurrence reads as a continuing incident.
    if (!DRY_RUN) resolveAll([]);
    return;
  }

  console.log(`Missed opening-night broadcasts (${missed.length}; ${alertable.length} alertable, ${aged.length} aged out past ${MAX_ALERT_AGE_DAYS}d):`);
  for (const m of missed) {
    console.log(`  - ${m.title} (${m.id}) — opened ${m.openingDate}, ${m.daysSinceOpening}d ago, ${m.scoredReviews} scored reviews, ${STATE_LABEL[m.state] || m.state}${m.alertable ? '' : ' [aged out — digest only]'}`);
  }

  if (DRY_RUN) {
    console.log('--dry-run: no alert routed, no snapshot written.');
    return;
  }

  resolveAll(alertable.map((m) => m.id));

  const { routeAlert } = require('./lib/owner-alert-router');

  // ONE ALERT PER SHOW, not one alert naming the current set.
  // A combined `...:' + sortedIds` key looks like dedup but defeats it: the set
  // changes whenever any show ages in or out, and every change is a brand-new
  // conditionKey whose cooldown starts at zero, so three unresolved shows could
  // page most days of a week while nothing actually changed. A per-show key
  // means each show pages on its own schedule, and resolving one cannot re-page
  // the others.
  for (const m of alertable) {
    const result = await routeAlert({
      conditionKey: `broadcast:never-sent:${m.id}`,
      title: `Opening Night Email Never Reached Subscribers — ${m.title}`,
      description:
        `${m.title} opened ${m.openingDate} (${m.daysSinceOpening} days ago) and qualified to ` +
        `broadcast (${m.readiness}), but subscribers were never emailed. ` +
        `State: ${STATE_LABEL[m.state] || m.state}.\n\n` +
        `${remediationFor(m)}\n\n` +
        `If the show is simply too stale to be worth emailing, no action is needed — this alert ` +
        `stops on its own once the show is more than ${MAX_ALERT_AGE_DAYS} days past opening.`,
      severity: 'error',
      disposition: 'human',
      // Weekly, not daily. The condition is durable and needs a human decision;
      // re-paging every 24h for something already seen and consciously deferred
      // is how an alert becomes noise and stops being read.
      cooldownHours: 24 * 7,
      fields: [
        { name: 'Show', value: `${m.title} (${m.id})` },
        { name: 'Opened', value: `${m.openingDate} — ${m.daysSinceOpening} days ago` },
        { name: 'State', value: STATE_LABEL[m.state] || m.state },
        { name: 'Readiness', value: m.readiness },
      ],
    });
    console.log(`[alert-router] ${m.id} (${m.state}): ${result.action}`);
  }
}

/**
 * Close ledger conditions for shows no longer in the alertable set, so a show
 * that gets sent (or ages out) stops reading as an open incident.
 */
function resolveAll(stillOpenIds) {
  let resolveCondition;
  try {
    ({ resolveCondition } = require('./lib/owner-alert-router'));
  } catch {
    return;
  }
  if (typeof resolveCondition !== 'function') return;
  const keep = new Set(stillOpenIds.map((id) => `broadcast:never-sent:${id}`));
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audit', 'alert-ledger.json'), 'utf8'));
  } catch {
    return;
  }
  const conditions = (ledger && ledger.conditions) || {};
  for (const key of Object.keys(conditions)) {
    if (!key.startsWith('broadcast:never-sent:')) continue;
    if (keep.has(key)) continue;
    if (conditions[key] && conditions[key].status !== 'open') continue;
    try {
      resolveCondition(key);
      console.log(`[alert-router] resolved stale condition ${key}`);
    } catch (err) {
      console.error(`::warning::could not resolve ${key}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`::error::check-missed-broadcasts failed: ${err.message}`);
  process.exit(1);
});
