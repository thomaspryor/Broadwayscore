// BRO-7080 (cousins of BRO-5701 / BRO-6202 / BRO-6438): isIncludableForRebuild
// without its filePath argument cannot see sibling files, so a syndication
// secondary (nydailynews copy of a Tribune review) or a duplicateOf twin reads
// as includable. verify-all-scored blocked an opening-night email on it, and
// the drift probe overcounted Other Desert Cities 36 vs 32. Every caller in
// scripts/ that reads a review file from disk must pass the path. A call that
// has no file (an in-memory record) goes on the allowlist with a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// file -> reason. Keep this short; a new entry needs a real reason.
const ALLOW = new Map([
  ['scripts/lib/review-guards.js', 'defines the predicate'],
]);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\.(mjs|js|ts)$/.test(e.name)) yield p;
  }
}

/** Top-level argument count of the call whose '(' is at `open`, or -1 if unbalanced. */
function argCount(src, open) {
  let depth = 0, args = 1, sawToken = false, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; sawToken = true; continue; }
    if ('([{'.includes(c)) { depth++; if (depth > 1) sawToken = true; continue; }
    if (')]}'.includes(c)) { depth--; if (depth === 0) return sawToken ? args : 0; continue; }
    if (c === ',' && depth === 1) { args++; continue; }
    if (depth >= 1 && !/\s/.test(c)) sawToken = true;
  }
  return -1;
}

// Local wrappers that forward a filePath into the predicate. Their callers
// drop the path just as easily (audit-t1-silent-gaps.js:336 did, found by the
// BRO-7080 ship-check), so they are held to the same rule.
const WRAPPERS = ['isIncludableForRebuild', 'fileCountsAsScored'];

export function shortCalls(src, name = 'isIncludableForRebuild') {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue; // the definition
    const line = src.slice(0, m.index).split('\n').length;
    const lineText = src.split('\n')[line - 1];
    if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue; // comment
    if (new RegExp(`\`[^\`]*${name}\\(\\.\\.\\.\\)`).test(lineText)) continue;
    const n = argCount(src, m.index + m[0].length - 1);
    if (n > 0 && n < 3) out.push({ line, n }); // n === 0: prose "isIncludableForRebuild()" in a string
  }
  return out;
}

test('shortCalls finds a 2-argument call and passes a 3-argument one', () => {
  assert.deepEqual(shortCalls('x = isIncludableForRebuild(d, show);').map(c => c.n), [2]);
  assert.deepEqual(shortCalls('x = isIncludableForRebuild(d, show, path.join(a, f));'), []);
  assert.deepEqual(shortCalls('x = isIncludableForRebuild(d, f(a, b));').map(c => c.n), [2]);
  assert.deepEqual(shortCalls('// isIncludableForRebuild(d)'), []);
  assert.deepEqual(shortCalls('if (fileCountsAsScored(d, show)) x();', 'fileCountsAsScored').map(c => c.n), [2]);
});

test('every isIncludableForRebuild caller in scripts/ passes filePath (BRO-7080)', () => {
  const bad = [];
  for (const file of walk(path.join(ROOT, 'scripts'))) {
    const rel = path.relative(ROOT, file);
    if (ALLOW.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const name of WRAPPERS) {
      if (!src.includes(name)) continue;
      for (const c of shortCalls(src, name)) bad.push(`${rel}:${c.line} ${name} (${c.n} args)`);
    }
  }
  assert.deepEqual(bad, [], `pass the review file's path as the 3rd argument:\n${bad.join('\n')}`);
});
