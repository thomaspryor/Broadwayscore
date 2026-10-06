#!/usr/bin/env node
/**
 * Opening-night automation freeze (BRO-934). Logic: scripts/lib/automation-freeze.js.
 *
 *   node scripts/automation-freeze.js freeze   [--hours=8] [--dry-run] [--ledger=PATH]
 *   node scripts/automation-freeze.js unfreeze [--dry-run] --ledger=PATH
 *   node scripts/automation-freeze.js auto     [--dry-run] --ledger=PATH   (unfreeze only if expired)
 *
 * Needs GH_TOKEN with actions:write and GITHUB_REPOSITORY (owner/repo). --dry-run prints the
 * plan and touches nothing (the default when run outside Actions). Runbook:
 * memory/opening-night-freeze-runbook.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadWorkflows } = require('./lib/workflow-dependency-graph.js');
const lib = require('./lib/automation-freeze.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const flag = (n) => process.argv.includes(`--${n}`);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function workflowStates(repo) {
  const out = gh(['api', `repos/${repo}/actions/workflows`, '--paginate', '--jq', '.workflows[] | "\\(.path)\\t\\(.state)"']);
  return new Map(out.split('\n').filter(Boolean).map((l) => {
    const [p, st] = l.split('\t');
    return [path.basename(p), st];
  }));
}

function setState(repo, file, verb) {
  gh(['api', '-X', 'PUT', `repos/${repo}/actions/workflows/${file}/${verb}`]);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('usage: automation-freeze.js freeze|unfreeze|auto [--hours=N] [--dry-run] [--ledger=PATH]');
    return;
  }
  const mode = process.argv[2];
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const dry = flag('dry-run') || !process.env.GITHUB_ACTIONS;
  const ledgerPath = arg('ledger', '');
  const now = new Date();

  if (mode === 'freeze') {
    const workflows = loadWorkflows(path.join(ROOT, '.github', 'workflows'));
    const critical = lib.parseCriticalCrons(fs.readFileSync(path.join(ROOT, '.github/workflows/check-cron-health.yml'), 'utf8'));
    const states = dry && !process.env.GITHUB_ACTIONS ? null : workflowStates(repo);
    const { targets, skipped } = lib.planFreeze(workflows, critical, states);
    const hours = lib.clampHours(arg('hours', 8));
    console.log(`freeze: ${targets.length} workflows to disable for ${hours}h, ${skipped.length} protected/skipped${dry ? ' (DRY RUN)' : ''}`);
    // Ledger is rewritten after EVERY successful disable, and a failing disable is recorded and
    // skipped (not thrown), so a mid-run failure never leaves workflows disabled with no record.
    const disabled = [];
    const failed = [];
    const save = () => {
      if (ledgerPath) fs.writeFileSync(ledgerPath, JSON.stringify(lib.buildLedger({ disabled, hours, now, by: process.env.GITHUB_ACTOR }), null, 2));
    };
    save();
    for (const f of targets) {
      try {
        if (!dry) setState(repo, f, 'disable');
        disabled.push(f);
        save();
        console.log(`  disable ${f}`);
      } catch (e) {
        failed.push(f);
        console.error(`  FAILED to disable ${f}: ${String(e.message).split('\n')[0]}`);
      }
    }
    const ledger = lib.buildLedger({ disabled, hours, now, by: process.env.GITHUB_ACTOR });
    if (failed.length) process.exitCode = 1;
    console.log(`expires ${ledger.expiresAt}`);
    return;
  }

  if (mode === 'unfreeze' || mode === 'auto') {
    const ledger = ledgerPath && fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null;
    const plan = lib.planUnfreeze(ledger, { now, auto: mode === 'auto' });
    console.log(`${mode}: ${plan.enable.length} to re-enable (${plan.reason})${dry ? ' (DRY RUN)' : ''}`);
    const stillDisabled = [];
    for (const f of plan.enable) {
      try {
        if (!dry) setState(repo, f, 'enable');
        console.log(`  enable ${f}`);
      } catch (e) {
        stillDisabled.push(f);
        console.error(`  FAILED to enable ${f}: ${String(e.message).split('\n')[0]}`);
      }
    }
    if (ledger && plan.enable.length && ledgerPath && !dry) {
      // Failed re-enables stay in the ledger as still frozen so the next run retries them.
      const next = stillDisabled.length
        ? { ...ledger, disabled: stillDisabled }
        : { ...ledger, status: 'released', releasedAt: now.toISOString() };
      fs.writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
    }
    if (stillDisabled.length) process.exitCode = 1;
    return;
  }
  console.error('usage: automation-freeze.js freeze|unfreeze|auto [--hours=N] [--dry-run] [--ledger=PATH]');
  process.exit(2);
}

if (require.main === module) main();
