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
// "Paid" = the vendors named by --vendor (default: every vendor). SERP rows have host serp.<vendor>:
// select them with --hosts=serp. Before = the same-length window ending at --since.
// Flows (flowOf): press-night-broadway-we, press-night-off-market, other.
// Exit: 0 printed, 1 bad args, 2 ledger missing/unreadable. Pure helpers are exported for the tests.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PAID_EXCLUDE = []; // every vendor counts: scrapingdog is 94% of SERP rows, so excluding it hides SERP regressions
const OFF_MARKET_RE = /-off-(?:broadway|west-end)-/;

/**
 * PURE. 'press-night-broadway-we' | 'press-night-off-market' | 'other'. A poller row is a press-night row
 * even when `purpose` is null (7,701 of 10,638 opening-night-poller rows in the 2026-11-13..15 ledger), so
 * the flow comes from `purpose` OR from script + showId.
 */
function flowOf(row) {
  const m = /^press-night:([^:]+):/.exec(String(row && row.purpose || ''));
  const id = m ? m[1] : (row && row.script === 'opening-night-poller.js' ? String(row.showId || '') : null);
  if (!id) return 'other';
  return OFF_MARKET_RE.test(`${id}-`) ? 'press-night-off-market' : 'press-night-broadway-we';
}

// Estimated dollars per ledger row, so a page->render move (1 -> 5 credits) or a Bright Data row
// (credits: 0) is not invisible. Estimates from plan prices (2026-11-15), not billing: use for direction only.
const USD_PER_CREDIT = { scrapingbee: 0.0002, scrapingdog: 0.0001 };
const USD_PER_CALL = { brightdata: 0.0015, browserbase: 0.02 };
function usdOf(row) {
  const c = Number(row.credits) || 0;
  if (c > 0 && USD_PER_CREDIT[row.provider]) return c * USD_PER_CREDIT[row.provider];
  return USD_PER_CALL[row.provider] || (USD_PER_CREDIT[row.provider] || 0);
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
    if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`) || host.startsWith(`${h}.`))) continue;
    const flow = flowOf(r);
    const key = `${host}|${flow}`;
    const b = out.get(key) || { host, flow, calls: 0, credits: 0, usd: 0 };
    b.calls += 1;
    b.usd += usdOf(r);
    b.credits += Number(r.credits) || 0;
    out.set(key, b);
  }
  return out;
}

/**
 * PURE. Before/after comparison. `since` is the land time (ms). The windows are equal length:
 * min(windowHours, time between since and until), so a 52-minute "after" is compared with 52 minutes before.
 * Verdict per row is on estimated dollars (calls and credits are shown too): 'saved' (after < 70% of before),
 * 'NO CHANGE' (70-130%), 'WORSE' (>130%), 'new' (before 0, after > 0), 'idle' (no rows either side).
 * Overall `verdict`: 'pending' when the evidence cannot decide (under 15 minutes elapsed, or the ledger does
 * not reach back a full window before `since`), else WORSE > new > NO CHANGE > saved > idle across rows.
 * -> { windowHours, baselineComplete, verdict, rows, totals }
 */
function compare(rows, { since, until = Date.now(), windowHours = 24, hosts = null, vendors } = {}) {
  const spanH = Math.max(0, (until - since) / 3600000);
  const hours = Math.min(windowHours, spanH);
  const ms = hours * 3600000;
  const opts = { hosts, ...(vendors ? { vendors } : {}) };
  const before = bucketWindow(rows, since - ms, since, opts);
  const after = bucketWindow(rows, since, since + ms, opts);
  const earliest = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
  const baselineComplete = hours > 0 && earliest <= since - ms;
  // The ledger is committed by CI: a checkout that has not pulled since the change has before-rows and no
  // after-rows, which would read as "saved". Require rows up to (almost) the end of the after window.
  const latest = rows.reduce((m, r) => Math.max(m, r.t), -Infinity);
  const afterComplete = hours > 0 && latest >= Math.min(until, since + ms) - Math.min(2 * 3600000, ms / 2);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const per = (n) => (hours > 0 ? n / hours : 0);
  const zero = { calls: 0, credits: 0, usd: 0 };
  const outRows = keys.map((k) => {
    const b = before.get(k) || zero;
    const a = after.get(k) || zero;
    const [host, flow] = k.split('|');
    let verdict;
    if (!b.calls && !a.calls) verdict = 'idle';
    else if (!b.calls) verdict = 'new';
    else if (a.usd < 0.7 * b.usd) verdict = 'saved';
    else if (a.usd > 1.3 * b.usd) verdict = 'WORSE';
    else verdict = 'NO CHANGE';
    return { host, flow, beforeCalls: b.calls, afterCalls: a.calls, beforePerHour: per(b.calls), afterPerHour: per(a.calls), beforeCredits: b.credits, afterCredits: a.credits, beforeUsd: b.usd, afterUsd: a.usd, verdict };
  });
  const sum = (f) => outRows.reduce((s, r) => s + r[f], 0);
  let verdict = 'idle';
  if (hours < 0.25 || !baselineComplete || !afterComplete) verdict = 'pending';
  else for (const v of ['WORSE', 'new', 'NO CHANGE', 'saved']) if (outRows.some((r) => r.verdict === v)) { verdict = v; break; }
  return { windowHours: hours, baselineComplete, afterComplete, verdict, rows: outRows, totals: { beforeCalls: sum('beforeCalls'), afterCalls: sum('afterCalls'), beforeCredits: sum('beforeCredits'), afterCredits: sum('afterCredits'), beforeUsd: sum('beforeUsd'), afterUsd: sum('afterUsd') } };
}

function format(result) {
  const lines = [`Paid calls per hour, ${result.windowHours.toFixed(2)}h before vs ${result.windowHours.toFixed(2)}h after the change (est. $ uses plan prices, direction only)`];
  if (result.windowHours <= 0) lines.push('No time has passed since --since: nothing to measure yet. Re-run later; do not call this verified.');
  else if (!result.afterComplete) lines.push('WARNING: the ledger has no rows near the end of the after window (git pull first: CI commits it). Verdicts below are not a measurement.');
  else if (!result.baselineComplete) lines.push('WARNING: the ledger does not reach back a full window before --since (git pull data/audit first, or shorten --window-hours). Verdicts below are not a baseline comparison.');
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(`${pad('host', 26)}${pad('flow', 25)}${pad('before/h', 9)}${pad('after/h', 9)}${pad('calls b->a', 12)}${pad('est$ b->a', 16)}verdict`);
  for (const r of result.rows) {
    lines.push(`${pad(r.host, 26)}${pad(r.flow, 25)}${pad(r.beforePerHour.toFixed(1), 9)}${pad(r.afterPerHour.toFixed(1), 9)}${pad(`${r.beforeCalls}->${r.afterCalls}`, 12)}${pad(`${r.beforeUsd.toFixed(3)}->${r.afterUsd.toFixed(3)}`, 16)}${r.verdict}`);
  }
  const t = result.totals;
  lines.push(`TOTAL calls ${t.beforeCalls} -> ${t.afterCalls}, credits ${t.beforeCredits} -> ${t.afterCredits}, est $ ${t.beforeUsd.toFixed(3)} -> ${t.afterUsd.toFixed(3)}`);
  lines.push(`OVERALL VERDICT: ${result.verdict}`);
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
