/**
 * Ratchet: every horizontal poster shelf (flex + gap + overflow-x-auto +
 * scrollbar-hide) must be wrapped in <ScrollRow>. The scrollbar is hidden, so
 * without ScrollRow's arrows a mouse user has no cue the row scrolls (BRO-5184).
 * Tables and filter-chip strips use overflow-x-auto without gap-3 + scrollbar-hide
 * together with `flex gap-`, so they do not trip this.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const SHELF = /className=["'`][^"'`]*\bflex\b[^"'`]*\bgap-3\b[^"'`]*\boverflow-x-auto\b[^"'`]*\bscrollbar-hide\b/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every flex gap-3 overflow-x-auto scrollbar-hide shelf goes through ScrollRow', () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    if (f.endsWith('ScrollRow.tsx')) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!SHELF.test(src)) continue;
    // A shelf is fine only when the track is a <ScrollRow ...> (className prop) in this file.
    const bare = src.split('\n').filter((l) => SHELF.test(l) && !/<ScrollRow\b/.test(l) && !/^\s*className=/.test(l));
    const viaScrollRow = /import ScrollRow from/.test(src);
    if (bare.length || !viaScrollRow) offenders.push(path.relative(SRC, f));
  }
  assert.deepStrictEqual(offenders, [], `Wrap these shelves in <ScrollRow> (src/components/ScrollRow.tsx): ${offenders.join(', ')}`);
});

test('the guard catches a bare shelf', () => {
  assert.ok(SHELF.test('<div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 scrollbar-hide">'));
  assert.ok(!SHELF.test('<div className="overflow-x-auto">'));
});
