#!/usr/bin/env node
'use strict';

/**
 * Whole-entry, per-key 3-way merge for keyed checkpoint files (BRO-6687).
 *
 * data/audit/gap-audit-checkpoint.json is `{showId: entry}`. Two hourly audit
 * runs each append fresh entries at the end of the file. push-with-retry.sh
 * rebased them with `git merge-file --theirs`, which merges LINES: on
 * 2026-11-01 (commit f8ee7b7d) it kept run B's lines, dropped seven entries
 * run A had just written, and left aristocrats-off-broadway-2024 as A's
 * opening lines glued to B's closing lines, so the entry lost its
 * slowMarketResidual and still parsed as valid JSON.
 *
 * Rules, per top-level key (an entry is atomic, its fields are never mixed):
 *   - both sides equal                 -> that entry
 *   - only one side changed from base  -> that side (an add, edit or delete)
 *   - both changed, one side deleted   -> the side that still has it
 *   - both changed                     -> the entry with the later `at`;
 *                                         on a tie, `prefer` ('ours'|'theirs')
 * Key order follows `ours`, with keys only `theirs` has appended in its order.
 *
 * CLI (merge-keep-run.sh, for paths marked `merge-keyed=entries`):
 *   node checkpoint-keyed-merge.js <ours|theirs> <base> <cur> <other>
 *   cur is %A (git's "ours"), other is %B. The first argument names the side
 *   that is THIS run and wins ties. Writes the merge to <cur> in cur's layout
 *   and exits 0; exits 1 (writing nothing) when a file is not a JSON object,
 *   so the caller falls back to the text merge.
 */

const fs = require('fs');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function entryTs(entry) {
  const t = isPlainObject(entry) && entry.at ? Date.parse(entry.at) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

function pickEntry(b, o, t, prefer) {
  if (same(o, t)) return o;
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  if (o === undefined) return t;
  if (t === undefined) return o;
  const to = entryTs(o);
  const tt = entryTs(t);
  if (to !== tt) return to > tt ? o : t;
  return prefer === 'ours' ? o : t;
}

function mergeKeyedEntries(base, ours, theirs, { prefer = 'theirs' } = {}) {
  if (!isPlainObject(ours) || !isPlainObject(theirs)) throw new TypeError('ours and theirs must be JSON objects');
  const b = isPlainObject(base) ? base : {};
  const out = {};
  const keys = [...Object.keys(ours), ...Object.keys(theirs).filter((k) => !has(ours, k))];
  for (const k of keys) {
    const v = pickEntry(has(b, k) ? b[k] : undefined, has(ours, k) ? ours[k] : undefined, has(theirs, k) ? theirs[k] : undefined, prefer);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function readJson(p, { allowEmpty = false } = {}) {
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!text.trim()) {
    if (allowEmpty) return { value: {}, text };
    throw new Error(`${p} is empty`);
  }
  return { value: JSON.parse(text), text };
}

function serializeLike(value, text) {
  const m = /^\{\r?\n([ \t]+)"/.exec(text);
  const indent = m ? m[1] : 2;
  return JSON.stringify(value, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

function main(argv) {
  const [side, basePath, curPath, otherPath] = argv;
  if (!['ours', 'theirs'].includes(side) || !curPath || !otherPath) {
    console.error('usage: checkpoint-keyed-merge.js <ours|theirs> <base> <cur> <other>');
    return 1;
  }
  try {
    const base = readJson(basePath, { allowEmpty: true }).value;
    const cur = readJson(curPath);
    const other = readJson(otherPath);
    if (!isPlainObject(cur.value) || !isPlainObject(other.value)) return 1;
    const merged = mergeKeyedEntries(base, cur.value, other.value, { prefer: side });
    fs.writeFileSync(curPath, serializeLike(merged, cur.text));
    return 0;
  } catch (e) {
    console.error(`checkpoint-keyed-merge: ${e.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { mergeKeyedEntries, main };
