#!/usr/bin/env node
/**
 * audit-mirror-status-drift.js — BRO-2215's own acceptance measurement, made
 * repeatable.
 *
 * BRO-2215 found the local task mirror over-reporting open P1 backlog by
 * ~42%, measured by hand: sample 26 of 308 mirror-pending P1s, check each
 * against live Notion, count how many were already Done. The reconciliation
 * mechanism this uncovered (reconcileStaleMirrors et al, notion-tasks-
 * sync.js) already shipped under tasks #1691/#1697/#1701/#1778/#1790 — this
 * script exists so the SAME measurement can be re-run on demand instead of
 * hand-rolling a shell loop every time drift is suspected again.
 *
 * Usage:
 *   node scripts/audit-mirror-status-drift.js [--sample=25] [--status=pending]
 *     [--priority="P1 Next"] [--list-id ID] [--max-allowed-drift=1] [--json]
 *
 * Exit code: 0 if drift count <= --max-allowed-drift, 1 otherwise (or on a
 * fetch failure — never reports "clean" on incomplete data).
 *
 * This is a LIVE-DATA probe (reads ~/.claude/tasks/<list>/ and calls the
 * real Notion API via notion-brain.js) — same shape as
 * scripts/audit-orphan-inprogress.js. Not run in CI.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { evenlySpacedSample, extractCandidates } = require('./lib/mirror-status-drift-sample.js');

const USAGE = `audit-mirror-status-drift.js — sample mirror-pending tasks against live Notion, report already-Done drift (BRO-2215).

Usage:
  node scripts/audit-mirror-status-drift.js [options]

Options:
  --sample=N            candidates to sample (default 25)
  --status=STATUS        local mirror status to sample (default pending)
  --priority="P1 Next"   priority label to filter on (default: any priority)
  --list-id ID           task list id (default: broadwayscore)
  --max-allowed-drift=N  already-Done count that still passes (default 1)
  --json                 machine-readable output
  --help, -h              print this usage and exit
`;

if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function tasksRoot(args) {
  return args['tasks-dir'] || path.join(os.homedir(), '.claude', 'tasks');
}
function listDir(args) {
  return path.join(tasksRoot(args), args['list-id'] || process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');
}

function readAllTaskEntries(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip unreadable/corrupt */ }
  }
  return out;
}

function repoRoot() { return path.resolve(__dirname, '..'); }
function notionStatus(pageId) {
  const raw = execFileSync('node', [path.join(repoRoot(), 'scripts', 'notion-brain.js'), 'get', pageId],
    { cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(raw).status;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sampleSize = parseInt(args.sample, 10) || 25;
  const status = args.status || 'pending';
  const priorityLabel = args.priority || null;
  const maxAllowedDrift = args['max-allowed-drift'] !== undefined ? parseInt(args['max-allowed-drift'], 10) : 1;

  const dir = listDir(args);
  const entries = readAllTaskEntries(dir);
  const candidates = extractCandidates(entries, { status, priorityLabel });
  const sample = evenlySpacedSample(candidates, sampleSize);

  const results = [];
  let fetchFailed = 0;
  for (const c of sample) {
    try {
      results.push({ ...c, notionStatus: notionStatus(c.pageId) });
    } catch (e) {
      fetchFailed++;
      results.push({ ...c, notionStatus: null, error: e.message.split('\n')[0] });
    }
  }

  const alreadyDone = results.filter((r) => r.notionStatus === 'Done');
  const ok = fetchFailed === 0 && alreadyDone.length <= maxAllowedDrift;

  const report = {
    candidatePoolSize: candidates.length,
    sampled: results.length,
    alreadyDone: alreadyDone.length,
    fetchFailed,
    maxAllowedDrift,
    ok,
    alreadyDoneDetail: alreadyDone.map((r) => ({ id: r.id, pageId: r.pageId })),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(`[audit-mirror-status-drift] pool=${report.candidatePoolSize} sampled=${report.sampled} alreadyDone=${report.alreadyDone} fetchFailed=${report.fetchFailed} (max allowed drift: ${maxAllowedDrift})`);
    for (const r of alreadyDone) console.error(`  ⚠ #${r.id} (${r.pageId}) mirror=${status} but Notion=Done`);
    console.error(ok ? '[audit-mirror-status-drift] PASS' : '[audit-mirror-status-drift] FAIL');
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { readAllTaskEntries, notionStatus };
