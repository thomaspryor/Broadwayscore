/**
 * BRO-2619: apply-human-review-fixes.js used to mutate the FIRST file in
 * readdir order whose outletId matched, so a show with two critics at one
 * outlet could get the wrong review's llmScore.confidence downgraded.
 * findFixTarget() must only resolve a single unambiguous file.
 * Per CLAUDE.md §15: require() the real function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findFixTarget } = require('./apply-human-review-fixes.js');

function showDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahrf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}

test('two same-outlet files without criticName on the fix are ambiguous, nothing resolved', (t) => {
  const dir = showDir(t, {
    'nytimes--ben-brantley.json': { outletId: 'nytimes', criticName: 'Ben Brantley' },
    'nytimes--jesse-green.json': { outletId: 'nytimes', criticName: 'Jesse Green' },
  });
  const r = findFixTarget(dir, { outletId: 'NYTIMES' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('criticName on the fix picks the right file, even when it sorts second', (t) => {
  const dir = showDir(t, {
    'nytimes--ben-brantley.json': { outletId: 'nytimes', criticName: 'Ben Brantley' },
    'nytimes--jesse-green.json': { outletId: 'nytimes', criticName: 'Jesse Green' },
  });
  const r = findFixTarget(dir, { outletId: 'nytimes', criticName: 'Jesse Green' });
  assert.equal(r.status, 'found');
  assert.equal(path.basename(r.filePath), 'nytimes--jesse-green.json');
});

test('a single same-outlet file resolves; a missing outlet is not-found', (t) => {
  const dir = showDir(t, {
    'vulture--sara-holdren.json': { outletId: 'vulture', criticName: 'Sara Holdren' },
    'nytimes--jesse-green.json': { outletId: 'nytimes', criticName: 'Jesse Green' },
  });
  assert.equal(findFixTarget(dir, { outletId: 'vulture' }).status, 'found');
  assert.equal(findFixTarget(dir, { outletId: 'variety' }).status, 'not-found');
});

test('a fix with no outletId never matches a file that also lacks one', (t) => {
  const dir = showDir(t, { 'unknown--anon.json': { criticName: 'Anon' } });
  assert.equal(findFixTarget(dir, {}).status, 'not-found');
});
