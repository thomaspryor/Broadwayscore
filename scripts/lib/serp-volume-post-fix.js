'use strict';

// Read-only BRO-3344 audit. Raw snapshots are required: the durable daily
// aggregate drops fallback_from and detail, so it cannot answer this card.
const fs = require('fs');
const { topCallers, topCallersByCredits } = require('./provider-telemetry');
const DAY_MS = 86400000;
const BASELINE = Object.freeze({ from: '2026-08-31', calls: 543, credits: 12950, allSbCredits: 13372, nullFallbackCalls: 543 });

function readSnapshots(files) {
  // Same exact-record identity as merge-scraper-spend-ledger.js. Overlapping
  // snapshots must not multiply calls. Malformed/missing input fails loudly.
  const lines = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) lines.add(line);
  }
  return [...lines].map(JSON.parse);
}

function summarizeSerpWeek(records, from, to) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)
      || new Date(start).toISOString().slice(0, 10) !== from
      || new Date(end).toISOString().slice(0, 10) !== to || end - start !== 7 * DAY_MS
      || from < '2026-09-15') throw new Error('Expected a complete post-fix UTC week: FROM TO (exclusive)');
  const scope = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  const inWindow = records.filter(r => r && typeof r.ts === 'string' && r.ts >= scope.from && r.ts < scope.to);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  const missingDays = days.filter(day => !inWindow.some(r => r.ts.slice(0, 10) === day));
  // Boundary observations and all seven days are necessary, but not proof
  // that every production call was captured. Report provenance separately.
  const spansWindow = records.some(r => r?.ts < scope.from) && records.some(r => r?.ts >= scope.to);
  const isSerp = (r, provider) => r.provider === provider && r.fn === 'serp'
    && (r.host === `serp.${provider}` || r.host?.startsWith(`serp.${provider}.`));
  const sb = inWindow.filter(r => isSerp(r, 'scrapingbee'));
  const totals = rows => ({ calls: rows.length, credits: rows.reduce((sum, r) => sum + (Number.isFinite(r.credits) ? r.credits : 0), 0) });
  const byFallback = {};
  for (const row of sb) {
    // Absent historical tags are unknown, never evidence of explicit null.
    const tag = !Object.hasOwn(row, 'fallback_from') ? 'missing' : row.fallback_from === null ? 'null' : row.fallback_from;
    byFallback[tag] ??= { calls: 0, credits: 0 };
    byFallback[tag].calls++;
    byFallback[tag].credits += Number.isFinite(row.credits) ? row.credits : 0;
  }
  const failures = inWindow.filter(r => isSerp(r, 'scrapingdog') && r.success === false);
  const groups = new Map();
  for (const row of failures) {
    const shape = { status: row.status ?? null, msg: row.detail?.msg ?? null, quoted: row.detail?.quoted ?? null,
      ops: row.detail?.ops ?? null, nonAscii: row.detail?.nonAscii ?? null };
    const key = JSON.stringify(shape);
    if (!groups.has(key)) groups.set(key, { ...shape, calls: 0 });
    groups.get(key).calls++;
  }
  const observed = totals(sb);
  const nullCalls = byFallback.null?.calls || 0;
  return {
    scope, baseline: BASELINE, coverage: { missingDays, spansWindow },
    sb: { ...observed, allCredits: totals(inWindow.filter(r => r.provider === 'scrapingbee')).credits,
      byFallback, nullFallbackShare: observed.calls ? nullCalls / observed.calls : null,
      daily: days.map(day => ({ day, ...totals(sb.filter(r => r.ts.slice(0, 10) === day)) })),
      topCallers: topCallers(sb, scope, 'scrapingbee'), topCallersByCredits: topCallersByCredits(sb, scope, 'scrapingbee') },
    sd: { failures: failures.length, http400: failures.filter(r => r.status === 400).length,
      missingDetail: failures.filter(r => !r.detail).length,
      failureGroups: [...groups.values()].sort((a, b) => b.calls - a.calls || JSON.stringify(a).localeCompare(JSON.stringify(b))) },
    // A missing/rotated week or uninstrumented rows cannot verify the claim.
    comparison: missingDays.length || !spansWindow || byFallback.missing ? null : {
      callsChangePct: (observed.calls / BASELINE.calls - 1) * 100,
      creditsChangePct: (observed.credits / BASELINE.credits - 1) * 100,
      nullFallbackCallsChangePct: (nullCalls / BASELINE.nullFallbackCalls - 1) * 100,
    },
  };
}

module.exports = { readSnapshots, summarizeSerpWeek };

if (require.main === module) {
  try {
    const [from, to, ...files] = process.argv.slice(2);
    if (!files.length) throw new Error('Usage: node scripts/lib/serp-volume-post-fix.js FROM TO ledger.jsonl [snapshot.jsonl ...]');
    const report = summarizeSerpWeek(readSnapshots(files), from, to);
    console.log(JSON.stringify(report, null, 2));
    if (!report.comparison) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
