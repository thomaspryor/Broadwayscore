// BRO-7108 class guard: the audit counts a derived-data path only when a file read touches it,
// and the retired exemption marker may not come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readsDerivedFile } = require('../../scripts/audit-tests-vs-derived-data.js');
// Built in pieces so this file's own text never looks like a read of the live corpus.
const D = (n) => ['data', n].join('/');

test('a real read of a derived file is detected', () => {
  assert.equal(readsDerivedFile(`const s = JSON.parse(fs.readFileSync('${D('shows.json')}', 'utf8'));`), true);
  assert.equal(readsDerivedFile(`const r = new URL('../../${D('reviews.json')}', import.meta.url);`), true);
  assert.equal(readsDerivedFile(`const a = require('../../${D('awards.json')}');`), true);
});

test('fixture strings and comments are not reads', () => {
  assert.equal(readsDerivedFile(`run: git add ${D('shows.json')}`), false);
  assert.equal(readsDerivedFile(`// reads ${D('shows.json')} relative to cwd`), false);
  assert.equal(readsDerivedFile(`r.sized('${D('reviews.json')}', 8 * MB);`), false);
  assert.equal(readsDerivedFile("fs.writeFileSync(path.join(root, 'data', 'shows.json'), x);"), false);
});

test('no test carries the retired TESTS-VS-DERIVED-DATA-EXEMPT marker', () => {
  const marker = ['TESTS-VS-DERIVED-DATA', 'EXEMPT:'].join('-');
  const self = path.basename(new URL(import.meta.url).pathname);
  const dirs = ['tests/unit', 'scripts/lib'];
  const hits = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (!/\.test\.[cm]?[jt]s$/.test(f) || f === self) continue;
      if (fs.readFileSync(path.join(d, f), 'utf8').includes(marker)) hits.push(`${d}/${f}`);
    }
  }
  assert.deepEqual(hits, []);
});
