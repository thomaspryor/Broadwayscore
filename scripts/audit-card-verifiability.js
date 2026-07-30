#!/usr/bin/env node
/**
 * audit-card-verifiability.js — sweep pending/in-progress Notion backlog
 * cards for the SAME verify-gate bsc-next.js enforces at dispatch time
 * (scripts/lib/verify-gate.js), so the count of undispatchable cards is
 * visible before a human hand-enriches them one at a time (task #646).
 *
 * Cards written before "acceptance criteria must name a runnable command"
 * became a rule are silently stuck: bsc-next refuses to dispatch them
 * (correctly), but nothing surfaces how many are stuck or fixes them. This
 * script is read-only — it never touches Notion — and writes a report
 * consumed by health-check.js's warn row and by enrich-card-acceptance.js.
 *
 * Usage:
 *   node scripts/audit-card-verifiability.js [--status "Not started,In progress"] [--limit N]
 *
 *   --status   comma-separated Notion Status values to sweep (default: both
 *              backlog statuses — Done cards are irrelevant, Paused cards are
 *              deliberately parked and excluded from the undispatchable count)
 *   --limit    max cards to fetch from the list endpoint (default 300)
 *   --help/-h  show this message, do nothing else
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');

const REPO = path.join(__dirname, '..');
const REPORT_PATH = path.join(REPO, 'data', 'audit', 'card-verifiability.json');
const DEFAULT_STATUS = 'Not started,In progress';
const DEFAULT_LIMIT = 300;

const USAGE = `audit-card-verifiability.js — count backlog cards bsc-next would refuse to dispatch.

Usage:
  node scripts/audit-card-verifiability.js [--status "Not started,In progress"] [--limit N]

Writes ${path.relative(REPO, REPORT_PATH)} (consumed by health-check.js's warn row
and by enrich-card-acceptance.js). Read-only — never touches Notion.
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

// List-endpoint rows carry no notes (health-digest-sized table), so every
// card needs its own `get` to see the acceptance-criteria body. Best-effort:
// a single fetch failure (Notion blip) is logged and skipped, never fatal to
// the whole sweep — same posture as autonomous-triage.js's card fetch.
function fetchCard(id) {
  try { return notionBrain(['get', id]); } catch (e) {
    console.error(`[audit-card-verifiability] WARN fetch failed for ${id}: ${e.message.slice(0, 160)}`);
    return null;
  }
}

function fetchPendingCardIds(status, limit) {
  const table = notionBrain(['list', '--status', status, '--limit', String(limit)]);
  return table.map(row => row.id);
}

// Pure — the actual per-card verdict, exported so enrich-card-acceptance.js
// (and its test) share the exact same shape instead of re-deriving it.
function evaluateCard(card) {
  const gate = evaluateVerifiability(card.notes || '');
  return {
    id: card.id,
    name: card.name,
    url: card.url,
    priority: card.priority,
    status: card.status,
    category: card.category,
    tags: card.tags || [],
    notes: card.notes || '',
    armed: gate.armed,
    ownerJudgment: gate.ownerJudgment,
    reason: gate.reason,
  };
}

function buildReport(evaluated, now = new Date()) {
  const refused = evaluated.filter(c => !c.armed);
  return {
    generatedAt: now.toISOString(),
    total: evaluated.length,
    armedCount: evaluated.length - refused.length,
    refusedCount: refused.length,
    refused: refused.map(c => ({
      id: c.id, name: c.name, priority: c.priority, url: c.url, reason: c.reason,
    })),
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(`${REPORT_PATH}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${REPORT_PATH}.tmp`, REPORT_PATH);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const status = typeof args.status === 'string' ? args.status : DEFAULT_STATUS;
  const limit = args.limit ? parseInt(args.limit, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }

  const ids = fetchPendingCardIds(status, limit);
  console.error(`[audit-card-verifiability] ${ids.length} card(s) fetched (status=${status})`);

  const evaluated = [];
  for (const [i, id] of ids.entries()) {
    const card = fetchCard(id);
    if (!card) continue;
    evaluated.push(evaluateCard(card));
    if ((i + 1) % 25 === 0) console.error(`[audit-card-verifiability] ${i + 1}/${ids.length} checked`);
  }

  const report = buildReport(evaluated);
  writeReport(report);

  console.log(`Total pending/in-progress cards checked: ${report.total}`);
  console.log(`Armed (dispatchable):                    ${report.armedCount}`);
  console.log(`Refused (undispatchable):                ${report.refusedCount}`);
  if (report.refused.length) {
    console.log('\nFirst 15 refused:');
    report.refused.slice(0, 15).forEach(c => console.log(`  ${c.id} [${c.priority || '?'}] ${c.name} — ${c.reason}`));
  }
  console.log(`\nReport written: ${path.relative(REPO, REPORT_PATH)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## Card Verifiability Audit',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Total checked | ${report.total} |`,
      `| Armed (dispatchable) | ${report.armedCount} |`,
      `| Refused (undispatchable) | ${report.refusedCount} |`,
      '',
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs, notionBrain, fetchCard, fetchPendingCardIds, evaluateCard, buildReport, writeReport,
  REPORT_PATH, DEFAULT_STATUS, DEFAULT_LIMIT, USAGE,
};
