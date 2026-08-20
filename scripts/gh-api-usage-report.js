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
    // cwd is the closest proxy to which script/session issued the call).
    return { ts, kind, caller: fields.cwd || 'unknown', detail: fields.argv || '' };
  }
  return { ts, kind, caller: fields.caller || 'unknown', detail: `${fields.method || 'GET'} ${fields.url || ''}` };
}

function readLedger(filePath, kind, sinceMs) {
  if (!fs.existsSync(filePath)) return [];
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(sinceMs / 1000);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    if (line.includes('AGGREGATE-WARNING')) continue; // synthetic marker line, not a call
    const parsed = parseLedgerLine(line, kind);
    if (parsed && parsed.ts >= cutoff) entries.push(parsed);
  }
  return entries;
}

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
  const entries = [];
  if (!args.apiOnly) entries.push(...readLedger(GH_LEDGER, 'gh', args.sinceMs));
  if (!args.ghOnly) entries.push(...readLedger(API_LEDGER, 'api', args.sinceMs));

  const windowLabel = `${Math.round(args.sinceMs / 60000)}m`;
  const byCaller = summarize(entries);
  const byKind = summarize(entries.filter(e => e.kind === 'gh'));
  const byKindApi = summarize(entries.filter(e => e.kind === 'api'));

  if (args.json) {
    console.log(JSON.stringify({
      windowMs: args.sinceMs,
      totalCalls: entries.length,
      ghCliCalls: byKind.reduce((s, c) => s + c.count, 0),
      directApiCalls: byKindApi.reduce((s, c) => s + c.count, 0),
      topCallers: byCaller.slice(0, 20),
    }, null, 2));
    return;
  }

  console.log(`GitHub API usage — last ${windowLabel} (${entries.length} total calls)`);
  console.log(`  gh CLI: ${byKind.reduce((s, c) => s + c.count, 0)} calls   direct HTTP: ${byKindApi.reduce((s, c) => s + c.count, 0)} calls`);
  if (byCaller.length === 0) {
    console.log('\nNo calls logged in this window (or ledgers not present — nothing has called through the wrapper yet).');
    return;
  }
  console.log('\nTop callers:');
  for (const c of byCaller.slice(0, 20)) {
    console.log(`  ${String(c.count).padStart(5)}  ${c.caller}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, parseLedgerLine, readLedger, summarize };
