#!/usr/bin/env node
/**
 * linear-reclaim-abandoned.js — hand In Progress cards whose claiming session
 * died back to the board (BRO-5100). Runs hourly from land-retry-cancelled.yml
 * (`reclaim` job). Rules and their reasons: scripts/lib/linear-reclaim-abandoned.js.
 *
 * Usage: node scripts/linear-reclaim-abandoned.js [--dry-run] [--max=N]
 *
 * Stalled-session sweep (BRO-7183, run by the board-workers routine, docs/cloud-routines/board-workers.md):
 *   --stalled-sessions [--threshold-hours=12]   JSON list of In Progress cards idle 12h+ held by a cloud session
 *   --stall-act --from-json=<file> [--dry-run]  file: [{card, session|error}] from get_session; requeues the
 *                                               gone ones, records nudges, prints [{card, action, sessionId, message}]
 *   Rules: scripts/lib/stalled-session-sweep.js. Kill switch: STALL_SWEEP_DISABLE=1.
 *
 * Fails closed: if the land/ refs can't be read, it exits 1 before any write.
 * Kill switch: LINEAR_RECLAIM_KILL_SWITCH=1 (repo variable).
 */

'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'usage: node scripts/linear-reclaim-abandoned.js [--dry-run] [--max=N] | --stalled-sessions [--threshold-hours=12] | --stall-act --from-json=<file> [--dry-run]';
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

require('./lib/load-env').loadEnv();

const dry = process.argv.includes('--dry-run');
const maxArg = (process.argv.find((a) => a.startsWith('--max=')) || '').slice('--max='.length);
if (maxArg && !(Number.isInteger(Number(maxArg)) && Number(maxArg) > 0)) { console.error(USAGE); process.exit(2); }
const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';

const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) { id identifier title description updatedAt state { name type } labels { nodes { name } }
    comments(first: 250) { nodes { body createdAt } } }
}`;

function gh(args) {
  const { runGhWithFallback } = require('./lib/land-retry-on-cancel');
  return JSON.parse(runGhWithFallback(args, { exec: execFileSync, fallbackToken: process.env.GH_FALLBACK_TOKEN }));
}

/** land/** ref name -> tip sha. Throws when GitHub can't be read (the caller stops). */
function landRefs() {
  return gh([`repos/${repo}/git/matching-refs/heads/land`])
    .filter((r) => r.ref.startsWith('refs/heads/land/'))
    .map((r) => ({ ref: r.ref.replace(/^refs\/heads\//, ''), sha: r.object.sha }));
}

/**
 * Later of the ref's latest Land run update and its tip commit date (a push after
 * the last run makes the ref live again), or null (counts as live) when neither reads.
 */
function lastActivityAt({ ref, sha }) {
  try {
    const run = (gh([`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(ref)}&per_page=1`]).workflow_runs || [])[0];
    const commit = gh([`repos/${repo}/commits/${sha}`]);
    const dates = [run && (run.updated_at || run.created_at), commit && commit.commit && commit.commit.committer && commit.commit.committer.date]
      .filter((d) => Number.isFinite(Date.parse(d)));
    return dates.length ? dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
  } catch (err) {
    console.log(`::warning::${ref}: age unknown (${String(err.message).split('\n')[0]}); treated as live`);
    return null;
  }
}

/** A dispatched Land run lists under main, not its ref, so while one is in flight a ref's state is unknowable. */
function dispatchInFlight() {
  const runs = gh([`repos/${repo}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=20`]).workflow_runs || [];
  return runs.some((r) => r.status !== 'completed');
}

function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return (process.argv.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
}

/** Fresh card + the land refs naming it -> stalled-session entry (or skip). */
async function stallEntry(linear, identifier, refs, nowMs, idleMs) {
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const { stalledSessionEntry } = require('./lib/stalled-session-sweep.js');
  const { issue } = await linear.graphql(ISSUE_QUERY, { id: identifier }, { timeoutMs: 15000, maxAttempts: 2 });
  if (!issue) return { issue: null, entry: { action: 'skip', reason: 'not-found' } };
  const n = Number(String(issue.identifier).split('-')[1]);
  const named = refs.filter((r) => landRefCardNumber(r.ref) === n).map((r) => ({ ref: r.ref, lastActivityAt: lastActivityAt(r) }));
  return { issue, entry: stalledSessionEntry({ issue, comments: issue.comments.nodes, landRefs: named, nowMs, idleMs }) };
}

async function stalledList() {
  const { STALL_IDLE_MS } = require('./lib/stalled-session-sweep.js');
  const linear = require('./lib/linear-client.js');
  const { findReclaimCandidates } = require('./lib/linear-reclaim-abandoned.js');
  const hours = Number(flagValue('--threshold-hours'));
  const idleMs = Number.isFinite(hours) && hours > 0 ? hours * 3600000 : STALL_IDLE_MS;
  const nowMs = Date.now();
  const issues = await linear.listOpenIssuesWithDescriptions();
  const candidates = findReclaimCandidates(issues, { nowMs, idleMs }).filter((i) => i.state.name === 'In Progress');
  const refs = candidates.length ? landRefs() : [];
  const out = [];
  const tally = {};
  for (const c of candidates) {
    try {
      const { entry } = await stallEntry(linear, c.identifier, refs, nowMs, idleMs);
      if (entry.action === 'check') out.push(entry);
      else tally[entry.reason] = (tally[entry.reason] || 0) + 1;
    } catch (err) {
      tally.error = (tally.error || 0) + 1;
      console.error(`${c.identifier}: could not read (${String(err.message).split('\n')[0]})`);
    }
  }
  console.error(`stalled-sessions: ${candidates.length} In Progress cards idle ${Math.round(idleMs / 3600000)}h+, ${out.length} held by a cloud session; skipped ${JSON.stringify(tally)}`);
  console.log(JSON.stringify(out, null, 1));
}

async function stallAct() {
  const fs = require('fs');
  const linear = require('./lib/linear-client.js');
  const S = require('./lib/stalled-session-sweep.js');
  const file = flagValue('--from-json');
  if (!file) { console.error(USAGE); process.exit(2); }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('--from-json must hold an array of {card, session|error}');
  const nowMs = Date.now();
  const refs = landRefs();
  const team = (await linear.getTeam()).states.nodes;
  const stateId = (name) => { const s = team.find((x) => x.name === name); if (!s) throw new Error(`no "${name}" state`); return s.id; };
  const results = [];
  let nudges = 0;
  let requeues = 0;
  for (const row of rows) {
    const card = row && row.card;
    try {
      // Re-read: the session may have woken (or someone closed the card) since the list.
      const { issue, entry } = await stallEntry(linear, card, refs, nowMs, S.STALL_IDLE_MS);
      if (entry.action !== 'check') { results.push({ card, action: 'skip', reason: entry.reason }); continue; }
      if (row.sessionId && row.sessionId !== entry.sessionId) { results.push({ card, action: 'skip', reason: 'claim changed since the list' }); continue; }
      const d = S.stalledSessionAction({ entry, session: row.session, error: row.error, nowMs });
      if (d.action === 'nudge' && nudges >= S.MAX_NUDGES_PER_RUN) { results.push({ card, action: 'skip', reason: 'nudge cap for this firing' }); continue; }
      if (d.action === 'requeue' && requeues >= S.MAX_REQUEUES_PER_RUN) { results.push({ card, action: 'skip', reason: 'requeue cap for this firing' }); continue; }
      if (d.action === 'skip') { results.push({ card, action: 'skip', reason: d.reason }); continue; }
      if (d.action === 'requeue') {
        requeues += 1;
        if (!dry) {
          // Move first, then comment: the comment carries the reclaim marker (same order as main()).
          await linear.updateIssue(issue.id, { stateId: stateId(entry.requeueTo) });
          await linear.createComment(issue.id, S.buildStallRequeueComment(entry, d.reason, nowMs));
        }
        results.push({ card, action: 'requeue', to: entry.requeueTo, sessionId: entry.sessionId, idleHours: entry.idleHours, reason: d.reason });
        continue;
      }
      nudges += 1;
      if (!dry) await linear.createComment(issue.id, S.buildStallNudgeComment(entry, nowMs));
      results.push({ card, action: 'nudge', sessionId: entry.sessionId, idleHours: entry.idleHours, reason: d.reason, message: S.buildStallNudgeMessage(entry) });
    } catch (err) {
      results.push({ card, action: 'error', reason: String(err.message).split('\n')[0] });
    }
  }
  if (dry) console.error('dry-run: nothing written');
  console.log(JSON.stringify(results, null, 1));
}

async function main() {
  if (process.argv.includes('--stalled-sessions') || process.argv.includes('--stall-act')) {
    if (/^(1|true)$/i.test(process.env.STALL_SWEEP_DISABLE || '')) { console.error('STALL_SWEEP_DISABLE set: stalled-session sweep disabled'); console.log('[]'); return; }
    if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY not set');
    return process.argv.includes('--stall-act') ? stallAct() : stalledList();
  }
  if (/^(1|true)$/i.test(process.env.LINEAR_RECLAIM_KILL_SWITCH || '')) { console.log('LINEAR_RECLAIM_KILL_SWITCH set: reclaim disabled'); return; }
  if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY not set');
  const linear = require('./lib/linear-client.js');
  const { landRefCardNumber } = require('./lib/cloud-worker-pick.js');
  const { findReclaimCandidates, reclaimDecision, buildReclaimComment, MAX_PER_RUN } = require('./lib/linear-reclaim-abandoned.js');

  const nowMs = Date.now();
  const issues = await linear.listOpenIssuesWithDescriptions();
  const started = issues.filter((i) => i.state && i.state.type === 'started').length;
  const maxMoves = Number(maxArg) || MAX_PER_RUN;
  const candidates = findReclaimCandidates(issues, { nowMs });
  console.log(`${issues.length} open cards, ${started} started, ${candidates.length} idle past the reclaim window`);
  if (!candidates.length) return;

  const refs = landRefs();
  const landDispatchLive = dispatchInFlight();
  let stateIds;
  const stateId = async (name) => {
    if (!stateIds) stateIds = new Map((await linear.getTeam()).states.nodes.map((s) => [s.name, s.id]));
    const id = stateIds.get(name);
    if (!id) throw new Error(`Linear team has no "${name}" state`);
    return id;
  };

  const tally = {};
  let moved = 0;
  for (const c of candidates) {
    if (moved >= maxMoves) { console.log(`move cap ${maxMoves} reached; the rest wait for the next pass`); break; }
    try {
      // Decide on a fresh read: a live session may have touched the card since the listing.
      const { issue } = await linear.graphql(ISSUE_QUERY, { id: c.identifier }, { timeoutMs: 15000, maxAttempts: 2 });
      if (!issue) { console.log(`${c.identifier}: not found`); continue; }
      const n = Number(String(issue.identifier).split('-')[1]);
      const namedRefs = refs.filter((r) => landRefCardNumber(r.ref) === n);
      if (namedRefs.length && landDispatchLive) { console.log(`${issue.identifier}: keep (land ref while a dispatched Land run is in flight)`); continue; }
      const named = namedRefs.map((r) => ({ ref: r.ref, lastActivityAt: lastActivityAt(r) }));
      const d = reclaimDecision({ issue, comments: issue.comments.nodes, landRefs: named, nowMs });
      const tallyKey = d.action === 'skip' ? `skip:${d.reason}` : (d.staleBlocked ? 'backlog:stale-blocked' : d.action);
      tally[tallyKey] = (tally[tallyKey] || 0) + 1;
      if (d.action === 'skip') { console.log(`${issue.identifier}: keep (${d.reason})`); continue; }
      const target = d.action === 'backlog' ? 'Backlog' : 'Todo';
      moved += 1;
      if (dry) { console.log(`dry-run: would move ${issue.identifier} (${d.idleHours}h idle, ${d.reclaims} prior reclaims${d.staleBlocked ? ', stale blocked report' : ''}) to ${target}: ${issue.title.slice(0, 80)}`); continue; }
      // Move first, then comment: the comment carries the reclaim marker, so a
      // failed move after a posted comment would count a reclaim that never happened.
      await linear.updateIssue(issue.id, { stateId: await stateId(target) });
      await linear.createComment(issue.id, buildReclaimComment(d, nowMs));
      console.log(`${issue.identifier}: reclaimed to ${target} (${d.idleHours}h idle, was ${issue.state.name}): ${issue.title.slice(0, 80)}`);
    } catch (err) {
      console.log(`::warning::${c.identifier}: could not reclaim (${String(err.message).split('\n')[0]}); the next pass retries`);
      tally.error = (tally.error || 0) + 1;
    }
  }
  console.log(`summary: ${JSON.stringify(tally)}`);
  // Every attempt failed (state missing, Linear refusing writes): fail the job so notify-failure fires.
  if (tally.error && !tally.todo && !tally.backlog && !tally['backlog:stale-blocked']) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[linear-reclaim-abandoned] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
