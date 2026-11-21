// BRO-7117 / BRO-7029: an unbounded `git ls-files` (default 1MB maxBuffer) killed
// opening-night-poller's core-data checkout with ENOBUFS. The audit existed but
// covered only show/cat-file/ls-tree/diff/log and ran in no workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { scanSource, scanTree } = require('./git-maxbuffer-scan.js');

test('flags git ls-files with no maxBuffer (the BRO-7029 shape)', () => {
  const src = "execFileSync('git', ['-C', d, 'ls-files', '-z', '--', 'data/*.json'], { encoding: 'utf8' });";
  assert.equal(scanSource(src).length, 1);
  assert.equal(scanSource(src)[0].sub, 'ls-files');
});

test('accepts ls-files with maxBuffer; --error-unmatch alone is NOT a bound', () => {
  assert.equal(scanSource("execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1e8 });").length, 0);
  assert.equal(scanSource("execFileSync('git', ['ls-files', '--error-unmatch', '--', 'data'], { encoding: 'utf8' });").length, 1);
});

test('repo has no unbounded output-heavy git calls (CI gate)', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.deepEqual(scanTree(root), []);
});
