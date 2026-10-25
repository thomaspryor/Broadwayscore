#!/usr/bin/env node
/**
 * Gemini spend by workflow, last N days (BRO-5043). Reads
 * data/audit/gemini-usage-ledger.jsonl; merge=union leaves it unordered, so
 * rows are filtered by ts, never by position. Unknown tokens are shown as
 * unknown calls, not zero. Coverage is partial: see gemini-usage-ledger.js.
 *   node scripts/gemini-usage-summary.js [--days=7]
 */
const fs = require('fs');
const { LEDGER_PATH } = require('./lib/gemini-usage-ledger');
const days = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1]) || 7;
const cutoff = Date.now() - days * 86400000;
let rows = [];
try { rows = fs.readFileSync(process.env.GEMINI_USAGE_LEDGER_PATH || LEDGER_PATH, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && Date.parse(r.ts) >= cutoff); } catch { /* none yet */ }
const by = {};
for (const r of rows) {
  const k = r.workflow || 'unknown';
  const a = by[k] || (by[k] = { calls: 0, unknownCalls: 0, usd: 0 });
  a.calls += r.calls || 0; a.unknownCalls += r.unknownCalls || 0; a.usd += r.costUsd || 0;
}
const list = Object.entries(by).sort((x, y) => y[1].usd - x[1].usd);
console.log(`Gemini spend by workflow, last ${days}d (estimate, partial coverage): ${rows.length} rows`);
for (const [w, a] of list) console.log(`  ${w}: $${a.usd.toFixed(2)} over ${a.calls} calls (${a.unknownCalls} with unknown tokens)`);
