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

function loadQueuedTasks() {
  let files;
  try { files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  const tasks = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      if (t && (t.status === 'pending' || t.status === 'in_progress')) tasks.push(t);
    } catch { /* skip unreadable/corrupt task mirror file — one bad file must not kill the audit */ }
  }
  return tasks;
}

function fetchCard(uuid) {
  const out = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', uuid], { encoding: 'utf8' });
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

  const tasks = loadQueuedTasks();
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
  const snapshot = buildQueueAuditSnapshot({ classifications, history, now });

  console.log(`predispatch-queue-audit: ${snapshot.bannerText}`);
  if (skippedNoUuid) console.log(`  (${skippedNoUuid} queued task(s) skipped — no Notion id)`);
  if (fetchErrors) console.log(`  (${fetchErrors} card(s) skipped — fetch/classify error)`);

  if (dryRun) return;

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');

  const newHistory = [...history, { at: snapshot.generatedAt, blockedCount: snapshot.blockedCount }].slice(-HISTORY_MAX);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(newHistory, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { loadQueuedTasks, fetchCard, loadHistory, TASKS_DIR, SNAPSHOT_FILE, HISTORY_FILE };
