#!/usr/bin/env node
/**
 * dispatch-reviews-in-push.js (BRO-6219)
 *
 * Dispatches the iOS app's "The reviews are in" push for shows that are ready
 * (same review thresholds as the email), then writes the web-side
 * `push:<id>` marker in data/opening-night-sent.json ONLY once the app run
 * finished successfully, i.e. at least one Expo ticket was accepted (the app
 * sender exits non-zero when it had recipients and no ticket). A dispatch that
 * merely succeeded used to be enough, so a failed send was marked done and
 * never retried.
 *
 * Titles go to `gh` as argv entries, never through a shell, so
 * "Hell's Kitchen" is just a string. The app dedupes by show on its side
 * (push_log), so a retry after the wait budget ran out cannot double-send.
 *
 * Usage: node scripts/dispatch-reviews-in-push.js --ready=id1,id2 [--budget-sec=180] [--dry-run]
 * Env: GH_TOKEN (a token that can dispatch in the app repo)
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pushCandidates, feedFacts, feedIsFresh, findDispatchedRun, runOutcome, runNameFor } = require('./lib/reviews-in-push');

const APP_REPO = 'thomaspryor/BroadwayScorecard-app';
const WORKFLOW = 'send-notifications.yml';
const SENT_PATH = path.join(__dirname, '..', 'data', 'opening-night-sent.json');
const POLL_MS = 15_000;

function arg(name) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`) || a === `--${name}`);
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readSent() {
  try { return JSON.parse(fs.readFileSync(SENT_PATH, 'utf8')); } catch { return { shows: {} }; }
}

/** id -> mobile feed entry, or null when the file is missing or older than 3h (the app then reads the live feed). */
function readFeedById() {
  try {
    const feed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json'), 'utf8'));
    if (!feedIsFresh(feed._ts)) { console.log(`Local mobile feed is stale (${feed._ts}); the app will read the live feed for threshold modes.`); return null; }
    return new Map((feed.shows || []).map(s => [s.id, s]));
  } catch { return null; }
}

function writeMarker(showId) {
  const d = readSent();
  d.shows = d.shows || {};
  d.shows[`push:${showId}`] = { sentAt: new Date().toISOString() };
  fs.writeFileSync(SENT_PATH, JSON.stringify(d, null, 2) + '\n');
}

async function waitForOutcome(show, dispatchedAt, deadlineMs) {
  while (Date.now() + POLL_MS <= deadlineMs) {
    await sleep(POLL_MS);
    let runs = [];
    try {
      runs = JSON.parse(gh(['run', 'list', '--repo', APP_REPO, '--workflow', WORKFLOW,
        '--event', 'workflow_dispatch', '--limit', '30', '--json', 'displayTitle,createdAt,status,conclusion']));
    } catch (e) {
      console.log(`  could not list runs yet (${String(e.message).split('\n')[0]})`);
      continue;
    }
    const outcome = runOutcome(findDispatchedRun(runs, show.id, dispatchedAt));
    if (outcome !== 'pending') return outcome;
  }
  return 'pending';
}

async function main() {
  const readyIds = String(arg('ready') || '').split(',').map(s => s.trim()).filter(Boolean);
  const dryRun = !!arg('dry-run');
  const deadline = Date.now() + (Number(arg('budget-sec')) || 180) * 1000;

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || Object.values(raw));
  const candidates = pushCandidates({ readyIds, shows, sent: readSent().shows || {} });
  console.log(`Ready: ${readyIds.length}. To push: ${candidates.length}${candidates.length ? ` (${candidates.map(c => c.id).join(', ')})` : ''}.`);

  const skipped = readyIds.filter(id => !candidates.some(c => c.id === id));
  if (skipped.length) console.log(`Not pushed (market, age, marker, or no opening date): ${skipped.join(', ')}`);

  const feedById = readFeedById();
  for (const show of candidates) {
    if (!show.title) { console.log(`::warning::${show.id} has no title; not pushing`); continue; }
    const dispatchArgs = ['workflow', 'run', WORKFLOW, '--repo', APP_REPO,
      '-f', 'type=reviews-in', '-f', `show_id=${show.id}`, '-f', `show=${show.slug}`,
      '-f', `title=${show.title}`, '-f', `category=${show.category}`];
    // Threshold modes (BRO-6583): the score, label and audience grade as of this build.
    if (feedById) {
      const facts = feedFacts(feedById.get(show.id));
      dispatchArgs.push('-f', 'facts=dispatch', '-f', `critic_score=${facts.criticScore}`, '-f', `critic_label=${facts.criticLabel}`,
      '-f', `audience_grade=${facts.audienceGrade}`, '-f', `show_type=${facts.showType}`);
    }
    if (dryRun) { console.log(`[dry run] would dispatch ${runNameFor(show.id)}`); continue; }
    const dispatchedAt = Date.now();
    try {
      gh(dispatchArgs);
    } catch (e) {
      console.log(`::warning::push dispatch failed for ${show.id}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const outcome = await waitForOutcome(show, dispatchedAt, deadline);
    if (outcome === 'sent') {
      writeMarker(show.id);
      console.log(`Pushed ${show.id}: marker written.`);
    } else if (outcome === 'failed') {
      console.log(`::warning::push run for ${show.id} did not send (no marker; the next run retries, the app dedupes).`);
    } else {
      console.log(`::warning::push run for ${show.id} had not finished within the wait budget (no marker; the next run checks again, the app dedupes).`);
    }
  }
}

main().catch(err => {
  console.log(`::warning::reviews-in push step failed (non-fatal): ${err.message}`);
});
