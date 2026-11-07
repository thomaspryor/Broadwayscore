// BRO-5261 S12: String.fromCodePoint throws RangeError above 0x10FFFF, so an
// HTML-entity decoder that feeds it a parsed number straight from the page
// crashes on a malformed "&#99999999;". Every such call must go through a
// range check (the `const c = ...; return c <= 0x10ffff ? ... : m` shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIRS = ['scripts', 'src'];
const EXT = /\.(js|mjs|cjs|ts|tsx)$/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.test(e.name)) yield p;
  }
}

test('no unguarded String.fromCodePoint on a parsed entity number', () => {
  const bad = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (f.endsWith('entity-decoder-range-guard.test.mjs')) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/String\.fromCodePoint\((Number|parseInt|\+)/.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(bad, [], `guard these with a 0x10ffff range check: ${bad.join(', ')}`);
});
