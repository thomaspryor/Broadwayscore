#!/usr/bin/env node
'use strict';
// BRO-7983: runs in the deploy job (after its gate said proceed). Cancels older pending
// deploy runs this run supersedes. Fail-open: any error => cancel nothing, exit 0.
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, COALESCE_DRY_RUN=1 (log only).
const { execFileSync } = require('child_process');
const { decide } = require('./lib/deploy-coalesce.js');

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 30000 });
const api = (p) => JSON.parse(gh(['api', p]));
const MAX_JOB_LOOKUPS = 40;

function main() {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const selfRunId = Number(process.env.GITHUB_RUN_ID);
    const runs = [];
    for (const status of ['queued', 'in_progress']) {
      runs.push(...api(`repos/${repo}/actions/workflows/vercel-deploy.yml/runs?status=${status}&per_page=50`).workflow_runs);
    }
    const older = runs.filter((r) => r.id < selfRunId && !String(r.display_title || '').includes('pre-warm')).slice(0, MAX_JOB_LOOKUPS);
    const jobsByRun = {};
    for (const r of older) jobsByRun[r.id] = api(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=30`).jobs;
    const d = decide({ selfRunId, runs, jobsByRun });
    console.log(`[coalesce] self=${selfRunId} cancel=[${d.cancel}] kept=${JSON.stringify(d.kept)}`);
    for (const id of d.cancel) {
      if (process.env.COALESCE_DRY_RUN) continue;
      try { gh(['run', 'cancel', String(id), '--repo', repo]); console.log(`[coalesce] cancelled superseded run ${id}`); }
      catch (e) { console.log(`::warning::[coalesce] cancel ${id} failed: ${String(e.message).split('\n')[0]}`); }
    }
  } catch (e) {
    console.log(`::warning::[coalesce] fail-open, nothing cancelled: ${String(e.message).split('\n')[0]}`);
  }
}

if (require.main === module) main();
