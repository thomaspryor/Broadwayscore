#!/usr/bin/env node
/**
 * linear-reclaim-abandoned.js — hand In Progress cards whose claiming session
 * died back to the board (BRO-5100). Runs hourly from land-retry-cancelled.yml
 * (`reclaim` job). Rules and their reasons: scripts/lib/linear-reclaim-abandoned.js.
 *
 * Usage: node scripts/linear-reclaim-abandoned.js [--dry-run] [--max=N]
 *
 * Fails closed: if the land/ refs can't be read, it exits 1 before any write.
 * Kill switch: LINEAR_RECLAIM_KILL_SWITCH=1 (repo variable).
 */

'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'usage: node scripts/linear-reclaim-abandoned.js [--dry-run] [--max=N]';
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

async function main() {
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
      tally[d.action === 'skip' ? `skip:${d.reason}` : d.action] = (tally[d.action === 'skip' ? `skip:${d.reason}` : d.action] || 0) + 1;
      if (d.action === 'skip') { console.log(`${issue.identifier}: keep (${d.reason})`); continue; }
      const target = d.action === 'backlog' ? 'Backlog' : 'Todo';
      moved += 1;
      if (dry) { console.log(`dry-run: would move ${issue.identifier} (${d.idleHours}h idle, ${d.reclaims} prior reclaims) to ${target}: ${issue.title.slice(0, 80)}`); continue; }
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
  if (tally.error && !tally.todo && !tally.backlog) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[linear-reclaim-abandoned] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
