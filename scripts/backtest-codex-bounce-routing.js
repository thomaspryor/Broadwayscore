#!/usr/bin/env node
'use strict';
// BRO-6144 backtest: classify every "Codex runner: not landed" note of the last 14 days by the new
// bounce class (scripts/lib/codex-runner.js classifyBounce) and count the re-offers it would have
// prevented: a bounce that came after an earlier structural bounce of the same card.
//   node scripts/backtest-codex-bounce-routing.js [--days=14] [--from=FILE.json]
// FILE.json = [{body, createdAt, issue:{identifier}}]; without it, comments are read from Linear.
// Limit: stored notes keep only the tail of the report, so the classifier here sees less than the
// live runner does (which also has the ENVIRONMENT-BLOCKED line and the pre-review block).
const fs = require('fs');
const R = require('./lib/codex-runner.js');

const arg = (n, d = '') => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;

/** The live classifier's inputs, rebuilt from a stored note body. */
function inputsOf(body) {
  const b = String(body || '');
  const rem = /still open:\n((?:- .*\n?)+)/.exec(b);
  const remaining = rem ? rem[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean) : [];
  const rep = /### Codex report\n```\n([\s\S]*?)\n```/.exec(b);
  const blocked = /Blocked before review:[^\n]*/.exec(b);
  return { remaining, report: rep ? rep[1] : '', blocked: blocked ? blocked[0] : null };
}

/** -> { byClass, notes, reoffers: [{id, prior, at}], preventedShare } for notes sorted any order. */
function backtest(comments, { structuralMs = R.STRUCTURAL_MEMORY_MS } = {}) {
  const notes = comments
    .filter((c) => R.isCodexBounce(c.body) && /^## Codex runner: not landed/m.test(String(c.body).split('\n')[1] || ''))
    .map((c) => ({ id: c.issue.identifier, at: Date.parse(c.createdAt), cls: R.classifyBounce(inputsOf(c.body)) }))
    .sort((a, b) => a.at - b.at);
  const byClass = {};
  for (const n of notes) byClass[n.cls] = (byClass[n.cls] || 0) + 1;
  const reoffers = [];
  const last = new Map();
  for (const n of notes) {
    const prior = last.get(n.id);
    if (prior && R.STRUCTURAL_BOUNCE_CLASSES.has(prior.cls) && n.at - prior.at < structuralMs) reoffers.push({ id: n.id, prior: prior.cls, now: n.cls });
    last.set(n.id, n);
  }
  const repeats = notes.length - new Set(notes.map((n) => n.id)).size;
  return { notes: notes.length, cards: new Set(notes.map((n) => n.id)).size, byClass, repeats, reoffers };
}

async function main() {
  const from = arg('from');
  let comments;
  if (from) comments = JSON.parse(fs.readFileSync(from, 'utf8'));
  else {
    const since = new Date(Date.now() - Number(arg('days', '14')) * 864e5).toISOString();
    comments = await require('./lib/linear-client.js').listRecentCommentsContaining({ sinceIso: since, text: 'codex-runner-bounced', max: 2000 });
  }
  const r = backtest(comments);
  const structural = Object.entries(r.byClass).filter(([k]) => R.STRUCTURAL_BOUNCE_CLASSES.has(k)).reduce((s, [, v]) => s + v, 0);
  console.log(JSON.stringify({ ...r, reoffers: r.reoffers.length, reofferIds: [...new Set(r.reoffers.map((x) => x.id))], structuralNotes: structural }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { backtest, inputsOf };
