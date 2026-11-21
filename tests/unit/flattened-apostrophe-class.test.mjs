// BRO-7357: regex classes like /['']/ (curly apostrophe flattened to ASCII) silently drop "It’s"-style titles.
// Requires the real lib (CLAUDE.md §15). Repo scan: no file may exceed its baseline count; the baseline only shrinks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { findFlattenedApostropheClasses: find } = require('../../scripts/lib/flattened-apostrophe-class.js');
const M = require('../../scripts/lib/show-score-title-match.js');
const BASE = require('../../scripts/lib/flattened-apostrophe-class-baseline.json').counts;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('detector: flattened classes flagged, curly or escaped classes and comments are not', () => {
  assert.equal(find(".replace(/['']/g, '')").length, 1);
  assert.equal(find(".replace(/[''\":,.!?]/g, '')").length, 1);
  assert.equal(find(".replace(/['’]/g, '')").length, 0);
  assert.equal(find(".replace(/['\\u2018\\u2019]/g, '')").length, 0);
  assert.equal(find("// the old regex was /['']/g").length, 0);
  assert.equal(find("foo(); // was /['']/g").length, 0);
  assert.equal(find(".replace(/^['']/, '')").length, 1);
  assert.equal(find(".replace(/[^a-z']/g, '')").length, 0);
  // BRO-7514 review: mid-regex classes and flattened double-quote classes
  assert.equal(find("const r = /critic['']?s['']?\\s*pick/i;").length, 2);
  assert.equal(find("x.replace(/[\"\"]/g, '\"')").length, 1);
  assert.equal(find("x.replace(/[\"\\u201c\\u201d]/g, '\"')").length, 0);
  assert.equal(find("const a = ['', 'x']; const b = by[''];").length, 0);
});

test('Show Score title match: curly and straight apostrophes match (It’s A Wonderful Life regression)', () => {
  assert.equal(M.titlesMatch("It's a Wonderful Life: A Live Radio Play (Broadway)", 'It’s A Wonderful Life: A Live Radio Play'), true);
  assert.equal(M.normalizeTitle('It’s'), M.normalizeTitle("It's"));
  assert.equal(M.slugifyTitle('It’s A Wonderful Life'), 'it-s-a-wonderful-life');
  assert.equal(M.titlesMatch('Hamilton', 'Wicked'), false);
  assert.equal(M.slugifyTitle("Doll's House"), 'doll-s-house');
  assert.equal(M.normalizeTitle('\u201CHello\u201D'), 'hello');
});

test('repo scan: no file has more flattened apostrophe classes than its baseline (fixes may shrink it any time)', () => {
  const files = execFileSync('git', ['ls-files', 'scripts/*.js', 'scripts/*.mjs', 'scripts/*.ts', 'src/*.ts', 'src/*.tsx', 'src/*.js'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const over = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const hits = find(fs.readFileSync(p, 'utf8'));
    if (hits.length > (BASE[f] || 0)) over.push(`${f}: ${hits.length} (baseline ${BASE[f] || 0}) e.g. line ${hits[0].line}: ${hits[0].text}`);
  }
  assert.deepEqual(over, [], `write curly apostrophes as \\u2018\\u2019 escapes:\n${over.join('\n')}`);
});
