#!/usr/bin/env node
// scripts/propose-push-retry-remediation.js — BRO-2801. Proposal-only pass over
// the call sites scripts/audit-push-retry-budgets.js flags: a ranked table of
// proposed MAX_RETRIES / PUSH_DEADLINE_SEC / PUSH_API_FALLBACK_AFTER_ATTEMPTS
// and job timeout-minutes, each re-checked against the audit's own
// evaluateStep. Writes nothing; every real workflow edit still gets its own
// rule-18 review. Logic lives in scripts/lib/push-retry-remediation.js.
//
// Usage:
//   node scripts/propose-push-retry-remediation.js              # ranked table
//   node scripts/propose-push-retry-remediation.js --file=gather-reviews.yml
//   node scripts/propose-push-retry-remediation.js --json
//   node scripts/propose-push-retry-remediation.js --failures=<failures.jsonl>  # rank by real push failures
//   node scripts/propose-push-retry-remediation.js --top=30
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { proposeForWorkflow, verifyProposal } = require('./lib/push-retry-remediation.js');
const { hasHelpFlag } = require('./lib/cli-help');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

function usage() {
  return `propose-push-retry-remediation.js — proposal-only fixes for audit-push-retry-budgets.js flags (BRO-2801)

  --file=<wf.yml>       one workflow only
  --top=N               rows to print (default 40)
  --json                machine-readable
  --failures=<jsonl>    rank by failures per workflow from a push-retry failures ledger
                        (default: git show origin/push-retry-failures:failures.jsonl when present)`;
}

// workflow file -> failure count, from the durable push-retry failures ledger.
function loadFailures(arg) {
  let text = '';
  try {
    text = arg ? fs.readFileSync(arg, 'utf8')
      : execFileSync('git', ['show', 'origin/push-retry-failures:failures.jsonl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
  const counts = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const wf = String(row.workflow_file || row.workflowFile || row.workflow || '');
    const base = wf.split('/').pop();
    if (base) counts.set(base, (counts.get(base) || 0) + 1);
    if (row.workflow && !/\.ya?ml$/.test(row.workflow)) counts.set(`name:${row.workflow}`, (counts.get(`name:${row.workflow}`) || 0) + 1);
  }
  return counts;
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(usage()); return; }
  const json = args.includes('--json');
  const fileArg = (args.find((a) => a.startsWith('--file=')) || '').slice(7) || null;
  const top = parseInt((args.find((a) => a.startsWith('--top=')) || '--top=40').slice(6), 10) || 40;
  const failuresArg = (args.find((a) => a.startsWith('--failures=')) || '').slice(11) || null;

  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).filter((f) => !fileArg || f === fileArg).sort();
  if (fileArg && !files.length) { console.error(`no such workflow: ${fileArg}`); process.exit(2); }
  const failures = loadFailures(failuresArg);

  let rows = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
    const nameMatch = text.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
    for (const row of proposeForWorkflow(text, f)) {
      if (row.status === 'clean') continue;
      row.ledgerFailures = failures ? (failures.get(f) || (nameMatch && failures.get(`name:${nameMatch[1]}`)) || 0) : null;
      if (row.status === 'proposal') {
        row.reauditFlags = verifyProposal(row);
      }
      rows.push(row);
    }
  }
  const order = { proposal: 0, 'review-by-hand': 1, 'structural-only': 2, 'no-proposal': 3 };
  rows.sort((a, b) => (b.ledgerFailures || 0) - (a.ledgerFailures || 0)
    || order[a.status] - order[b.status] || b.contentionScore - a.contentionScore
    || a.file.localeCompare(b.file));

  const summary = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const unproven = rows.filter((r) => r.status === 'proposal' && r.reauditFlags && r.reauditFlags.length);
  if (json) {
    console.log(JSON.stringify({ summary, unproven: unproven.length, rows }, null, 2));
    if (unproven.length) process.exitCode = 1;
    return;
  }
  console.log(`Flagged call sites: ${rows.length}  ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`Proposals are PROPOSALS: each workflow edit needs its own rule-18 review. "recommended" keeps margin (fundable attempts >= max(F+1, 4) at the step's own GIT_NET_TIMEOUT_SEC); "threshold" only silences the audit.\n`);
  for (const r of rows.slice(0, top)) {
    const c = r.current;
    const fail = r.ledgerFailures != null ? ` [${r.ledgerFailures} ledger failures]` : '';
    console.log(`${r.file} :: ${r.job} / "${r.step}"${fail}`);
    console.log(`    now: retries=${c.maxRetries} deadline=${c.deadlineSec}s fallbackAfter=${c.fallbackAfter} jobTimeout=${c.jobTimeoutMinutes}m  flags: ${r.flags.join(', ')}`);
    if (r.status === 'proposal') {
      const p = r.proposed;
      console.log(`    recommended: retries=${p.maxRetries} PUSH_DEADLINE_SEC=${p.deadlineSec} PUSH_API_FALLBACK_AFTER_ATTEMPTS=${p.fallbackAfterOverride ?? '(default)'} timeout-minutes=${p.jobTimeoutMinutes}  (fundable ${r.fundableAtOwnTimeout} at ${r.gitNetTimeoutSec}s ops; re-audit: ${r.reauditFlags.length ? `STILL ${r.reauditFlags.join(',')}` : 'clean'})`);
      if (r.thresholdOnly) console.log(`    threshold only: retries=${r.thresholdOnly.maxRetries} deadline=${r.thresholdOnly.deadlineSec} fallbackAfter=${r.thresholdOnly.fallbackAfterOverride ?? '(default)'}`);
      for (const k of r.cautions) console.log(`    caution: ${k}`);
    } else if (r.reason) {
      console.log(`    ${r.status}: ${r.reason}`);
    }
    if (r.structural) console.log(`    structural: ${r.structural}`);
    console.log('');
  }
  if (rows.length > top) console.log(`... ${rows.length - top} more (--top=N, --json).`);
  if (unproven.length) {
    console.error(`::error::${unproven.length} proposal(s) do not re-audit clean — a bug in the proposer, not the workflows.`);
    process.exitCode = 1;
  }
}

main();
