'use strict';
/**
 * rest-dispatch.js (BRO-5892): dispatch a workflow and wait for its run over the GitHub REST API only.
 * In cloud sessions `gh workflow run` without --ref fails ("unable to determine default branch ... GraphQL is
 * not available"), and the GitHub MCP tools cannot wait. `gh api` with GH_TOKEN works in both places.
 *
 * Finding the run: a dispatch returns no run id, so the run is the workflow_dispatch run that was not listed
 * just before the dispatch (`exclude`), was created since it, and whose display title contains `match` (give the workflow a run-name that carries an input). Without a
 * match, more than one candidate is ambiguous and is refused rather than guessed: two plans dispatched together
 * would otherwise each wait on the other's run.
 */
const { execFileSync } = require('child_process');

const DEFAULT_REPO = 'thomaspryor/Broadwayscore';
const CLOCK_SKEW_MS = 60 * 1000; // run created_at comes from GitHub's clock, `since` from ours

function ghApi(args, { input } = {}) {
  const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** POST a workflow_dispatch. inputs values are sent as strings, as GitHub requires. */
function dispatch({ workflow, inputs = {}, ref = 'main', repo = DEFAULT_REPO, api = ghApi }) {
  const body = { ref, inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])) };
  api(['-X', 'POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`, '--input', '-'], { input: JSON.stringify(body) });
}

/**
 * Which of `runs` is ours. Pure. Returns { run } | { ambiguous: [...runs] } | {} when none yet.
 */
function pickRun(runs, { since, match, exclude } = {}) {
  const sinceMs = since ? new Date(since).getTime() - CLOCK_SKEW_MS : 0;
  // `exclude` holds the runs that already existed before our dispatch: the skew window alone would
  // let another session's run from a few seconds earlier pass as ours.
  const fresh = (runs || []).filter((r) => r.event === 'workflow_dispatch' && new Date(r.created_at).getTime() >= sinceMs
    && !(exclude && exclude.has(r.id)));
  const hits = match ? fresh.filter((r) => String(r.display_title || r.name || '').includes(match)) : fresh;
  if (hits.length === 1) return { run: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return {};
}

const RUNS_PATH = (repo, workflow) => `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`;

/** Ids of the workflow's recent dispatch runs. Call before dispatch() and pass the set to findRun as `exclude`. */
function listRunIds({ workflow, repo = DEFAULT_REPO, api = ghApi }) {
  const data = api([RUNS_PATH(repo, workflow)]);
  return new Set(((data && data.workflow_runs) || []).map((r) => r.id));
}

const MAX_API_ERRORS = 5;

/**
 * Call api(args), but ride out a transient failure (5xx, rate limit, network) during a long wait:
 * returns undefined after an error, and throws only after MAX_API_ERRORS in a row.
 */
function tolerant(api, state) {
  return (args) => {
    try {
      const out = api(args);
      state.errors = 0;
      return out;
    } catch (e) {
      state.errors += 1;
      if (state.errors >= MAX_API_ERRORS) throw e;
      return undefined;
    }
  };
}

function findRun({ workflow, since, match, exclude, repo = DEFAULT_REPO, api = ghApi, timeoutMs = 3 * 60 * 1000, pollMs = 5000, wait = sleep, now = Date.now }) {
  const deadline = now() + timeoutMs;
  const call = tolerant(api, { errors: 0 });
  for (;;) {
    const data = call([RUNS_PATH(repo, workflow)]);
    const picked = pickRun(data && data.workflow_runs, { since, match, exclude });
    if (picked.run || picked.ambiguous) return picked;
    if (now() >= deadline) return {};
    wait(pollMs);
  }
}

/** Poll a run until it completes. Returns the run, or null on timeout. */
function waitRun({ runId, repo = DEFAULT_REPO, api = ghApi, timeoutMs = 60 * 60 * 1000, pollMs = 30000, wait = sleep, now = Date.now, onPoll = () => {} }) {
  const deadline = now() + timeoutMs;
  const call = tolerant(api, { errors: 0 });
  for (;;) {
    const run = call([`repos/${repo}/actions/runs/${runId}`]);
    if (run && run.status === 'completed') return run;
    if (run) onPoll(run);
    if (now() >= deadline) return null;
    wait(pollMs);
  }
}

module.exports = { dispatch, pickRun, listRunIds, findRun, waitRun, ghApi, DEFAULT_REPO, MAX_API_ERRORS };
