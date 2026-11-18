#!/usr/bin/env node
'use strict';
/**
 * The opening-night lane's manual-URL inbox (BRO-7741). The fast path when a review is missing on a lane night:
 *
 *   node scripts/opening-night-lane-inbox.js add --show=SHOW_ID --url=URL [--outlet=ID] [--critic="Name"] [--force]
 *   node scripts/opening-night-lane-inbox.js list [--show=SHOW_ID] [--json]
 *   node scripts/opening-night-lane-inbox.js drain --show=SHOW_ID [--dispatch]
 *
 * add      Queue a URL. The running lane reads the inbox every pass (about 2 minutes), fetches, scores and publishes it.
 *          --force skips the night-date check (the page carries a wrong date). Dispatching ingest-urls.yml by hand
 *          for a leased show does the same thing.
 * list     What is in the inbox and what the lane did with each URL (queued, published, failed + why, rejected + why).
 * drain    After the lane ends: entries the lane never finished go to ingest-urls.yml (the regular path) and are
 *          marked drained. Without --dispatch it only prints what it would send. Run by opening-night-lane-live.yml.
 */
require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const inbox = require('./lib/opening-night-lane/manual-inbox');

const REPO_DIR = path.join(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined; };
const flag = (name) => args.includes(`--${name}`);

function die(msg, code = 1) { console.error(msg); process.exit(code); }

function add() {
  const show = arg('show');
  const url = arg('url');
  if (!show || !url) die('usage: add --show=SHOW_ID --url=URL [--outlet=ID] [--critic="Name"] [--force]');
  const shows = require('../data/shows.json').shows || [];
  if (!shows.some((s) => s.id === show)) die(`Show not found: ${show}`);
  const res = inbox.addSync({ repoDir: REPO_DIR }, {
    show, addedBy: process.env.GITHUB_ACTOR ? `cli:${process.env.GITHUB_ACTOR}` : 'cli',
    lines: [{ url, ...(arg('outlet') ? { outletId: arg('outlet') } : {}), ...(arg('critic') ? { critic: arg('critic') } : {}), ...(flag('force') ? { force: true } : {}) }],
  });
  if (!res.ok) die(`inbox write failed: ${res.reason} ${res.detail || ''}`);
  console.log(res.added.length ? `Queued for the lane: ${url} (${res.added[0]}). It is picked up on the next pass, about 2 minutes.`
    : `Already in the inbox: ${url} (${res.duplicates[0]}).`);
}

function list() {
  const state = inbox.readSync({ repoDir: REPO_DIR });
  const show = arg('show');
  const shows = show ? [show] : [...new Set(Object.values(state.leases || {}).map((e) => e.show))];
  const rows = shows.flatMap((s) => inbox.entriesFor(state, s));
  if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log(show ? `Inbox empty for ${show}.` : 'Inbox empty.'); return; }
  for (const e of rows) console.log(`${e.show}  ${e.status || 'waiting'}${e.reason ? ` (${e.reason})` : ''}  ${e.url}  added ${e.addedAt} by ${e.addedBy}`);
}

/** Pure: the ingest-urls lines for entries the lane did not finish. */
function drainPlan(entries) {
  const { formatIngestLine } = require('./lib/ingest-url-line');
  const open = entries.filter((e) => !e.status || e.status === 'queued' || e.status === 'failed');
  return { open, lines: open.map((e) => formatIngestLine({ url: e.url, outlet: e.outletId || null, critic: e.critic || null })) };
}

function drain() {
  const show = arg('show');
  if (!show) die('usage: drain --show=SHOW_ID [--dispatch]');
  const { open, lines } = drainPlan(inbox.entriesFor(inbox.readSync({ repoDir: REPO_DIR }), show));
  if (!open.length) { console.log(`Nothing to drain for ${show}.`); return; }
  console.log(`${open.length} inbox URL(s) the lane did not publish:\n${lines.join('\n')}`);
  if (!flag('dispatch')) { console.log('(dry run: pass --dispatch to send them to ingest-urls.yml)'); return; }
  require('./lib/rest-dispatch').dispatch({ workflow: 'ingest-urls.yml', inputs: { show_id: show, urls: lines.join('\n'), caller: 'lane-inbox-drain' } });
  const res = inbox.markSync({ repoDir: REPO_DIR }, open.map((e) => ({ id: e.id, status: 'drained', reason: 'sent to ingest-urls after the lane ended' })));
  if (!res.ok) console.log(`::warning::drained ${open.length} URL(s) to ingest-urls but the inbox status write failed (${res.reason}); a second drain would send them again`);
  console.log(`::notice::lane inbox: sent ${open.length} URL(s) for ${show} to ingest-urls.yml`);
}

if (require.main === module) {
  if (cmd === 'add') add();
  else if (cmd === 'list') list();
  else if (cmd === 'drain') drain();
  else die('usage: opening-night-lane-inbox.js add|list|drain (see --help)');
}

module.exports = { drainPlan };
