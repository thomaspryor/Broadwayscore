#!/usr/bin/env node
/**
 * rebuild-in-flight — how many runs of the given workflows are queued or in
 * progress right now, in 2 GitHub API calls total.
 *
 * WHY (BRO-4654): the opening-night crons (completeness every 15 min, drift
 * every 30 min) asked this with four `gh run list --workflow=X --status=Y`
 * calls. Each of those is 2 REST calls (workflow lookup, then runs), so 8
 * calls per tick on the shared 1,000/hour GITHUB_TOKEN quota. Listing the
 * repo's runs by status once and filtering by workflow path answers the same
 * question for any number of workflows in 2 calls.
 *
 * CLI: node scripts/lib/rebuild-in-flight.js rebuild-reviews.yml rebuild-fast.yml
 *   prints the count (an integer) on stdout and exits 0. On any API error it
 *   prints 0, matching the `|| echo "0"` fallback the workflows used before.
 *   Token from GH_TOKEN or GITHUB_TOKEN; repo from GITHUB_REPOSITORY.
 */
'use strict';

const PER_PAGE = 100;
const STATUSES = ['in_progress', 'queued'];

/**
 * Pure: count runs (across the per-status payloads) whose workflow file is in
 * `files`. A full page means more runs may exist past it; then at least 1 is
 * reported so the caller skips rather than racing a rebuild it couldn't see.
 */
function countActiveRuns(payloads, files, perPage = PER_PAGE) {
  const wanted = new Set(files.map((f) => f.replace(/^.*\//, '')));
  let count = 0;
  let saturated = false;
  for (const p of payloads) {
    const runs = (p && Array.isArray(p.workflow_runs)) ? p.workflow_runs : [];
    if (runs.length >= perPage) saturated = true;
    for (const r of runs) {
      const file = String((r && r.path) || '').replace(/@.*$/, '').replace(/^.*\//, '');
      if (wanted.has(file)) count++;
    }
  }
  return saturated ? Math.max(count, 1) : count;
}

async function fetchActiveRuns({ repo, token, fetchImpl = globalThis.fetch }) {
  const payloads = [];
  for (const status of STATUSES) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=${PER_PAGE}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscore-rebuild-in-flight' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} listing ${status} runs`);
    payloads.push(await res.json());
  }
  return payloads;
}

module.exports = { countActiveRuns, fetchActiveRuns, PER_PAGE };

if (require.main === module) {
  (async () => {
    const files = process.argv.slice(2);
    const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (files.length === 0) {
      console.error('usage: rebuild-in-flight.js <workflow.yml> [...]');
      process.exit(2);
    }
    try {
      if (!token) throw new Error('no GH_TOKEN/GITHUB_TOKEN');
      console.log(countActiveRuns(await fetchActiveRuns({ repo, token }), files));
    } catch (e) {
      console.error(`[rebuild-in-flight] ${e.message}; reporting 0`);
      console.log(0);
    }
  })();
}
