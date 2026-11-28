#!/usr/bin/env node
'use strict';
/**
 * BRO-8323 replay: apply the ScrapingBee market gate to the real spend ledger and
 * report what it would have dropped. Credits and call counts only (no dollars).
 *
 *   node scripts/sb-market-gate-replay.js [--ledger=PATH] [--gap-hours=3]
 *
 * Proves: Broadway rows dropped = 0, and for gated render rows the longest gap
 * between two attempts on one show+host stays well under the 6 to 8 hour budget.
 */
const fs = require('fs');
const g = require('./lib/sb-market-gate');
const { resolveLedgerPath } = require('./lib/provider-telemetry');

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ledger = arg('ledger', resolveLedgerPath());
const gapMs = Number(arg('gap-hours', String(g.DEFAULT_RENDER_GAP_HOURS))) * 3600 * 1000;

const rows = [];
for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
  if (!line || line.indexOf('"scrapingbee"') === -1) continue;
  try { const r = JSON.parse(line); if (r.provider === 'scrapingbee') rows.push(r); } catch (_) {}
}
rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
if (!rows.length) { console.log('no scrapingbee rows'); process.exit(0); }

const stat = () => ({ calls: 0, credits: 0, droppedCalls: 0, droppedCredits: 0 });
const out = { serp: {}, render: {}, other: {} };
const bump = (bucket, cat, r, dropped) => {
  const s = (out[bucket][cat] ||= stat());
  const c = r.success === false ? 0 : (r.credits || 0);
  s.calls++; s.credits += c;
  if (dropped) { s.droppedCalls++; s.droppedCredits += c; }
};
const dropEvents = new Map(); const pendingDrop = new Map();
const lastKept = new Map(); // show|host -> ms of last kept render
const keptTimes = new Map();
let broadwayDropped = 0;
for (const r of rows) {
  const cat = g.categoryForShowId(r.showId) || 'unclassified';
  const t = Date.parse(r.ts);
  if (r.fn === 'serp') {
    const drop = g.skipSbSerpForCategory(g.categoryForShowId(r.showId), {});
    if (drop && cat === 'broadway') broadwayDropped++;
    bump('serp', cat, r, drop);
  } else if (r.fn === 'render' && r.showId && r.host) {
    const key = `${r.showId}|${r.host}`;
    const d = g.renderGapDecision({ category: g.categoryForShowId(r.showId), lastRenderMs: lastKept.get(key) ?? null, nowMs: t, env: { SB_RENDER_GAP_HOURS: String(gapMs / 3600000) } });
    if (d.skip && cat === 'broadway') broadwayDropped++;
    if (d.skip) { if (!pendingDrop.has(key)) pendingDrop.set(key, t); }
    else if (r.success !== true) { /* a failed render does not start a gap (matches the gate) */ }
    else {
      lastKept.set(key, t);
      if (pendingDrop.has(key)) { (dropEvents.get(key) || dropEvents.set(key, []).get(key)).push({ delay: t - pendingDrop.get(key) }); pendingDrop.delete(key); }
    }
    bump('render', cat, r, d.skip);
  } else bump('other', cat, r, false);
}
// Delay the gate adds: for each gated show+host, from the first dropped attempt after a kept
// render to the next kept render. Gaps where the ledger itself has no attempt are not the gate's.
let maxDelay = 0; let delays = [];
for (const [key, evs] of dropEvents) {
  for (const e of evs) { if (e.delay != null) { delays.push(e.delay); maxDelay = Math.max(maxDelay, e.delay); } }
}
delays.sort((a, b) => a - b);
const p95 = delays.length ? delays[Math.floor(delays.length * 0.95)] : 0;
const span = (Date.parse(rows[rows.length - 1].ts) - Date.parse(rows[0].ts)) / 86400000;
console.log(`ledger window: ${rows[0].ts} .. ${rows[rows.length - 1].ts} (${span.toFixed(1)} days, ${rows.length} SB rows)`);
for (const b of ['serp', 'render', 'other']) {
  console.log(`\n[${b}] by category: calls / credits / dropped calls / dropped credits`);
  for (const [cat, s] of Object.entries(out[b])) console.log(`  ${cat.padEnd(14)} ${s.calls} / ${s.credits} / ${s.droppedCalls} / ${s.droppedCredits}`);
}
const dropC = ['serp', 'render'].reduce((a, b) => a + Object.values(out[b]).reduce((x, s) => x + s.droppedCredits, 0), 0);
const totC = ['serp', 'render', 'other'].reduce((a, b) => a + Object.values(out[b]).reduce((x, s) => x + s.credits, 0), 0);
console.log(`\nSB credits in window (success rows): ${totC}; dropped by gate: ${dropC} (${(100 * dropC / totC).toFixed(1)}%)`);
console.log(`per 30 days: ${(totC / span * 30).toFixed(0)} -> ${((totC - dropC) / span * 30).toFixed(0)} (ledger credits, not billed)`);
console.log(`Broadway rows dropped: ${broadwayDropped}`);
console.log(`delay added to a gated show+host (first dropped attempt to next kept render): max ${(maxDelay / 3600000).toFixed(2)}h, p95 ${(p95 / 3600000).toFixed(2)}h, n=${delays.length} (gap setting ${gapMs / 3600000}h; budget 6 to 8h)`);
process.exit(broadwayDropped === 0 ? 0 : 1);
