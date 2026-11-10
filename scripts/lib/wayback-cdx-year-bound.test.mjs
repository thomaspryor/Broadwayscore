// BRO-7171 Stage 3 class guard: no Wayback CDX query may carry a hardcoded
// `to=<year>` upper bound. CDX defaults to "up to now"; a literal year (four
// scripts had `to=2026`) silently stops seeing every capture made after
// December 31 of that year, so the archive route would quietly return
// "no capture" for new reviews from January on. A bound computed at run time
// (`to=${y}`) is fine. Run: node --test scripts/lib/wayback-cdx-year-bound.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (/\.(c|m)?js$/.test(e.name) && !/\.test\.(c|m)?js$/.test(e.name)) yield p;
  }
}

/** Lines that build a CDX url with a literal 4-digit `to=` year. */
function hardcodedCdxYearBounds(text) {
  return String(text).split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter((l) => /cdx/i.test(l.text) && /[?&]to=\d{4}\b/.test(l.text));
}

test('detector: literal year bound flagged, computed bound and no bound pass', () => {
  assert.equal(hardcodedCdxYearBounds('const u = `https://web.archive.org/cdx/search/cdx?url=${x}&from=2005&to=2026`;').length, 1);
  assert.equal(hardcodedCdxYearBounds('const u = `https://web.archive.org/cdx/search/cdx?url=${x}&from=${y}&to=${y}`;').length, 0);
  assert.equal(hardcodedCdxYearBounds('const u = `https://web.archive.org/cdx/search/cdx?url=${x}&limit=5`;').length, 0);
});

test('no script queries Wayback CDX with a hardcoded to=<year>', () => {
  const hits = [];
  for (const f of jsFiles(path.join(ROOT, 'scripts'))) {
    for (const h of hardcodedCdxYearBounds(fs.readFileSync(f, 'utf8'))) hits.push(`${path.relative(ROOT, f)}:${h.line}`);
  }
  assert.deepEqual(hits, [], `hardcoded CDX year bound(s): ${hits.join(', ')}`);
});
