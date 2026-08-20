#!/usr/bin/env node
/**
 * session-metrics-recheck.js — scan real ~/.claude/projects/<project>/*.jsonl
 * transcripts for a given day and report the S2 gate-fix / S1 reminder-size
 * metrics (BRO-140). Pure decision logic lives in scripts/lib/session-metrics.js
 * (fixture-tested in tests/unit/session-metrics.test.mjs); this CLI is the
 * live-data harness, kept separate because ~/.claude/projects/ is per-machine
 * session history, not part of the repo and not available in CI.
 *
 *   node scripts/session-metrics-recheck.js --date 2026-08-03
 *   node scripts/session-metrics-recheck.js --since 2026-08-18   # today if omitted
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  countGateBlocks,
  detectGateHookCrashes,
  measureTaskReminderTokenSizes,
  averageBlocksPerSession,
} = require('./lib/session-metrics.js');

function parseArgs(argv) {
  const args = { date: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') args.date = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
  }
  return args;
}

function projectDir() {
  const cwd = process.cwd();
  const candidates = [cwd, cwd.replace(/\/\.claude\/worktrees\/[^/]+$/, '')];
  for (const c of candidates) {
    const dir = path.join(os.homedir(), '.claude', 'projects', c.replace(/\//g, '-'));
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
}

function transcriptsForDay(dir, dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      const mtime = fs.statSync(p).mtime;
      return mtime >= start && mtime < end;
    });
}

function transcriptsSince(dir, dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).mtime >= start);
}

function parseEntries(filePath) {
  const entries = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // tolerate a truncated final line
    }
  }
  return entries;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = projectDir();
  if (!fs.existsSync(dir)) {
    console.error(`No transcript directory at ${dir}`);
    process.exit(1);
  }

  const files = args.date
    ? transcriptsForDay(dir, args.date)
    : transcriptsSince(dir, args.since || new Date().toISOString().slice(0, 10));

  const perSessionBlocks = [];
  const allCrashes = [];
  const allReminderSizes = [];
  let sessionsWithBlocks = 0;

  for (const f of files) {
    const entries = parseEntries(f);
    const blocks = countGateBlocks(entries);
    perSessionBlocks.push(blocks);
    if (blocks > 0) sessionsWithBlocks++;
    allCrashes.push(...detectGateHookCrashes(entries));
    allReminderSizes.push(...measureTaskReminderTokenSizes(entries));
  }

  const avg = averageBlocksPerSession(perSessionBlocks);
  const totalBlocks = perSessionBlocks.reduce((a, b) => a + b, 0);

  console.log(`Sessions scanned: ${files.length}`);
  console.log(`Sessions with >=1 gate block: ${sessionsWithBlocks}`);
  console.log(`Total gate-block events: ${totalBlocks}`);
  console.log(`Avg blocks/session: ${avg.toFixed(2)} (target <1.0, baseline 4.6)`);
  console.log(`Gate-hook crash indicators: ${allCrashes.length}`);
  if (allCrashes.length) allCrashes.forEach((c) => console.log(`  CRASH: ${c.slice(0, 200)}`));
  if (allReminderSizes.length) {
    const max = Math.max(...allReminderSizes);
    const avgSize = Math.round(allReminderSizes.reduce((a, b) => a + b, 0) / allReminderSizes.length);
    console.log(
      `task_reminder injections: ${allReminderSizes.length}, avg ~${avgSize} tokens, max ~${max} tokens (target <15000)`
    );
  } else {
    console.log('task_reminder injections: 0 (none fired in this window)');
  }
}

main();
