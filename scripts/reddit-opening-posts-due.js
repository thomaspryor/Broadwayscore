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

function dueShows({ shows, slims, drafts, today }) {
  const peers = lib.buildPeers(shows, slims);
  return lib.selectCandidates({ shows, slims, drafts, peersByMarket: peers, today }).map(c => c.show.id);
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
  const ids = dueShows({ shows, slims, drafts, today });
  console.log(ids.length ? `Reddit drafts due: ${ids.join(', ')}` : 'No Reddit draft due');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${ids.length > 0}\nshows=${ids.join(',')}\n`);
  }
}

module.exports = { dueShows };

if (require.main === module) main();
