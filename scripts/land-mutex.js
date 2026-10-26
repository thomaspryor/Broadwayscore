#!/usr/bin/env node
'use strict';

/**
 * land-mutex.js — the FIFO landing mutex around land.js's fast-forward
 * (BRO-5112). land.yml's Land job and autonomous-merge.yml call it:
 *
 *   node scripts/land-mutex.js acquire   wait in the queue, take the lock
 *   node scripts/land-mutex.js release   drop our lock + ticket (if: always())
 *
 * Both always exit 0. acquire prints `held=true` to $GITHUB_OUTPUT once it
 * holds the lock, `held=false` when it fails OPEN (deadline, unreachable
 * remote, or a remote that refuses the refs): land.js's single non-force
 * fast-forward is still rejected by git if main moved, so an unlocked landing
 * is the old race, never a bad push.
 *
 * Env: LAND_MUTEX_DISABLED=true (kill switch: fail open at once), GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY, LAND_BRANCH (a
 * main-red branch queues first), LAND_TIP / LAND_BASE (BRO-5282: the tip and
 * base this run's checks verified, written into the ticket commit so a merge
 * train can carry this landing; a marker for LAND_TIP ends the wait with
 * `train_landed=true`), GH_TOKEN / GH_FALLBACK_TOKEN (holder
 * liveness lookups). Test knobs: LAND_MUTEX_REMOTE (default origin),
 * LAND_MUTEX_NO_API=1 (age-only liveness), LAND_MUTEX_DEADLINE_MIN,
 * LAND_MUTEX_POLL_SCALE (multiplies poll delays), LAND_MUTEX_GRACE_MS.
 * Decisions: scripts/lib/land-mutex.js.
 */

const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const m = require('./lib/land-mutex');

const USAGE = 'usage: node scripts/land-mutex.js acquire|release';
const cmd = process.argv[2];
if (hasHelpFlag(process.argv.slice(2)) || !['acquire', 'release'].includes(cmd)) {
  console.log(USAGE);
  process.exit(cmd ? (hasHelpFlag(process.argv.slice(2)) ? 0 : 2) : 2);
}

const env = process.env;
const remote = env.LAND_MUTEX_REMOTE || 'origin';
const self = { runId: String(env.GITHUB_RUN_ID || '0'), attempt: Number(env.GITHUB_RUN_ATTEMPT || 1), tip: /^[0-9a-f]{40}$/.test(env.LAND_TIP || '') ? env.LAND_TIP : null };
const branch = env.LAND_BRANCH || env.GITHUB_REF_NAME || '';
const repo = env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const pollScale = Number(env.LAND_MUTEX_POLL_SCALE || 1);
const graceMs = Number(env.LAND_MUTEX_GRACE_MS || m.GRACE_MS);
const deadlineMin = Number(env.LAND_MUTEX_DEADLINE_MIN || m.DEADLINE_MINUTES);
const log = (s) => console.log(`land-mutex[${self.runId}.${self.attempt}]: ${s}`);
const output = (kv) => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${kv}\n`); };
const sleep = (ms) => execFileSync('sleep', [String(Math.max(0.2, ms / 1000))]);

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function lsRemote() {
  for (let i = 0; i < 3; i += 1) {
    const r = git(['ls-remote', remote, 'refs/land-mutex/*']);
    if (r.ok) return m.parseLsRemote(r.out);
    log(`ls-remote failed (${r.out.split('\n').pop()}), retrying`);
    sleep(3000 * (i + 1));
  }
  return null;
}

// --no-verify: CI's npm ci installs scripts/hooks/pre-push, which has no
// business with these refs. The lease makes each push a compare-and-swap.
const pushLeased = (src, ref, expect) => git(['push', '--no-verify', remote, `${src}:${ref}`, `--force-with-lease=${ref}:${expect}`]);

function newTicketCommit() {
  const tree = git(['hash-object', '-t', 'tree', '-w', '/dev/null']).out;
  const { ticketTrailers } = require('./lib/land-train');
  const trailers = ticketTrailers({ branch, tip: self.tip, base: env.LAND_BASE });
  const msg = `land-mutex ticket run ${self.runId} attempt ${self.attempt} ${branch} ${new Date().toISOString()}${trailers.length ? `\n\n${trailers.join('\n')}` : ''}`;
  const r = spawnSync('git', ['commit-tree', tree, '-m', msg], {
    encoding: 'utf8',
    env: { ...env, GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com' },
  });
  if (r.status !== 0) throw new Error(`commit-tree failed: ${r.stderr}`);
  return r.stdout.trim();
}

function fetchRun(runId) {
  if (env.LAND_MUTEX_NO_API === '1') return null;
  const { runGhWithFallback, isRefNotFound } = require('./lib/land-retry-on-cancel');
  try {
    return JSON.parse(runGhWithFallback([`repos/${repo}/actions/runs/${runId}`], { exec: execFileSync, fallbackToken: env.GH_FALLBACK_TOKEN }));
  } catch (err) {
    if (isRefNotFound(err)) return { status: 'missing' };
    log(`run ${runId} lookup failed (${String(err.message).split('\n')[0]}); age rule only`);
    return null;
  }
}

function deleteOwn(state) {
  if (!state) return;
  for (const t of m.ownTickets(state, self)) {
    if (state.lock && state.lock.sha === t.sha) {
      const r = pushLeased('', m.LOCK_REF, t.sha);
      log(r.ok ? 'lock released' : `lock release failed: ${r.out.split('\n').pop()}`);
    }
    const r = pushLeased('', t.ref, t.sha);
    log(r.ok ? `ticket ${t.ref} removed` : `ticket removal failed: ${r.out.split('\n').pop()}`);
  }
}

function failOpen(why, state) {
  console.log(`::warning::land-mutex: proceeding WITHOUT the landing lock (${why}); land.js's fast-forward push still refuses a moved main`);
  try { deleteOwn(state || lsRemote()); } catch { /* best effort */ }
  output('held=false');
  process.exit(0);
}

// BRO-5282: a Land run on a workflow file older than the train passes no
// LAND_TIP; its push-event head_sha is the tip, while the land ref still
// points there. Lets older branches ride (and finish from) merge trains.
function deriveTip() {
  if (self.tip || !branch || env.GITHUB_EVENT_NAME !== 'push') return;
  const run = env.LAND_MUTEX_TEST_RUN ? JSON.parse(env.LAND_MUTEX_TEST_RUN) : fetchRun(self.runId);
  const ref = git(['ls-remote', remote, `refs/heads/${branch}`]);
  const refSha = ref.ok ? (ref.out.split(/\s+/)[0] || null) : null;
  const tip = require('./lib/land-train').tipFromRun({ event: run && run.event, headSha: run && run.head_sha, refSha });
  if (tip) { self.tip = tip; log(`verified tip ${tip.slice(0, 10)} from the run (no LAND_TIP)`); }
}

function acquire() {
  if (env.LAND_MUTEX_DISABLED === 'true') failOpen('LAND_MUTEX_DISABLED=true');
  try { deriveTip(); } catch { /* no tip: no train for this run, the old behavior */ }
  const { isMainRedBranch } = require('./lib/land-main-red');
  const deadline = Date.now() + deadlineMin * 60000;
  const cache = new Map(); // ticket ref → {v, at}
  const liveness = (ref) => {
    const c = cache.get(ref);
    return c && Date.now() - c.at < m.LIVENESS_TTL_MS ? c.v : undefined;
  };
  let stuck = null;
  let poll = 0;
  let enqueueTries = 0;
  let lastWait = '';
  for (;;) {
    const state = lsRemote();
    if (!state) failOpen('ls-remote kept failing');
    const d = m.decideStep({ state, self, liveness, stuck, graceMs });
    const ref = m.blockerRef(d);
    stuck = ref ? (stuck && stuck.ref === ref ? stuck : { ref, since: Date.now() }) : null;
    if (d.action === 'train-landed') {
      log(`a merge train already landed ${self.tip.slice(0, 10)} as ${d.sha.slice(0, 10)}: leaving the queue without the lock`);
      deleteOwn(state);
      output('held=false');
      output('train_landed=true');
      return;
    }
    if (d.action === 'held') {
      log(`holding the landing lock (${d.ticket.ref})`);
      output('held=true');
      return;
    }
    if (Date.now() > deadline) failOpen(`${deadlineMin}m deadline`, state);
    if (d.action === 'enqueue') {
      if (enqueueTries >= 3) failOpen('the remote refused the queue ticket 3 times', state);
      enqueueTries += 1;
      const ticket = m.ticketName({ mainRed: isMainRedBranch(branch), enqueuedAt: Date.now(), runId: self.runId, attempt: self.attempt });
      const r = pushLeased(newTicketCommit(), ticket, '');
      log(r.ok ? `queued as ${ticket}` : `ticket push failed: ${r.out.split('\n').pop()}`);
      if (!r.ok) sleep(2000 * enqueueTries);
      continue;
    }
    enqueueTries = 0;
    if (d.action === 'acquire') {
      const r = pushLeased(d.ticket.sha, m.LOCK_REF, '');
      if (!r.ok) { log('lock push lost (someone else took it); re-reading'); sleep(1000); }
      continue;
    }
    if (d.action === 'check') {
      const v = m.ticketLiveness(d.ticket, fetchRun(d.ticket.runId));
      cache.set(d.ticket.ref, { v, at: Date.now() });
      log(`${d.ticket.ref} looked up: ${v}`);
      continue;
    }
    if (d.action === 'break-lock') {
      const r = pushLeased('', m.LOCK_REF, d.sha);
      log(r.ok ? `broke stale lock ${d.sha.slice(0, 10)} (${d.reason})` : 'stale-lock break lost the race; re-reading');
      stuck = null;
      sleep(1000);
      continue;
    }
    if (d.action === 'drop-ticket') {
      const r = pushLeased('', d.ticket.ref, d.ticket.sha);
      log(r.ok ? `dropped stale ticket ${d.ticket.ref}` : `stale ticket drop failed: ${r.out.split('\n').pop()}`);
      cache.delete(d.ticket.ref);
      stuck = null;
      sleep(1000);
      continue;
    }
    // wait
    const ahead = state.tickets.findIndex((t) => t.runId === self.runId && t.attempt === self.attempt);
    const line = `waiting (${d.reason}) behind ${d.blocker.ref}; ${ahead} ticket(s) ahead`;
    if (line !== lastWait) { log(line); lastWait = line; }
    sleep(m.nextPollMs(poll) * pollScale);
    poll += 1;
  }
}

function release() {
  try {
    const state = lsRemote();
    if (!state) { console.log('::warning::land-mutex release: ls-remote failed; a stale lock is broken by the next waiter'); return; }
    if (!m.ownTickets(state, self).length) { log('nothing to release'); return; }
    deleteOwn(state);
  } catch (err) {
    console.log(`::warning::land-mutex release failed (${String(err.message).split('\n')[0]}); a stale lock is broken by the next waiter`);
  }
}

if (cmd === 'acquire') {
  try { acquire(); } catch (err) { failOpen(`error: ${String(err.message).split('\n')[0]}`); }
} else release();
