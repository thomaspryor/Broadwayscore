#!/usr/bin/env node
/**
 * Weekly AI visibility tracker (BRO-6841; replaces check-ai-citations.js).
 * Runs long-tail prompts through ChatGPT and Gemini with web search ON, several
 * runs each, and records mention, position, cited URLs and how we're described.
 *
 *   node scripts/aeo-visibility-tracker.js [--runs=2] [--prompts=20] [--engines=openai,gemini]
 *        [--budget=4.5] [--dry-run] [--out=data/aeo]
 * Writes data/aeo/visibility-YYYY-MM-DD.json, visibility-latest.json, history.jsonl.
 * Stops when projected spend would pass --budget (default $4.50, under the $5/week cap).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const lib = require('./lib/aeo-visibility');

function arg(name, def) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
}
const flag = n => process.argv.includes(`--${n}`);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function main() {
  const runsPer = +arg('runs', 2);
  const nPrompts = Math.min(+arg('prompts', lib.PROMPTS.length), lib.PROMPTS.length);
  const budget = Math.min(+arg('budget', 4.5), 5);
  if (!Number.isFinite(budget) || budget <= 0) { console.error('[aeo] --budget must be a positive number'); process.exit(1); }
  const outDir = path.resolve(arg('out', 'data/aeo'));
  const date = new Date().toISOString().slice(0, 10);
  const engines = arg('engines', 'openai,gemini').split(',').filter(e => lib.ENGINES[e]);
  const avail = engines.filter(e => process.env[lib.ENGINES[e].key]);
  const missing = engines.filter(e => !avail.includes(e));
  if (missing.length) console.warn(`[aeo] skipping (no key): ${missing.join(', ')}`);
  if (!avail.length) { console.error('[aeo] no engine keys available'); process.exit(1); }

  const prompts = lib.PROMPTS.slice(0, nPrompts);
  const jobs = [];
  for (const engine of avail) for (const prompt of prompts) for (let r = 1; r <= runsPer; r++) jobs.push({ engine, prompt, run: r });
  const estPerRun = { openai: 0.05, gemini: 0.045 };
  const est = jobs.reduce((s, j) => s + estPerRun[j.engine], 0);
  console.log(`[aeo] ${jobs.length} runs (${avail.join('+')}, ${nPrompts} prompts x ${runsPer}), estimate ~$${est.toFixed(2)}, budget $${budget.toFixed(2)}`);
  if (flag('dry-run')) return;

  let spent = 0, reserved = 0, aborted = false;
  const results = [];
  await pool(jobs, 4, async job => {
    if (aborted) return;
    // Reserve the estimate before the call so concurrent workers cannot all pass the guard.
    const reserve = estPerRun[job.engine] * 1.5;
    if (spent + reserved + reserve > budget) { aborted = true; console.warn(`[aeo] budget guard hit at $${spent.toFixed(3)} (+$${reserved.toFixed(3)} in flight); stopping`); return; }
    reserved += reserve;
    try {
      const out = await lib.ENGINES[job.engine].run(job.prompt);
      const cost = lib.costOf(job.engine, out.usage);
      spent += cost;
      const a = lib.analyzeAnswer(out.text, out.citations);
      results.push({ ...job, ...a, cost: +cost.toFixed(4), usage: out.usage });
      console.log(`[aeo] ${job.engine} r${job.run} $${cost.toFixed(4)} ${a.mentioned ? (a.cited ? 'CITED' : 'MENTIONED') : 'absent '} pos=${a.position ?? '-'} | ${job.prompt.slice(0, 60)}`);
    } catch (e) {
      results.push({ ...job, error: e.message, cost: 0 });
      console.warn(`[aeo] ${job.engine} r${job.run} ERROR ${e.message}`);
    } finally {
      reserved -= reserve;
    }
  });
  results.sort((a, b) => a.engine.localeCompare(b.engine) || a.prompt.localeCompare(b.prompt) || a.run - b.run);

  const perPrompt = prompts.map(p => {
    const rs = results.filter(r => r.prompt === p && !r.error);
    return { prompt: p, runs: rs.length, mentioned: rs.filter(r => r.mentioned).length, cited: rs.filter(r => r.cited).length };
  });
  const report = {
    date, generatedAt: new Date().toISOString(), config: { runsPer, prompts: nPrompts, engines: avail, budget },
    totalCost: +spent.toFixed(4), summary: lib.summarize(results), perPrompt,
    errors: results.filter(r => r.error).length, runs: results,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `visibility-${date}.json`), JSON.stringify(report, null, 2) + '\n');
  // A mostly-failed or budget-truncated run must not become the canonical snapshot or a trend point.
  const partial = report.errors > results.length * 0.25 || results.length < jobs.length;
  if (partial) {
    console.warn(`[aeo] PARTIAL run (${report.errors} errors, ${results.length}/${jobs.length} runs): dated file written, latest/history NOT updated`);
    process.exit(report.errors === results.length ? 1 : 0);
  }
  fs.writeFileSync(path.join(outDir, 'visibility-latest.json'), JSON.stringify(report, null, 2) + '\n');
  const hist = { date, totalCost: report.totalCost, errors: report.errors, ...Object.fromEntries(Object.entries(report.summary).map(([k, s]) => [k, { runs: s.runs, mentionRate: s.mentionRate, citeRate: s.citeRate, avgPosition: s.avgPosition }])) };
  const histPath = path.join(outDir, 'history.jsonl');
  const prev = fs.existsSync(histPath) ? fs.readFileSync(histPath, 'utf8').split('\n').filter(l => l && JSON.parse(l).date !== date) : [];
  fs.writeFileSync(histPath, prev.concat(JSON.stringify(hist)).join('\n') + '\n');

  console.log('\n=== AI visibility, week of ' + date + ' ===');
  for (const [k, s] of Object.entries(report.summary)) {
    console.log(`${k.padEnd(7)} runs=${s.runs} mention=${(s.mentionRate * 100).toFixed(0)}% cited=${(s.citeRate * 100).toFixed(0)}% avgPos=${s.avgPosition ?? '-'} cost=$${s.cost}`);
  }
  const topComp = Object.entries((report.summary.all || {}).competitors || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('Top co-mentioned: ' + (topComp.map(([n, c]) => `${n}(${c})`).join(', ') || 'none'));
  console.log(`TOTAL COST this run: $${report.totalCost.toFixed(4)} (weekly cap $5.00)`);
  if (results.length && report.errors === results.length) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
