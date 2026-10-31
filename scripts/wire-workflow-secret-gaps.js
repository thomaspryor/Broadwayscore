#!/usr/bin/env node
/**
 * Codemod (BRO-5151): wire the secrets that scripts/audit-workflow-secret-gaps.js
 * reports as missing into each flagged step's env: block.
 *
 * Only the names passed in --secrets are wired, and only into workflows not
 * matched by --exclude (a regex on the file name), so a batch stays reviewable
 * and frozen workflows stay untouched. Text edit, not a YAML re-serialise:
 * comments and layout survive (scripts/lib/workflow-env-codemod.js).
 *
 * Usage:
 *   node scripts/wire-workflow-secret-gaps.js --secrets=LINEAR_API_KEY,RESEND_API_KEY \
 *     [--exclude='^(land|test)\.yml$'] [--max-steps=40] [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { findGaps } = require('./audit-workflow-secret-gaps.js');
const { addStepSecrets } = require('./lib/workflow-env-codemod.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const DRY_RUN_STEP_RE = /dry[ -]?run|simulat/i;

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/wire-workflow-secret-gaps.js --secrets=NAME[,NAME] [--exclude=REGEX] [--max-steps=40] [--dry-run]');
    return;
  }
  const secrets = new Set(String(arg('secrets', '')).split(',').map((s) => s.trim()).filter(Boolean));
  if (!secrets.size) {
    console.error('--secrets=NAME[,NAME] is required');
    process.exit(2);
  }
  const exclude = arg('exclude', '') ? new RegExp(arg('exclude')) : null;
  const maxSteps = Number(arg('max-steps', '40'));
  const dryRun = process.argv.includes('--dry-run');

  const gaps = findGaps(WF_DIR).filter((g) => secrets.has(g.secret) && !(exclude && exclude.test(g.workflow)));
  const byStep = new Map();
  for (const g of gaps) {
    const k = JSON.stringify([g.workflow, g.job, g.step]);
    if (!byStep.has(k)) byStep.set(k, new Set());
    byStep.get(k).add(g.secret);
  }

  let steps = 0;
  let wired = 0;
  const skipped = [];
  for (const [k, names] of byStep) {
    if (steps >= maxSteps) break;
    const [workflow, job, step] = JSON.parse(k);
    // A dry-run/simulate step is meant to have no live credentials (e.g.
    // account-metrics.yml's --simulate step: SEND_ALERTS off, no routeAlert).
    if (DRY_RUN_STEP_RE.test(step)) {
      skipped.push(`${workflow} :: ${job} :: ${step} — dry-run/simulate step, left unwired`);
      continue;
    }
    const file = path.join(WF_DIR, workflow);
    const res = addStepSecrets(fs.readFileSync(file, 'utf8'), job, step, [...names].sort());
    if (!res.ok) {
      skipped.push(`${workflow} :: ${job} :: ${step} — ${res.reason}`);
      continue;
    }
    if (!dryRun) fs.writeFileSync(file, res.raw);
    steps++;
    wired += res.added.length;
    console.log(`${dryRun ? '[dry] ' : ''}${workflow} :: ${step} += ${res.added.join(', ')}`);
  }
  console.log(`\n${steps} step(s), ${wired} secret line(s)${dryRun ? ' (dry run)' : ''}; ${byStep.size - steps - skipped.length} left over --max-steps`);
  if (skipped.length) console.log(`skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
}

if (require.main === module) main();
