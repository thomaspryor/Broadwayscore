'use strict';

/**
 * Read scheduled runs for the health monitor. The unfiltered first page can
 * contain only manual dispatches, concealing a cron that stopped months ago.
 * Missing/malformed responses stay unknown so they cannot clear an alert.
 */
function loadRuns(sources, failed, { repo, api = require('./github-public-api').ghApiJson } = {}) {
  const out = {};
  const workflows = new Set(sources.filter(s => !s.retired).flatMap(s => Object.keys(s.workflows)));
  for (const wf of workflows) {
    try {
      const body = api(`repos/${repo}/actions/workflows/${wf}/runs?event=schedule&per_page=30`);
      if (!Array.isArray(body?.workflow_runs)) throw new Error('workflow_runs is not an array');
      out[wf] = body.workflow_runs.map(r => ({ created_at: r.created_at, conclusion: r.conclusion, event: r.event }));
    } catch { failed.push(wf); }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { loadRuns };
