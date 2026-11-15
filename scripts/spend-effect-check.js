#!/usr/bin/env node
// BRO-7552: short-horizon spend check. After landing a change to the fetch / SERP chain, run this to see
// whether paid calls per hour actually fell, per host and per flow, in the first hour(s), straight from
// data/audit/scraper-spend-ledger.jsonl. It exists because on 2026-11-15 two spend changes were called
// "verified" with the ledger numbers still pending, and the ledger showed within the hour that one saved
// nothing (24 paid renders/hour for deadline.com + hollywoodreporter.com, unchanged) and the other made
// Broadway press-night passes dearer.
//
//   node scripts/spend-effect-check.js --since=<ISO land time> [--hosts=a.com,b.com] [--vendor=scrapingbee,brightdata]
//        [--window-hours=N] [--until=<ISO>] [--ledger=<path>] [--json]
//
// "Paid" = the vendors named by --vendor (default: every vendor except scrapingdog, the baseline search
// vendor; pass --vendor=scrapingdog,... to include it). Before = the same-length window ending at --since.
// Flows (flowOf): press-night-broadway-we, press-night-off-market, other.
// Exit: 0 printed, 1 bad args, 2 ledger missing/unreadable. Pure helpers are exported for the tests.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PAID_EXCLUDE = ['scrapingdog'];
const OFF_MARKET_RE = /-off-(?:broadway|west-end)-/;

/** PURE. 'press-night-broadway-we' | 'press-night-off-market' | 'other', from a ledger row. */
function flowOf(row) {
  const m = /^press-night:([^:]+):/.exec(String(row?.purpose || ''));
  if (!m) return 'other';
  return OFF_MARKET_RE.test(`${m[1]}-`) ? 'press-night-off-market' : 'press-night-broadway-we';
}

/** PURE. Host of a row (the ledger `host` field), lower-cased, `www.` stripped. */
const hostOf = (row) => String(row?.host || '').toLowerCase().replace(/^www\./, '');

function parseLedger(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const t = Date.parse(r.ts);
      if (Number.isFinite(t)) rows.push({ ...r, t });
    } catch { /* torn line */ }
  }
  return rows;
}

const isPaid = (row, vendors) => {
  if (!row.provider || row.fn === 'run-memo-skip' || row.fn === 'serp-cap-hit') return false;
  return vendors.include ? vendors.include.includes(row.provider) : !vendors.exclude.includes(row.provider);
};

/**
 * PURE. Paid calls and credits per hour in [from, to) per `host|flow` bucket.
 * -> Map<key, {host, flow, calls, credits}>
 */
function bucketWindow(rows, from, to, { hosts = null, vendors = { exclude: DEFAULT_PAID_EXCLUDE } } = {}) {
  const out = new Map();
  for (const r of rows) {
    if (r.t < from || r.t >= to || !isPaid(r, vendors)) continue;
    const host = hostOf(r);
    if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    const flow = flowOf(r);
    const key = `${host}|${flow}`;
    const b = out.get(key) || { host, flow, calls: 0, credits: 0 };
    b.calls += 1;
    b.credits += Number(r.credits) || 0;
    out.set(key, b);
  }
  return out;
}

/**
 * PURE. Before/after comparison. `since` is the land time (ms). The windows are equal length:
 * min(windowHours, time between since and until), so a 52-minute "after" is compared with 52 minutes before.
 * -> { windowHours, rows: [{host, flow, beforePerHour, afterPerHour, beforeCalls, afterCalls, verdict}], totals }
 * verdict: 'saved' (after < 70% of before), 'NO CHANGE' (70-130%), 'WORSE' (>130%), 'new' (before 0, after > 0), 'idle'.
 */
function compare(rows, { since, until = Date.now(), windowHours = 24, hosts = null, vendors } = {}) {
  const spanH = Math.max(0, (until - since) / 3600000);
  const hours = Math.min(windowHours, spanH);
  const ms = hours * 3600000;
  const opts = { hosts, ...(vendors ? { vendors } : {}) };
  const before = bucketWindow(rows, since - ms, since, opts);
  const after = bucketWindow(rows, since, since + ms, opts);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const per = (n) => (hours > 0 ? n / hours : 0);
  const outRows = keys.map((k) => {
    const b = before.get(k) || { calls: 0, credits: 0 };
    const a = after.get(k) || { calls: 0, credits: 0 };
    const [host, flow] = k.split('|');
    let verdict;
    if (!b.calls && !a.calls) verdict = 'idle';
    else if (!b.calls) verdict = 'new';
    else if (a.calls < 0.7 * b.calls) verdict = 'saved';
    else if (a.calls > 1.3 * b.calls) verdict = 'WORSE';
    else verdict = 'NO CHANGE';
    return { host, flow, beforeCalls: b.calls, afterCalls: a.calls, beforePerHour: per(b.calls), afterPerHour: per(a.calls), beforeCredits: b.credits, afterCredits: a.credits, verdict };
  });
  const sum = (f) => outRows.reduce((s, r) => s + r[f], 0);
  return { windowHours: hours, rows: outRows, totals: { beforeCalls: sum('beforeCalls'), afterCalls: sum('afterCalls'), beforeCredits: sum('beforeCredits'), afterCredits: sum('afterCredits') } };
}

function format(result) {
  const lines = [`Paid calls per hour, ${result.windowHours.toFixed(2)}h before vs ${result.windowHours.toFixed(2)}h after the change`];
  if (result.windowHours <= 0) lines.push('No time has passed since --since: nothing to measure yet. Re-run later; do not call this verified.');
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(`${pad('host', 28)}${pad('flow', 26)}${pad('before/h', 10)}${pad('after/h', 10)}${pad('calls b->a', 12)}verdict`);
  for (const r of result.rows) {
    lines.push(`${pad(r.host, 28)}${pad(r.flow, 26)}${pad(r.beforePerHour.toFixed(1), 10)}${pad(r.afterPerHour.toFixed(1), 10)}${pad(`${r.beforeCalls}->${r.afterCalls}`, 12)}${r.verdict}`);
  }
  const t = result.totals;
  lines.push(`TOTAL paid calls ${t.beforeCalls} -> ${t.afterCalls}, credits ${t.beforeCredits} -> ${t.afterCredits}`);
  return lines.join('\n');
}

function arg(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main(argv) {
  const sinceRaw = arg(argv, 'since');
  const since = Date.parse(sinceRaw || '');
  if (!Number.isFinite(since)) {
    process.stderr.write('usage: spend-effect-check.js --since=<ISO land time> [--hosts=a,b] [--vendor=scrapingbee,brightdata] [--window-hours=N] [--until=<ISO>] [--ledger=<path>] [--json]\n');
    return 1;
  }
  const untilRaw = arg(argv, 'until');
  const until = untilRaw ? Date.parse(untilRaw) : Date.now();
  const hostsRaw = arg(argv, 'hosts');
  const vendorRaw = arg(argv, 'vendor');
  const ledger = arg(argv, 'ledger') || path.resolve(__dirname, '..', 'data', 'audit', 'scraper-spend-ledger.jsonl');
  let text;
  try { text = fs.readFileSync(ledger, 'utf8'); } catch (e) { process.stderr.write(`cannot read ledger ${ledger}: ${e.message}\n`); return 2; }
  const result = compare(parseLedger(text), {
    since, until,
    windowHours: Number(arg(argv, 'window-hours')) || 24,
    hosts: hostsRaw ? hostsRaw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : null,
    vendors: vendorRaw ? { include: vendorRaw.split(',').map((v) => v.trim()).filter(Boolean) } : undefined,
  });
  process.stdout.write((argv.includes('--json') ? JSON.stringify(result, null, 2) : format(result)) + '\n');
  return 0;
}

module.exports = { DEFAULT_PAID_EXCLUDE, flowOf, parseLedger, bucketWindow, compare, format, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
