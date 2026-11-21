#!/usr/bin/env node
'use strict';
// BRO-7983: CLI for the should-deploy job. Appends proceed=/reason= to $GITHUB_OUTPUT.
// Fails open: any API error => proceed=true. Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { decide } = require('./lib/deploy-coalesce.js');

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30000 }));
}

function out(proceed, reason) {
  console.log(`[coalesce] proceed=${proceed} (${reason})`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${proceed}\nreason=${reason}\n`);
}

function main() {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const selfRunId = Number(process.env.GITHUB_RUN_ID);
    const selfSha = process.env.GITHUB_SHA;
    const runs = [];
    for (const status of ['queued', 'in_progress']) {
      runs.push(...gh(`repos/${repo}/actions/workflows/vercel-deploy.yml/runs?status=${status}&per_page=50`).workflow_runs);
    }
    const jobsByRun = {};
    for (const r of runs.filter((x) => x.id < selfRunId && x.head_sha === selfSha)) {
      jobsByRun[r.id] = gh(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=30`).jobs;
    }
    const d = decide({ selfRunId, selfSha, runs, jobsByRun });
    out(d.proceed, d.reason);
  } catch (e) {
    out(true, `fail-open: ${String(e.message).split('\n')[0]}`);
  }
}

if (require.main === module) main();
