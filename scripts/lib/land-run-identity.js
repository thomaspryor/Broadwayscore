'use strict';

// workflow_dispatch describes the workflow ref (usually main), not the land
// input. Resolve BOTH the branch and the pre-rebase tip from Checks instead.
// Never substitute today's ref tip: that would replay Checks for a moved ref.
//
// BRO-6257 (BRO-6040 recurrence): a Checks log can be tens of MB (gh's
// maxBuffer is 64 MB). Splitting it into a line array and mapping every line
// OOMed wait-for-land.js in Runtime_StringSplit. Walk it one line at a time
// and stop once the answer is known: both markers sit near the top of the log.
const { forEachLine, detach } = require('./log-lines');

function landIdentityFromChecks(log) {
  let branch = null;
  let afterCheckout = false; // the previous line was the first checkout command
  let sha; // undefined until the first checkout line's successor is read
  forEachLine(log, (raw, _n, truncated) => {
    // Marker lines are short: a truncated line must never match a cut-off value.
    const line = truncated ? '' : raw
      .replace(/^\uFEFF?\S*Z\s?/, '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\r$/, '');
    if (afterCheckout) {
      sha = /^[a-f0-9]{40}$/.test(line) ? line : null;
      afterCheckout = false;
      if (sha === null) return true; // the first checkout decides: no full SHA, no identity
    } else if (sha === undefined && /^\[command\].*\/git log -1 --format=%H$/.test(line)) {
      afterCheckout = true;
    }
    if (!branch) branch = /^  BRANCH: (land\/[\w./-]+)$/.exec(line)?.[1] || null;
    return Boolean(branch && sha);
  }, { maxLineLength: 4096 });
  // detach: the cached identity must not pin the whole log in memory.
  return branch && sha ? { branch: detach(branch), sha: detach(sha) } : null;
}

// BRO-6012: land.yml's run-name carries the branch for a hand dispatch, so an
// unfinished run is followable before Checks has readable logs. The verified
// tip is unknown (head_sha null): nothing may retry or compare it.
function pendingIdentity(run) {
  if (run.status === 'completed') return null;
  const named = /^Land (land\/[\w./-]+)$/.exec(run.display_title || '');
  return named ? { ...run, head_branch: named[1], head_sha: null, identityPending: true } : null;
}

function resolveLandRun(run, { repo, read, readText, cache = new Map() }) {
  if (!run || run.event !== 'workflow_dispatch') return run;
  const key = `dispatch:${run.id}:${run.run_attempt}:${run.updated_at}`;
  if (cache.has(key)) {
    const identity = cache.get(key);
    return { ...run, head_branch: identity.branch, head_sha: identity.sha };
  }
  const jobs = read(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs || [];
  const checks = jobs.find((job) => job.name === 'Checks');
  // Individual job logs become readable once Checks completes, even while
  // Land is still queued, running or parked. Retry later if not available yet.
  if (!checks || !checks.conclusion) return pendingIdentity(run);
  const logKey = `checks:${checks.id}`;
  let identity = cache.get(logKey);
  if (!identity) {
    let log;
    try { log = readText(`repos/${repo}/actions/jobs/${checks.id}/logs`); }
    catch (err) {
      if (/\bHTTP 404\b/.test([err.stderr, err.message].join('\n'))) return pendingIdentity(run);
      throw err;
    }
    identity = landIdentityFromChecks(log);
    if (!identity) return pendingIdentity(run);
    cache.set(logKey, identity);
  }
  const resolved = { ...run, head_branch: identity.branch, head_sha: identity.sha };
  cache.set(key, identity);
  return resolved;
}

// Select by creation, not updated_at: rerunning an old push must not hide a
// newer hand dispatch. Page dispatches until older than the push (bounded).
function readLatestLandRun(ref, options) {
  const { repo, read } = options;
  let latest = read(`repos/${repo}/actions/workflows/land.yml/runs?branch=${encodeURIComponent(ref)}&event=push&per_page=1`).workflow_runs?.[0] || null;
  for (let page = 1; page <= 3; page += 1) {
    const runs = read(`repos/${repo}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`).workflow_runs || [];
    for (const run of runs) {
      if (latest && Date.parse(run.created_at) < Date.parse(latest.created_at)) return latest;
      const resolved = resolveLandRun(run, options);
      if (resolved?.head_branch === ref && (!latest || Number(resolved.id) > Number(latest.id))) latest = resolved;
    }
    if (runs.length < 100) break;
  }
  return latest;
}

module.exports = { landIdentityFromChecks, resolveLandRun, readLatestLandRun };
