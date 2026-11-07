#!/usr/bin/env node
'use strict';
/**
 * Split "original" productions in data/show-origins.json into true stories
 * (about real people or events) and invented stories (BRO-5871). Adds
 * originalKind: "true-story" | "invented" and originalKindNote. One
 * web-searching gpt-5.4-mini call per batch; records with verifiedBy keep
 * any originalKind already set.
 *
 * Usage: node scripts/classify-original-kind.js [--ids=a,b] [--batch=10] [--max-usd=5] [--redo]
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { researchCallCost, countSearchCalls } = require('./lib/research-cost');
const { ORIGINAL_KINDS } = require('./lib/show-origins');

const OUT = path.join(__dirname, '..', 'data', 'show-origins.json');
const MODEL = 'gpt-5.4-mini';
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const BATCH = Number(args.batch || 10);
const MAX_USD = Number(args['max-usd'] || 5);

function prompt(batch) {
  const lines = batch.map((r, i) => `${i + 1}. id="${r.id}" | "${r.title}" | Broadway ${r.openingDate.slice(0, 4)}`);
  return `For each Broadway production below (all are original works, not adapted from a book, film or song catalog), say whether its story is about REAL people or events ("true-story": a biography, a dramatized historical event, a real person's life, a documentary or verbatim play, a solo memoir show) or INVENTED ("invented": fictional characters and plot, even if set in a real time or place). A fictional story set against real history is "invented" unless real people are its main characters. Search the web when unsure.

${lines.join('\n')}

Reply with ONLY JSON: {"results":[{"id":"...","kind":"true-story"|"invented","note":"one short phrase, e.g. 'the 9/11 diversion to Gander' or 'fictional family drama'"}]}`;
}

async function call(text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, input: text, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' } }),
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      const out = j.output || [];
      const msg = out.filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((c) => c.text || '').join('');
      const m = msg.match(/\{[\s\S]*\}/);
      let parsed = null;
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
      return { parsed, usd: researchCallCost(j.usage, MODEL, countSearchCalls(out)).total };
    }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 10000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  throw new Error('retries exhausted');
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  let todo = Object.entries(data.shows)
    .filter(([, r]) => r.source === 'original' && (args.redo ? !r.verifiedBy : !r.originalKind))
    .map(([id, r]) => ({ id, title: r.title, openingDate: r.openingDate }));
  if (args.ids) { const ids = new Set(String(args.ids).split(',')); todo = todo.filter((r) => ids.has(r.id)); }
  let spent = 0;
  let done = 0;
  const failures = [];
  for (let i = 0; i < todo.length && spent < MAX_USD; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let r;
    try { r = await call(prompt(batch)); } catch (e) { failures.push(...batch.map((b) => `${b.id}: ${e.message}`)); continue; }
    spent += r.usd;
    const results = (r.parsed && Array.isArray(r.parsed.results)) ? r.parsed.results : [];
    for (const b of batch) {
      const hit = results.find((x) => x && x.id === b.id);
      if (!hit || !ORIGINAL_KINDS.includes(hit.kind)) { failures.push(`${b.id}: no valid kind`); continue; }
      data.shows[b.id].originalKind = hit.kind;
      data.shows[b.id].originalKindNote = hit.note ? String(hit.note).slice(0, 120) : null;
      done++;
    }
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
    console.log(`[original-kind] ${done}/${todo.length} done, $${spent.toFixed(2)}`);
  }
  console.log(JSON.stringify({ done, failed: failures.length, spentUsd: Number(spent.toFixed(2)) }));
  if (failures.length) console.log(failures.slice(0, 20).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
