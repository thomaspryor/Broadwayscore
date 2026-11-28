#!/usr/bin/env node
'use strict';
/**
 * The opening-night lane's manual-URL inbox (BRO-7741). The fast path when a review is missing on a lane night:
 *
 *   node scripts/opening-night-lane-inbox.js add --show=SHOW_ID --url=URL [--outlet=ID] [--critic="Name"] [--force] [--queue-anyway]
 *   node scripts/opening-night-lane-inbox.js correct --show=SHOW_ID --url=URL --field=humanReviewScore --value=V [--expect=V]
 *   node scripts/opening-night-lane-inbox.js list [--show=SHOW_ID] [--json]
 *   node scripts/opening-night-lane-inbox.js drain --show=SHOW_ID [--dispatch]
 *   node scripts/opening-night-lane-inbox.js sweep [--dispatch]
 *
 * add      Queue a URL. The running lane reads the inbox every pass (about 2 minutes), fetches, scores and publishes it.
 *          Refused (exit 2) when no lane holds the show, since nothing would read it; --queue-anyway queues it for a
 *          lane that has not started yet. --force skips the night-date check (the page carries a wrong date). Dispatching ingest-urls.yml by hand
 *          for a leased show does the same thing.
 * correct  BRO-7891 item 2: fix the score of a review the lane published tonight. The
 *          lane edits its review file and republishes the row on its next pass. Refused (exit 2) when no lane holds the
 *          show: use new-fix-plan.js --review-edit then. --expect=V refuses the edit unless the field still holds V.
 * list     What is in the inbox and what the lane did with each URL (queued, published, failed + why, rejected + why).
 * drain    After the lane ends: entries the lane never finished go to ingest-urls.yml (the regular path) and are
 *          marked drained. Without --dispatch it only prints what it would send. Run by opening-night-lane-live.yml.
 * sweep    Hourly safety net (opening-night-checklist.yml): any show no lane holds whose entries were left open for 6h,
 *          or drained / already-in 2h ago and still not in reviews.json (up to 3 sends), goes to ingest-urls.yml.
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
  if (!show || !url) die('usage: add --show=SHOW_ID --url=URL [--outlet=ID] [--critic="Name"] [--force] [--queue-anyway]');
  const shows = require('../data/shows.json').shows || [];
  if (!shows.some((s) => s.id === show)) die(`Show not found: ${show}`);
  // Only a running lane reads the inbox. With no lease on the show the URL would sit unread and expire, so it goes
  // through ingest-urls.yml instead. --queue-anyway is for queuing tonight's URL before the lane has started.
  const held = liveLease(show);
  if (!held && !flag('queue-anyway')) {
    die(`No opening-night lane holds ${show} right now, so nothing would read the inbox. Add the URL the regular way (dispatch ingest-urls.yml with show_id=${show}), or pass --queue-anyway if the lane starts later tonight.`, 2);
  }
  const res = inbox.addSync({ repoDir: REPO_DIR }, {
    show, addedBy: process.env.GITHUB_ACTOR ? `cli:${process.env.GITHUB_ACTOR}` : 'cli',
    lines: [{ url, ...(arg('outlet') ? { outletId: arg('outlet') } : {}), ...(arg('critic') ? { critic: arg('critic') } : {}), ...(flag('force') ? { force: true } : {}) }],
  });
  if (!res.ok) die(`inbox write failed: ${res.reason} ${res.detail || ''}`);
  console.log(res.added.length ? `Queued for the lane: ${url} (${res.added[0]}). It is picked up on the next pass, about 2 minutes.`
    : `Already in the inbox: ${url} (${res.duplicates[0]}).`);
}

/** A CLI value: JSON when it parses (numbers, null, booleans, quoted strings), else the raw string. */
function parseValue(v) { if (v === undefined) return undefined; try { return JSON.parse(v); } catch { return v; } }

function correct() {
  const show = arg('show'); const url = arg('url'); const field = arg('field'); const raw = arg('value');
  if (!show || !url || !field || raw === undefined) die('usage: correct --show=SHOW_ID --url=URL --field=humanReviewScore --value=V [--expect=V]');
  const held = liveLease(show);
  if (!held) die(`No opening-night lane holds ${show} right now; fix it the regular way: node scripts/new-fix-plan.js --review-edit='${show}/<file>.json:${field}=${raw}'`, 2);
  const line = { url, field, value: parseValue(raw), ...(arg('expect') !== undefined ? { expect: parseValue(arg('expect')) } : {}) };
  const res = inbox.addCorrectionsSync({ repoDir: REPO_DIR }, {
    show, addedBy: process.env.GITHUB_ACTOR ? `cli:${process.env.GITHUB_ACTOR}` : 'cli', lines: [line],
  });
  if (!res.ok) die(`correction refused: ${res.reason} ${res.detail || ''}`);
  console.log(`Queued for the lane: ${field}=${JSON.stringify(line.value)} on ${url} (${res.added[0]}). Applied on the next pass, about 2 minutes; check with: node scripts/opening-night-lane-inbox.js list --show=${show}`);
}

function list() {
  const state = inbox.readSync({ repoDir: REPO_DIR });
  const show = arg('show');
  const shows = show ? [show] : [...new Set(Object.values(state.leases || {}).map((e) => e.show))];
  const rows = shows.flatMap((s) => inbox.entriesFor(state, s));
  if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log(show ? `Inbox empty for ${show}.` : 'Inbox empty.'); return; }
  for (const e of rows) console.log(`${e.show}  ${e.status || 'waiting'}${e.reason ? ` (${e.reason})` : ''}  ${inbox.isCorrection(e) ? `correct ${e.field}=${JSON.stringify(e.value)} on ` : ''}${e.url}  added ${e.addedAt} by ${e.addedBy}`);
}

const ingestLines = (entries) => { const { formatIngestLine } = require('./lib/ingest-url-line'); return entries.map((e) => formatIngestLine({ url: e.url, outlet: e.outletId || null, critic: e.critic || null })); };

/**
 * Pure: the entries the lane did not finish. A date rejection of a URL that came in through a hand dispatch of
 * ingest-urls goes on too: that dispatch could not pass --force, and before the inbox it ingested whatever the date.
 */
function drainPlan(entries) {
  // A correction is not a URL to ingest: its edit is on the lane's review file (or was refused and alerted).
  const open = entries.filter((e) => !inbox.isCorrection(e)).filter((e) => !e.status || e.status === 'queued' || e.status === 'failed'
    || (e.status === 'rejected' && /^ingest-urls/.test(String(e.addedBy || ''))));
  return { open, lines: ingestLines(open) };
}

const STALE_OPEN_MS = 6 * 60 * 60 * 1000; // an open entry this old with no lane holding the show: the lane is not coming
const RECHECK_MS = 2 * 60 * 60 * 1000; // a drained or already-in URL still not in reviews.json after this: send it again
const MAX_DRAINS = 3;

/**
 * Pure: what the hourly sweep sends to ingest-urls, per show. Catches every way an inbox URL could be left behind: the
 * night job's drain skipped (push failed, lease never released), a drained ingest-urls run cancelled in GitHub's queue
 * or failed, an entry marked already-in that never reached the site. `onSite(show, url)` says whether reviews.json has it.
 * Shows a lease still holds are left alone (the lane, or the night job's own drain, handles them).
 */
function sweepPlan(state, { now = Date.now(), onSite, held }) {
  const byShow = new Map();
  const age = (t) => now - Date.parse(t || 0);
  for (const [id, e] of Object.entries((state && state.leases) || {})) {
    if (!e || e.holder !== inbox.HOLDER || inbox.isCorrection(e) || held(e.show)) continue;
    const entry = { id, ...e };
    const stillOpen = drainPlan([entry]).open.length > 0;
    const due = stillOpen ? age(e.addedAt) >= STALE_OPEN_MS
      : (e.status === 'drained' || e.status === 'already-in') && age(e.statusAt) >= RECHECK_MS
        && (e.drainCount || 0) < MAX_DRAINS && !onSite(e.show, e.url);
    if (!due) continue;
    if (!byShow.has(e.show)) byShow.set(e.show, []);
    byShow.get(e.show).push(entry);
  }
  return [...byShow.entries()].map(([show, open]) => ({ show, open, lines: ingestLines(open) }));
}

/** Pure: open corrections on shows no lease holds (the lane that could apply them is gone). */
function strandedCorrections(state, { held }) {
  return Object.entries((state && state.leases) || {}).map(([id, e]) => ({ id, ...e }))
    .filter((e) => e.holder === inbox.HOLDER && inbox.isCorrection(e) && (!e.status || e.status === 'queued') && !held(e.show));
}

/** The show's active lease on the remote store (any holder), {unknown:true} when the store cannot be read, else null. */
function liveLease(show, repoDir = REPO_DIR) { return require('./lib/lane-inbox-routing').liveLease(show, repoDir); }

/** Pure: drain may dispatch only when no lease (known or unknown) holds the show. */
function drainAllowed(lease) { return !lease; }

function drain() {
  const show = arg('show');
  if (!show) die('usage: drain --show=SHOW_ID [--dispatch]');
  const { open, lines } = drainPlan(inbox.entriesFor(inbox.readSync({ repoDir: REPO_DIR }), show));
  if (!open.length) { console.log(`Nothing to drain for ${show}.`); return; }
  console.log(`${open.length} inbox URL(s) the lane did not publish:\n${lines.join('\n')}`);
  if (!flag('dispatch')) { console.log('(dry run: pass --dispatch to send them to ingest-urls.yml)'); return; }
  // With the lease still held (release failed and only warned), ingest-urls would route these straight back into the
  // inbox, where an entry already marked drained counts as a duplicate and is dropped. Leave them waiting instead.
  // A live read of the lease store, never the job's local copy, and counting this run's own lease too (the night job
  // sets OPENING_NIGHT_LANE_HOLDER, which leaseSkipReason ignores, so a failed release of our own lease would pass).
  const held = liveLease(show);
  if (!drainAllowed(held)) {
    console.log(`::warning::lane inbox: ${show} is still held by the opening-night lane (${held.holder || 'unknown'}); ${open.length} URL(s) left waiting. Drain again once the lease is gone.`);
    process.exitCode = 3;
    return;
  }
  send(show, open, lines, 'sent to ingest-urls after the lane ended', { priority: true });
}

/**
 * Dispatch ingest-urls.yml through the bulk-workflow queue cap. The night job's drain is an opening-night dispatch
 * (priority, never deferred); the hourly sweep defers when the cap is full and leaves the entries for its next pass.
 */
function send(show, open, lines, reason, { priority = false } = {}) {
  const cap = require('./lib/workflow-queue-cap').checkCap({ workflow: 'ingest-urls.yml', priority });
  if (!cap.ok) { console.log(`::notice::lane inbox: ${show} deferred to the next sweep (${cap.reason})`); return false; }
  require('./lib/rest-dispatch').dispatch({ workflow: 'ingest-urls.yml', inputs: { show_id: show, urls: lines.join('\n'), caller: 'lane-inbox-drain' } });
  const res = inbox.markSync({ repoDir: REPO_DIR }, open.map((e) => ({ id: e.id, addedAt: e.addedAt, status: 'drained', reason })));
  if (!res.ok) console.log(`::warning::drained ${open.length} URL(s) to ingest-urls but the inbox status write failed (${res.reason}); a second drain would send them again`);
  console.log(`::notice::lane inbox: sent ${open.length} URL(s) for ${show} to ingest-urls.yml (${reason})`);
  return true;
}

/** Hourly (opening-night-checklist.yml): send on whatever the night's drain left behind (see sweepPlan). */
function sweep() {
  let urlsByShow = null;
  const onSite = (show, url) => {
    if (!urlsByShow) {
      urlsByShow = new Map();
      for (const r of require('../data/reviews.json').reviews || []) {
        const k = r && r.url && inbox.normalizeUrl(r.url);
        if (!k) continue;
        if (!urlsByShow.has(r.showId)) urlsByShow.set(r.showId, new Set());
        urlsByShow.get(r.showId).add(k);
      }
    }
    return !!(urlsByShow.get(show) && urlsByShow.get(show).has(inbox.normalizeUrl(url)));
  };
  const leases = new Map();
  const held = (show) => { if (!leases.has(show)) leases.set(show, liveLease(show)); return !!leases.get(show); };
  const state = inbox.readSync({ repoDir: REPO_DIR });
  // BRO-7891 item 2: a correction still open on a show no lane holds was never applied (added after the lane's last
  // read). It is not a URL to ingest: close it as rejected so `list` says so.
  const stale = strandedCorrections(state, { held });
  if (stale.length) {
    if (flag('dispatch')) {
      const res = inbox.markSync({ repoDir: REPO_DIR }, stale.map((e) => ({ id: e.id, addedAt: e.addedAt, status: 'rejected', reason: 'no lane applied it; fix it with new-fix-plan.js --review-edit' })));
      if (!res.ok) console.log(`::warning::lane inbox: could not close ${stale.length} stranded correction(s) (${res.reason})`);
    }
    for (const e of stale) console.log(`::warning::lane inbox: correction ${e.field}=${JSON.stringify(e.value)} on ${e.url} (${e.show}) was never applied by a lane; fix it with new-fix-plan.js --review-edit`);
  }
  const plan = sweepPlan(state, { onSite, held });
  if (!plan.length) { console.log('Lane inbox sweep: nothing left behind.'); return; }
  for (const { show, open, lines } of plan) {
    console.log(`${show}: ${open.length} inbox URL(s) left behind:\n${lines.join('\n')}`);
    if (flag('dispatch')) send(show, open, lines, 'sent by the hourly sweep: left behind after the lane night');
  }
  if (!flag('dispatch')) console.log('(dry run: pass --dispatch to send them to ingest-urls.yml)');
}

if (require.main === module) {
  if (cmd === 'add') add();
  else if (cmd === 'correct') correct();
  else if (cmd === 'list') list();
  else if (cmd === 'drain') drain();
  else if (cmd === 'sweep') sweep();
  else die('usage: opening-night-lane-inbox.js add|correct|list|drain|sweep (see --help)');
}

module.exports = { parseValue, strandedCorrections, drainPlan, drainAllowed, liveLease, sweepPlan, STALE_OPEN_MS, RECHECK_MS, MAX_DRAINS };
