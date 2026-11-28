#!/usr/bin/env node
/**
 * LLM API spend (Gemini + OpenAI) by provider and caller, last N days
 * (BRO-5043). Reads data/audit/gemini-usage-ledger.jsonl; merge=union leaves
 * it unordered, so rows are filtered by ts, never by position. Unknown tokens
 * are shown as unpriced calls, not zero. Estimates from list prices.
 *   node scripts/gemini-usage-summary.js [--days=7] [--top=15]
 */
const { readRows, summarize } = require('./lib/llm-usage-summary');

const arg = (name, dflt) => Number((process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=')[1]) || dflt;
const days = arg('days', 7);
const top = arg('top', 15);
const s = summarize(readRows(), { fromMs: Date.now() - days * 86400000 });
console.log(`LLM API spend, last ${days}d (estimate; grounding priced as an upper bound):`);
for (const [p, a] of Object.entries(s.providers)) {
  console.log(`  ${p}: $${a.usd.toFixed(2)} over ${a.calls} calls (${a.groundedCalls} grounded/search, ${a.dupCalls} repeats, ${a.unknownCalls} unpriced) = $${(a.usd / days).toFixed(2)}/day`);
}
console.log(`Top ${top} callers:`);
for (const c of s.callers.slice(0, top)) {
  const extra = `${c.groundedCalls ? `, ${c.groundedCalls} grounded` : ''}${c.dupCalls ? `, ${c.dupCalls} repeats` : ''}${c.unknownCalls ? `, ${c.unknownCalls} unpriced` : ''}`;
  console.log(`  $${c.usd.toFixed(2)}  ${c.provider}  ${c.script}  [${c.workflow}]  ${c.calls} calls${extra}`);
}
