#!/usr/bin/env node
'use strict';

/**
 * land-train.js — BRO-5282's merge train, the I/O around scripts/lib/land-train.js.
 * land.yml's Land job runs it while it HOLDS the landing mutex:
 *
 *   node scripts/land-train.js collect --branch <land/x> --out <riders.json>
 *     Writes the queued landings that may ride with this one (JSON array of
 *     {branch, tip, base, runId, attempt}). Sources: the mutex queue tickets
 *     (git ls-remote + fetch of the ticket commits, whose trailers carry each
 *     run's verified tip and base), the land/** refs (git ls-remote), and one
 *     Actions API run lookup per candidate rider (is it still live?). Also
 *     deletes train markers no land/** ref needs any more. Always exits 0 and
 *     always writes the file: any error means `[]` (land alone).
 *
 *   node scripts/land-train.js mark --result-file <land-result.json>
 *     After a landing that carried riders: pushes refs/land-mutex/landed/<tip>
 *     → the rider's commit on main for each (their own Land runs read it and
 *     finish without the lock), and appends their data/audit/landings.jsonl
 *     rows (committed by land.yml's ledger step). Exits 0; a marker that will
 *     not push is a warning (that rider's own run lands it: rebased-to-empty).
 *
 *   node scripts/land-train.js unmark --tip <sha>
 *     A rider's own run, after it verified and deleted its land/** ref: drops
 *     that tip's marker (leased on the sha seen). Missing marker = no-op.
 *
 * Env: GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY, GH_TOKEN,
 * GH_FALLBACK_TOKEN, LAND_TRAIN_MAX (repo variable; < 2 = trains off),
 * LAND_RUN_URL (ledger rows). Test knobs: LAND_TRAIN_REMOTE (default origin),
 * LAND_TRAIN_NO_API=1 (treat every ticket as live; local race tests only).
 */

const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const t = require('./lib/land-train');
const m = require('./lib/land-mutex');

const USAGE = 'usage: node scripts/land-train.js collect --branch <land/x> --out <file> | mark --result-file <file> | unmark --tip <sha>';
const argv = process.argv.slice(2);
const cmd = argv[0];
if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
if (!['collect', 'mark', 'unmark'].includes(cmd)) { console.log(USAGE); process.exit(2); }
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };

const env = process.env;
const remote = env.LAND_TRAIN_REMOTE || 'origin';
const repo = env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const self = { runId: String(env.GITHUB_RUN_ID || '0'), attempt: Number(env.GITHUB_RUN_ATTEMPT || 1) };
const log = (s) => console.log(`land-train: ${s}`);

function git(args, timeout = 90000) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() };
}

function runLiveness(ticket) {
  if (env.LAND_TRAIN_NO_API === '1') return 'live';
  // No token (land.js forming a train from an older land.yml's Land step):
  // a ticket younger than the mutex deadline belongs to a waiting run.
  if (!env.GH_TOKEN && !env.GH_FALLBACK_TOKEN) return Date.now() - ticket.enqueuedAt < m.DEADLINE_MINUTES * 60000 ? 'live' : undefined;
  try {
    const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
    const run = JSON.parse(runGhWithFallback([`repos/${repo}/actions/runs/${ticket.runId}`], { exec: execFileSync, fallbackToken: env.GH_FALLBACK_TOKEN }));
    return m.ticketLiveness(ticket, run, { staleAgeMs: 0 }) === 'live' ? 'live' : 'gone';
  } catch (err) {
    log(`run ${ticket.runId} lookup failed (${String(err.message).split('\n')[0]})`);
    return undefined;
  }
}

function collect() {
  const out = arg('out');
  const branch = arg('branch') || env.LAND_BRANCH || '';
  const write = (riders) => { if (out) fs.writeFileSync(out, `${JSON.stringify(riders, null, 2)}\n`); };
  write([]);
  const max = t.trainMax(env);
  if (max < 2) { log(`trains off (LAND_TRAIN_MAX=${max})`); return; }

  const ls = git(['ls-remote', remote, 'refs/land-mutex/*', 'refs/heads/land/*']);
  if (!ls.ok) { log(`ls-remote failed (${ls.err.split('\n').pop()}); landing alone`); return; }
  const state = m.parseLsRemote(ls.out);
  const landTips = {};
  for (const line of ls.out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref && ref.startsWith('refs/heads/land/')) landTips[ref.slice('refs/heads/'.length)] = sha;
  }

  // Housekeeping: a marker no land/** ref needs, or one older than any live
  // rider could still be waiting on (a leak that would otherwise swallow a
  // re-land of the same tip), is removed.
  const markerAgeSec = {};
  for (const [tip, sha] of Object.entries(state.landed)) {
    const ct = git(['log', '-1', '--format=%ct', sha]);
    if (ct.ok && /^\d+$/.test(ct.out)) markerAgeSec[tip] = Date.now() / 1000 - Number(ct.out);
  }
  for (const tip of t.staleMarkers(state.landed, Object.values(landTips), markerAgeSec).slice(0, 20)) {
    const r = git(['push', '--no-verify', remote, `:${t.markerRef(tip)}`, `--force-with-lease=${t.markerRef(tip)}:${state.landed[tip]}`]);
    log(r.ok ? `pruned stale marker for ${tip.slice(0, 10)}` : `stale marker prune failed for ${tip.slice(0, 10)}`);
  }

  const others = state.tickets.filter((x) => !(x.runId === self.runId && x.attempt === self.attempt));
  if (!others.length) { log('no other landing is queued'); return; }
  // The ticket commits carry each run's verified tip/base (land-mutex.js).
  const f = git(['fetch', '--no-tags', '--quiet', remote, ...others.map((x) => `+${x.ref}:refs/land-train/${x.ref.split('/').pop()}`)]);
  if (!f.ok) log(`ticket fetch failed (${f.err.split('\n').pop()}); tickets without a readable commit are skipped`);
  const tickets = state.tickets.map((x) => {
    const msg = git(['log', '-1', '--format=%B', x.sha]);
    return { ...x, info: msg.ok ? t.parseTicketMessage(msg.out) : null };
  });
  for (const x of tickets) x.remoteTip = x.info ? (landTips[x.info.branch] || null) : null;

  // Liveness only for tickets that pass every free check, in queue order;
  // one that turns out not live frees its slot for the next (bounded rounds).
  const key = (x) => `${x.runId}-${x.attempt}`;
  const looked = new Map();
  let sel;
  for (let round = 0; round < 3; round += 1) {
    const assume = tickets.map((x) => ({ ...x, liveness: looked.has(key(x)) ? looked.get(key(x)) : 'live' }));
    const pre = t.selectRiders({ holderBranch: branch, self, tickets: assume, markers: state.landed, max });
    const todo = pre.riders.filter((r) => !looked.has(key(r)));
    if (!todo.length) break;
    for (const r of todo) looked.set(key(r), runLiveness(tickets.find((x) => key(x) === key(r))));
  }
  for (const x of tickets) x.liveness = looked.get(key(x));
  sel = t.selectRiders({ holderBranch: branch, self, tickets, markers: state.landed, max });
  for (const s of sel.skipped) log(`skip ${s.ref}: ${s.reason}`);
  log(`${sel.reason}${sel.riders.length ? `: ${sel.riders.map((r) => `${r.branch}@${r.tip.slice(0, 10)}`).join(', ')}` : ''}`);
  write(sel.riders);
}

function mark() {
  const file = arg('result-file');
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { log(`no result to mark (${err.message})`); return; }
  const riders = (result && result.landed && Array.isArray(result.riders)) ? result.riders : [];
  if (!riders.length) { log('no riders landed'); return; }
  let appendLanding = null;
  try { ({ appendLanding } = require('./lib/landings-ledger.js')); } catch { /* best effort */ }
  for (const r of riders) {
    if (!r.sha) { log(`${r.branch}: landed in ${String(result.pushedSha || '').slice(0, 10)} but no per-branch commit is known; its own run confirms it`); continue; }
    const ref = t.markerRef(r.tip);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i += 1) {
      const p = git(['push', '--no-verify', remote, `${r.sha}:${ref}`, `--force-with-lease=${ref}:`]);
      ok = p.ok || git(['ls-remote', remote, ref]).out.startsWith(r.sha);
      if (!ok) { log(`marker push for ${r.branch} failed (${p.err.split('\n').pop()}), retrying`); spawnSync('sleep', [String(2 * (i + 1))]); }
    }
    console.log(ok ? `land-train: marked ${r.branch} @ ${r.tip.slice(0, 10)} landed as ${r.sha.slice(0, 10)}` : `::warning::land-train: could not mark ${r.branch} landed; its own run will confirm it by rebasing to empty (and record it)`);
    if (ok && appendLanding) {
      try {
        appendLanding({ repoDir: process.cwd(), branch: r.branch, sha: r.sha, tip: r.tip, base: r.base || null, runUrl: env.LAND_RUN_URL || (env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null), attempts: result.attempts });
      } catch (err) { log(`landings.jsonl row for ${r.branch} not written (${err.message})`); }
    }
  }
}

function unmark() {
  const tip = arg('tip');
  const ref = t.markerRef(tip);
  const seen = git(['ls-remote', remote, ref]);
  const sha = seen.ok ? t.parseMarkers(seen.out)[tip] : null;
  if (!sha) { log(`no train marker for ${tip.slice(0, 10)}`); return; }
  const r = git(['push', '--no-verify', remote, `:${ref}`, `--force-with-lease=${ref}:${sha}`]);
  console.log(r.ok ? `land-train: removed the train marker for ${tip.slice(0, 10)}` : `::warning::land-train: train marker for ${tip.slice(0, 10)} not removed (the next train prunes it)`);
}

try {
  if (cmd === 'collect') collect(); else if (cmd === 'mark') mark(); else unmark();
} catch (err) {
  console.log(`::warning::land-train ${cmd} failed (${String(err.message).split('\n')[0]}); landing continues without the train`);
}
process.exit(0);
