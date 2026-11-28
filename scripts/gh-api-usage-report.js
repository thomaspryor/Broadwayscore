#!/usr/bin/env node
/**
 * gh-api-usage-report — reads the ledgers gh-call-wrapper.sh (task #821) and
 * gh-api-wrapper.sh (BRO-134) write on every `gh` CLI call and every direct
 * HTTP call to api.github.com, and prints the top callers.
 *
 * WHY: both wrappers log per-call attribution, but until now nothing
 * consumed either ledger — a future quota-exhaustion incident would still
 * require a fresh investigative session (like #821 and BRO-134 themselves
 * were) to grep the raw logs by hand. This closes that loop: `git blame`
 * for GitHub API quota.
 *
 * The two ledgers use INCOMPATIBLE caller identities — gh-call-wrapper.sh
 * has no script/session field, only `cwd` (a worktree path); gh-api-
 * wrapper.sh has an actual script basename. Ranking them together in one
 * list (as an earlier version of this file did) is misleading: a busy
 * worktree cwd can outrank the actual offending script purely because it's
 * a coarser bucket, not because it made more calls. Reported as two
 * separate ranked lists instead (code-review finding, 2026-08-20).
 *
 * Usage:
 *   node scripts/gh-api-usage-report.js               # last 1h, both ledgers
 *   node scripts/gh-api-usage-report.js --since=24h    # last 24h
 *   node scripts/gh-api-usage-report.js --gh-only      # gh CLI ledger only
 *   node scripts/gh-api-usage-report.js --api-only     # direct-HTTP ledger only
 *   node scripts/gh-api-usage-report.js --json         # machine-readable
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GH_LEDGER = path.join(os.homedir(), '.claude', 'gh-call-ledger.log');
const API_LEDGER = path.join(os.homedir(), '.claude', 'gh-api-call-ledger.log');

// Both ledgers are append-only with no rotation (confirmed on this machine:
// gh-call-ledger.log is already 12MB+ from normal multi-session use) — a
// naive full-file read gets slower and heavier every day regardless of the
// query window. Read only the tail instead; ledger lines are chronological,
// so 4MB comfortably covers the default 1h window and most realistic
// --since values without ever loading the whole file into memory.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const args = { sinceMs: 60 * 60 * 1000, ghOnly: false, apiOnly: false, json: false };
  for (const a of argv) {
    const m = /^--since=(\d+)(s|m|h|d)?$/.exec(a);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2] || 'h';
      const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
      args.sinceMs = n * mult;
    } else if (a === '--gh-only') args.ghOnly = true;
    else if (a === '--api-only') args.apiOnly = true;
    else if (a === '--json') args.json = true;
  }
  return args;
}

// gh-call-wrapper.sh line: "<ts>\tpid=<n>\tppid=<n>\tcwd=<path>\targv=<...>"
// gh-api-wrapper.sh line:  "<ts>\tpid=<n>\tppid=<n>\tcaller=<name>\tmethod=<GET>\turl=<...>"
function parseLedgerLine(line, kind) {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const ts = Number(parts[0]);
  if (!Number.isFinite(ts)) return null;
  const fields = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    fields[p.slice(0, eq)] = p.slice(eq + 1);
  }
  if (kind === 'gh') {
    // Attribute by cwd (the gh CLI ledger has no direct "caller name" field —
    // cwd is the closest proxy to which worktree/session issued the call).
    return { ts, kind, caller: fields.cwd || 'unknown', detail: fields.argv || '' };
  }
  return { ts, kind, caller: fields.caller || 'unknown', detail: `${fields.method || 'GET'} ${fields.url || ''}` };
}

// Read only the last MAX_TAIL_BYTES of a file, dropping a possibly-partial
// leading line. Returns '' for a missing/empty file.
function readTail(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return '';
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function readLedger(filePath, kind, sinceMs) {
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(sinceMs / 1000);
  const text = readTail(filePath);
  if (!text) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.includes('AGGREGATE-WARNING')) continue; // synthetic marker line, not a call
    const parsed = parseLedgerLine(line, kind);
    if (parsed && parsed.ts >= cutoff) entries.push(parsed);
  }
  return entries;
}

// Group by caller, count, sort descending. `entries` must all share one
// `kind` — see the file-header note on why gh/api entries are never ranked
// together.
function summarize(entries) {
  const byCaller = new Map();
  for (const e of entries) {
    const cur = byCaller.get(e.caller) || { caller: e.caller, count: 0, sample: e.detail };
    cur.count++;
    byCaller.set(e.caller, cur);
  }
  return Array.from(byCaller.values()).sort((a, b) => b.count - a.count);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ghEntries = args.apiOnly ? [] : readLedger(GH_LEDGER, 'gh', args.sinceMs);
  const apiEntries = args.ghOnly ? [] : readLedger(API_LEDGER, 'api', args.sinceMs);

  const windowLabel = args.sinceMs % 60000 === 0
    ? `${Math.round(args.sinceMs / 60000)}m`
    : `${Math.round(args.sinceMs / 1000)}s`;
  const ghTop = summarize(ghEntries);
  const apiTop = summarize(apiEntries);

  if (args.json) {
    console.log(JSON.stringify({
      windowMs: args.sinceMs,
      totalCalls: ghEntries.length + apiEntries.length,
      ghCliCalls: ghEntries.length,
      directApiCalls: apiEntries.length,
      ghCliTopCallers: ghTop.slice(0, 20),
      directApiTopCallers: apiTop.slice(0, 20),
    }, null, 2));
    return;
  }

  const total = ghEntries.length + apiEntries.length;
  console.log(`GitHub API usage — last ${windowLabel} (${total} total calls)`);
  console.log(`  gh CLI: ${ghEntries.length} calls   direct HTTP: ${apiEntries.length} calls`);
  if (total === 0) {
    console.log('\nNo calls logged in this window (or ledgers not present — nothing has called through the wrapper yet).');
    return;
  }

  if (ghTop.length > 0) {
    console.log('\nTop gh CLI callers (by cwd — the ledger has no per-script field):');
    for (const c of ghTop.slice(0, 20)) {
      console.log(`  ${String(c.count).padStart(5)}  ${c.caller}`);
    }
  }
  if (apiTop.length > 0) {
    console.log('\nTop direct-API callers (by script):');
    for (const c of apiTop.slice(0, 20)) {
      console.log(`  ${String(c.count).padStart(5)}  ${c.caller}`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, parseLedgerLine, readLedger, readTail, summarize };
