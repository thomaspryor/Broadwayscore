#!/usr/bin/env node
'use strict';

/**
 * merge-keyed-jsonl.js (BRO-7631): git merge driver for an append-per-key JSONL ledger.
 *
 *   node merge-keyed-jsonl.js %O %A %B %P
 *
 * The key fields come from the file's `keyed-jsonl` attribute in .gitattributes
 * (`path merge=keyed-jsonl keyed-jsonl=date,session`). Each row is three-way merged by key:
 * a side that changed or deleted a row wins over a side that left it alone, and when both
 * changed the same key %B (the commit being replayed in a rebase) wins. Rows keep %A's order,
 * then new %B rows are appended. A plain union would resurrect a superseded row beside its
 * replacement (claude-session-cost.jsonl upserts by (date, session)), which is why this
 * file is not merge=union. 36 of 143 conflicted land refusals in 30 days were this one file.
 *
 * Pure core: mergeKeyed(base, ours, theirs, keyFields) -> text. Exit 0 = %A rewritten.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

function parseRows(text, keyFields) {
  const rows = new Map();
  let n = 0;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let key = null;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && keyFields.every((f) => o[f] !== undefined)) key = keyFields.map((f) => String(o[f])).join('\u0000');
    } catch { /* unparseable: keyed by its raw text so it is kept */ }
    if (key === null) key = `\u0001raw\u0000${raw}`;
    if (rows.has(key)) key = `${key}\u0002${n}`; // duplicate key inside one file: keep every row
    rows.set(key, raw);
    n += 1;
  }
  return rows;
}

function mergeKeyed(base, ours, theirs, keyFields) {
  const o = parseRows(base, keyFields);
  const a = parseRows(ours, keyFields);
  const b = parseRows(theirs, keyFields);
  const out = [];
  const seen = new Set();
  const decide = (k) => {
    const ov = o.get(k), av = a.get(k), bv = b.get(k);
    if (av === bv) return av;
    if (av === ov) return bv; // only theirs changed (or deleted: undefined)
    if (bv === ov) return av; // only ours changed or deleted
    if (process.env.KEYED_JSONL_QUIET !== '1') console.error(`::notice::merge-keyed-jsonl: both sides changed key ${k.split('\u0002')[0]}; the replayed commit's row won (BRO-7631)`);
    return bv === undefined ? av : bv; // both changed: the replayed commit wins
  };
  for (const k of [...a.keys(), ...b.keys()]) {
    if (seen.has(k)) continue;
    seen.add(k);
    const v = decide(k);
    if (v !== undefined) out.push(v);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

function keyFieldsFor(p) {
  if (process.env.KEYED_JSONL_FIELDS) return process.env.KEYED_JSONL_FIELDS.split(',');
  try {
    const line = execFileSync('git', ['check-attr', 'keyed-jsonl', '--', p], { encoding: 'utf8' }).trim();
    const v = line.split(': ').slice(2).join(': ');
    if (v && v !== 'unspecified' && v !== 'set' && v !== 'unset') return v.split(',');
  } catch { /* fall through */ }
  return null;
}

if (require.main === module) {
  const [baseF, curF, otherF, p] = process.argv.slice(2);
  const fields = keyFieldsFor(p || '');
  if (!fields) { console.error(`merge-keyed-jsonl: no keyed-jsonl attribute on ${p}; leaving the file for a text merge`); process.exit(1); }
  // base may legitimately be absent (add/add); an unreadable ours or theirs must not look like an empty file.
  const rd = (f, required) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { if (required) { console.error(`merge-keyed-jsonl: cannot read ${f}: ${e.message}`); process.exit(1); } return ''; } };
  fs.writeFileSync(curF, mergeKeyed(rd(baseF, false), rd(curF, true), rd(otherF, true), fields));
  console.error(`::notice::merge-keyed-jsonl: merged ${p} by (${fields.join(', ')}) (BRO-7631)`);
}

module.exports = { mergeKeyed, parseRows };
