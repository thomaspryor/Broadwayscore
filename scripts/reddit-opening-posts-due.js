#!/usr/bin/env node
/**
 * reddit-opening-posts-due.js (BRO-6634)
 *
 * Cheap gate for the opening-night cadence of the Reddit draft job in
 * reddit-engagement-digest.yml: prints `due=true` when selectCandidates (the
 * draft script's own rule) would draft or redraft at least one show now, so a
 * displayed-score or review-count move reaches the owner within the hour
 * instead of at the next daily run. No LLM, no network, no writes.
 *
 * Usage: node scripts/reddit-opening-posts-due.js [--today=YYYY-MM-DD]
 * Appends `due=` and `shows=` to $GITHUB_OUTPUT when set.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib/reddit-opening-post');

const ROOT = path.resolve(__dirname, '..');
const loadJSON = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

// seenLookup must match draft-reddit-opening-posts.js, or a show the draft
// script skips (already seen on r/Broadway) would read as due every hour.
// Hourly cost guard: the drafter's own rules re-select a draft every run
// while its last LLM call failed, and redraft an emailed one whose numbers
// moved even when the send would be held by the update cap. Neither is worth
// an hourly LLM + Playwright run: a failed draft retries once per
// RETRY_GAP_HOURS, a capped one only once the cap would let the email out.
// The daily run (no gate) keeps the drafter's own behavior.
const RETRY_GAP_HOURS = 6;

function worthAnHourlyRun(prev, nowMs) {
  if (!prev) return true;
  if (lib.isRetryableDraft(prev)) {
    const at = Date.parse(prev.createdAt || '');
    return !Number.isFinite(at) || (nowMs - at) / 3600000 >= RETRY_GAP_HOURS;
  }
  if (prev.emailedAt) return lib.updateAllowed(prev, nowMs);
  return true;
}

function dueShows({ shows, slims, drafts, today, seenLookup, nowMs = Date.now() }) {
  const peers = lib.buildPeers(shows, slims);
  const prevs = (drafts && drafts.drafts) || {};
  return lib.selectCandidates({ shows, slims, drafts, peersByMarket: peers, today, seenLookup })
    .filter(c => worthAnHourlyRun(prevs[c.show.id], nowMs))
    .map(c => c.show.id);
}

function main() {
  const arg = process.argv.find(a => a.startsWith('--today='));
  const today = arg ? arg.slice(8) : new Date().toISOString().slice(0, 10);
  const d = loadJSON(path.join(ROOT, 'data', 'shows.json'));
  if (!d) { console.error('missing data/shows.json'); process.exit(1); }
  const shows = Array.isArray(d) ? d : d.shows;
  const slims = new Map();
  for (const s of shows) {
    if (!lib.SUBREDDIT_BY_MARKET[lib.marketOf(s)]) continue;
    const j = loadJSON(path.join(ROOT, 'public', 'data', 'shows', `${s.id}.json`));
    if (j) slims.set(s.id, j);
  }
  const drafts = loadJSON(path.join(ROOT, 'data', 'audit', 'reddit-post-drafts.json'), null) || { drafts: {} };
  const seenLookup = lib.makeSeenLookup(loadJSON(path.join(ROOT, 'data', 'shows-seen.json'), { shows: [] }), { sinceYear: Number(today.slice(0, 4)) - 1 });
  const ids = dueShows({ shows, slims, drafts, today, seenLookup });
  // An email the last run held back (the 6h update cap, the 20h reminder)
  // also makes the run due, so the capped final numbers still arrive.
  const { dueEmails } = require('./lib/reddit-post-email');
  const emails = dueEmails(drafts, Date.now()).map(e => `${e.draft.showId || '?'} (${e.kind})`);
  console.log(ids.length ? `Reddit drafts due: ${ids.join(', ')}` : 'No Reddit draft due');
  console.log(emails.length ? `Reddit emails due: ${emails.join(', ')}` : 'No Reddit email due');
  const due = ids.length > 0 || emails.length > 0;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nshows=${ids.join(',')}\n`);
  }
}

module.exports = { dueShows };

if (require.main === module) main();
