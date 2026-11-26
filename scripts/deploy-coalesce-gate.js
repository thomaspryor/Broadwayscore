#!/usr/bin/env node
'use strict';
// BRO-7983: runs in the deploy job right before 'Deploy to Production' (own Build succeeded).
// Cancels older deploy runs still before their deploy step; this run supersedes them. Fail-open: any error => cancel nothing, exit 0.
// BRO-8236: also decides whether THIS routine run was overtaken by another deploy
// (redundantRoutineDeploy in lib/deploy-coalesce.js) and writes redundant=true|false
// to GITHUB_OUTPUT; the workflow's next step then stops the run. Errors => redundant=false.
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_REF_NAME, COALESCE_DRY_RUN=1 (log only),
//   GATE_URGENT, GATE_REASON, GATE_BASELINE_URL, GATE_BASELINE_CREATED_MS (should-deploy outputs),
//   VERCEL_TOKEN, REDUNDANT_STOP_DISABLED=true (kill switch: never redundant).
const { execFileSync } = require('child_process');
const fs = require('fs');
const { decide, redundantRoutineDeploy } = require('./lib/deploy-coalesce.js');
require('./lib/cli-help').exitOnHelp(module);

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 30000 });
const api = (p) => JSON.parse(gh(['api', p]));
const MAX_JOB_LOOKUPS = 40;
const PROJECT_ID = 'prj_wmBnDUrCQCwabIAYPbnMiIP3wg15';
const TEAM_ID = 'team_zvgatcxkXdPbfhtHQMOnjpXo';

function setOutput(line) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  else console.log(line);
}

// Production deployments created since the gate's baseline (any state; the pure rule filters).
async function deploymentsSince(sinceMs) {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !Number.isFinite(sinceMs) || sinceMs <= 0) return null;
  const url = `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&target=production&limit=20&since=${Math.floor(sinceMs - 5000)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Vercel API ${res.status}`);
  return (await res.json()).deployments || [];
}

async function main() {
  let runs = [];
  const jobsByRun = {};
  const repo = process.env.GITHUB_REPOSITORY;
  const selfRunId = Number(process.env.GITHUB_RUN_ID);
  try {
    for (const status of ['queued', 'in_progress']) {
      runs.push(...api(`repos/${repo}/actions/workflows/vercel-deploy.yml/runs?status=${status}&per_page=50`).workflow_runs);
    }
    // Pre-warm runs are never cancelled (decide() skips them) but can be uploading, so their jobs are read too.
    const older = runs.filter((r) => r.id < selfRunId).slice(0, MAX_JOB_LOOKUPS);
    for (const r of older) jobsByRun[r.id] = api(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=30`).jobs;
    const d = decide({ selfRunId, selfBranch: process.env.GITHUB_REF_NAME, runs, jobsByRun });
    console.log(`[coalesce] self=${selfRunId} cancel=[${d.cancel}] kept=${JSON.stringify(d.kept)}`);
    for (const id of d.cancel) {
      if (process.env.COALESCE_DRY_RUN) continue;
      try { gh(['run', 'cancel', String(id), '--repo', repo]); console.log(`[coalesce] cancelled superseded run ${id}`); }
      catch (e) { console.log(`::warning::[coalesce] cancel ${id} failed: ${String(e.message).split('\n')[0]}`); }
    }
  } catch (e) {
    console.log(`::warning::[coalesce] fail-open, nothing cancelled: ${String(e.message).split('\n')[0]}`);
    runs = null; // run data unknown: the uploading check must not act on a partial list
  }

  let verdict = { stop: false, why: 'disabled' };
  if (process.env.REDUNDANT_STOP_DISABLED !== 'true') {
    const baselineCreatedMs = Number(process.env.GATE_BASELINE_CREATED_MS);
    let deployments = null;
    try { deployments = await deploymentsSince(baselineCreatedMs); }
    catch (e) { console.log(`::warning::[redundant] Vercel lookup failed (${String(e.message).split('\n')[0]}), newer-deployment check skipped`); }
    verdict = redundantRoutineDeploy({
      urgent: process.env.GATE_URGENT,
      reason: process.env.GATE_REASON,
      selfRunId,
      runs: runs || [],
      jobsByRun,
      deployments,
      baselineUrl: process.env.GATE_BASELINE_URL,
      baselineCreatedMs,
    });
  }
  console.log(`::notice::[redundant] stop=${verdict.stop} (${verdict.why}) urgent=${process.env.GATE_URGENT || '-'} reason=${process.env.GATE_REASON || '-'}`);
  setOutput(`redundant=${verdict.stop}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.log(`::warning::[coalesce] crashed, fail-open: ${String(e.message).split('\n')[0]}`);
    setOutput('redundant=false');
  });
}
