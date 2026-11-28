#!/usr/bin/env node
/**
 * reddit-opening-posts-due.js (BRO-6634)
 *
 * Cheap gate for the opening-night cadence of the Reddit draft job in
 * reddit-engagement-digest.yml: prints `due=true` when selectCandidates (the
 * draft script's own rule) would draft or redraft at least one show now, so a
 * displayed-score or review-count move reaches the owner within the hour
 * instead of at the next daily run. Logs emailed/current repo numbers and
 * warns on mismatches with an email at least 2h old (BRO-6987). No LLM,
 * network, or draft-state writes; appends diagnostics to the run summary.
 *
 * Usage: node scripts/reddit-opening-posts-due.js [--today=YYYY-MM-DD]
 * Appends `due=` and `shows=` to $GITHUB_OUTPUT when set.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib/reddit-opening-post');
const { dueShows, buildDueReport } = require('./lib/reddit-opening-posts-due');

const ROOT = path.resolve(__dirname, '..');
const loadJSON = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

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
  // Match the drafter's owner-history lookup, so seen shows aren't due hourly.
  const seenLookup = lib.makeSeenLookup(loadJSON(path.join(ROOT, 'data', 'shows-seen.json'), { shows: [] }), { sinceYear: Number(today.slice(0, 4)) - 1 });
  // An email the last run held back (the 6h update cap, the 20h reminder)
  // also makes the run due, so the capped final numbers still arrive.
  const report = buildDueReport({ shows, slims, drafts, today, seenLookup });
  const { ids, due } = report;
  const emails = report.emails.map(e => `${e.draft.showId || '?'} (${e.kind})`);
  console.log(ids.length ? `Reddit drafts due: ${ids.join(', ')}` : 'No Reddit draft due');
  console.log(emails.length ? `Reddit emails due: ${emails.join(', ')}` : 'No Reddit email due');
  console.log(report.summary);
  for (const warning of report.warnings) {
    // Escape workflow-command data, even though show ids are normally slugs.
    console.log(`::warning::${warning.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nshows=${ids.join(',')}\n`);
  }
}

module.exports = { dueShows };

if (require.main === module) main();
