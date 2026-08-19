#!/usr/bin/env node
/**
 * predispatch-queue-audit — tally predispatch-guard verdicts (task #1801)
 * across every pending/in_progress task in the local mirror, write the
 * digest snapshot scripts/send-morning-digest.js reads.
 *
 * Same card-fetch pattern as scripts/predispatch-check.js: resolve each
 * task's Notion id via notionIdOf() (the structured `[notion:<uuid>]` tag),
 * never search, then `notion-brain.js get <uuid>` and classifyCandidate().
 * Mac-local producer, same as scripts/backlog-drain.js — both this script
 * and send-morning-digest.js run on the same Mac via launchd
 * (com.broadwayscore.predispatch-queue-audit.plist, scheduled before the
 * 7:30am digest), so there's no cross-machine gap to bridge with a git
 * commit; the snapshot + history files are gitignored.
 *
 * Usage:
 *   node scripts/predispatch-queue-audit.js
 *   node scripts/predispatch-queue-audit.js --dry-run   classify, don't write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { notionIdOf } = require('./lib/dispatch-guards.js');
const { classifyCandidate, resolveNotionUuid } = require('./lib/predispatch-guard.js');
const { buildQueueAuditSnapshot } = require('./lib/predispatch-queue-audit.js');

const REPO = path.join(__dirname, '..');
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const SNAPSHOT_FILE = path.join(AUDIT_DIR, 'predispatch-queue-audit-snapshot.json');
const HISTORY_FILE = path.join(AUDIT_DIR, 'predispatch-queue-audit-history.json');
// ~3 weeks of daily entries — always leaves a usable 5-9 day-old comparator
// for findWeekAgoEntry even if a run or two is missed.
const HISTORY_MAX = 21;

const USAGE = `predispatch-queue-audit — tally predispatch-guard verdicts across every queued task, write the digest snapshot.

Usage:
  node scripts/predispatch-queue-audit.js            run + write snapshot/history
  node scripts/predispatch-queue-audit.js --dry-run   classify + print only, don't write
  node scripts/predispatch-queue-audit.js --help      show this message, do nothing else
`;

// A missing/unreadable TASKS_DIR (wrong CLAUDE_CODE_TASK_LIST_ID, wrong
// machine, launchd PATH/cwd misconfiguration) must fail loud, not degrade to
// an empty task list — an empty list produces the exact same "0 of 0 queued
// cards blocked" snapshot as a genuinely healthy quiet day, so a broken
// config would silently read as "all clear" forever (ship-check adversarial
// finding; same vacuous-gate class as #1063/#1069, see
// scripts/lib/dispatch-outcome-digest.js's identical guard).
function loadQueuedTasks() {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));
  const tasks = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      if (t && (t.status === 'pending' || t.status === 'in_progress')) tasks.push(t);
    } catch { /* skip unreadable/corrupt task mirror file — one bad file must not kill the audit */ }
  }
  return tasks;
}

// 30s timeout (ship-check adversarial finding): this loop runs one
// execFileSync per queued task (150-200+ sequential calls at 6:50am,
// before the 7:30am digest). Without a bound, a single hung
// `notion-brain.js get` call — a stalled Notion API request — wedges the
// whole launchd job indefinitely, leaving the snapshot un-refreshed for
// every downstream card too. execFileSync throws on timeout, which the
// caller already treats as a per-card fetch error (fetchErrors++), so one
// slow card degrades the count instead of hanging the run.
const NOTION_FETCH_TIMEOUT_MS = 30_000;

function fetchCard(uuid) {
  const out = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', uuid], {
    encoding: 'utf8', timeout: NOTION_FETCH_TIMEOUT_MS,
  });
  return JSON.parse(out);
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run');
  const now = Date.now();

  let tasks;
  try {
    tasks = loadQueuedTasks();
  } catch (err) {
    console.error(`[predispatch-queue-audit] task mirror unreadable at ${TASKS_DIR}: ${err.message}`);
    console.error('[predispatch-queue-audit] refusing to write a snapshot — a missing/unreadable task mirror would misreport a healthy "0 blocked" (vacuous-gate class, #1063/#1069)');
    process.exit(1);
  }

  const classifications = [];
  let skippedNoUuid = 0;
  let fetchErrors = 0;
  for (const task of tasks) {
    const uuid = notionIdOf(task) || resolveNotionUuid(task.description || '');
    if (!uuid) { skippedNoUuid++; continue; }
    let card;
    try { card = fetchCard(uuid); }
    catch (err) { fetchErrors++; console.error(`[predispatch-queue-audit] fetch failed for #${task.id}: ${String(err.message).slice(0, 160)}`); continue; }
    try { classifications.push(classifyCandidate({ card, task })); }
    catch (err) { fetchErrors++; console.error(`[predispatch-queue-audit] classify failed for #${task.id}: ${String(err.message).slice(0, 160)}`); }
  }

  const history = loadHistory();
  const snapshot = buildQueueAuditSnapshot({ classifications, history, now, skippedNoUuid, fetchErrors });

  console.log(`predispatch-queue-audit: ${snapshot.bannerText}`);

  if (dryRun) return;

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileAtomic(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');

  const newHistory = [...history, { at: snapshot.generatedAt, blockedCount: snapshot.blockedCount }].slice(-HISTORY_MAX);
  writeFileAtomic(HISTORY_FILE, JSON.stringify(newHistory, null, 2) + '\n');
}

// write-then-rename (ship-check adversarial finding): send-morning-digest.js
// (via digest-snapshots.js's readSnapshot) reads this same file. A plain
// writeFileSync is not atomic — a reader that opens the file mid-write would
// see a truncated/partial JSON parse failure. rename(2) on the same
// filesystem is atomic, so a concurrent reader always sees either the old
// complete file or the new complete file, never a torn one.
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

if (require.main === module) main();

module.exports = { loadQueuedTasks, fetchCard, loadHistory, TASKS_DIR, SNAPSHOT_FILE, HISTORY_FILE };
