/**
 * Tests for scripts/lib/cross-outlet-group.js (BRO-6774).
 * Run: node --test scripts/lib/cross-outlet-group.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getBestText, resolveFingerprintGroup } = require('./cross-outlet-group.js');
const { classifyCrossOutletPair } = require('./cross-outlet-pair-policy.js');

const body = 'The quick brown fox jumps over the lazy dog while the orchestra plays on. '.repeat(8);
const mk = (file, outletId, criticName, text = body) => ({ file, outletId, outlet: outletId, criticName, text });
const classify = (a, b) => classifyCrossOutletPair(a, b, { similarity: 100 });

test('three bylineless members: one keeper, two copies, none of them the keeper', () => {
  const g = [mk('a.json', 'nytimes', null), mk('b.json', 'huffpost', null), mk('c.json', 'ap', null)];
  const { pairs, review } = resolveFingerprintGroup(g, classify);
  assert.equal(review.length, 0);
  assert.deepEqual(pairs.map((p) => [p.keep.file, p.copy.file]), [['a.json', 'b.json'], ['a.json', 'c.json']]);
});

test('keeper that declares provenance is the copy: later and earlier copies re-point at the true source', () => {
  const declaring = mk('guardian.json', 'guardian', 'Adrian Horton', `The following review was posted on Deadline December 18. ${body}`);
  const deadline = mk('deadline.json', 'deadline', 'Greg Evans');
  const third = mk('third.json', 'extra', null);
  const { pairs } = resolveFingerprintGroup([declaring, deadline, third], classify);
  const copies = pairs.map((p) => p.copy.file);
  assert.ok(copies.includes('guardian.json'), 'declaring file is hidden');
  assert.ok(!pairs.some((p) => p.keep.file === 'guardian.json'), 'nothing points at a hidden file');
  assert.ok(!pairs.some((p) => p.keep.file === p.copy.file));
  for (const p of pairs) assert.equal(p.keep.file, 'deadline.json');
});

test('different named critics without evidence go to review, never to pairs', () => {
  const { pairs, review } = resolveFingerprintGroup(
    [mk('a.json', 'nytimes', 'Ben Brantley'), mk('b.json', 'ap', 'Mark Kennedy')], classify);
  assert.equal(pairs.length, 0);
  assert.equal(review.length, 1);
});

test('getBestText prefers fullText, falls back to excerpts, else none', () => {
  assert.equal(getBestText({ fullText: 'x'.repeat(60) }).source, 'fullText');
  const ex = getBestText({ fullText: 'short', dtliExcerpt: 'one', bwwExcerpt: 'two' });
  assert.equal(ex.source, 'excerpts');
  assert.equal(ex.text, 'one two');
  assert.equal(getBestText({}).source, 'none');
});

test('moved earlier copy that the new keeper would only review goes to review', () => {
  const g = { id: 'g' }, x = { id: 'x' }, d = { id: 'd' };
  const classify = (k, m) => {
    if (k === g && m === d) return { action: 'hide', copy: 'a' };
    if (k === d && m === x) return { action: 'review', reason: 'different-critics-unverified' };
    return { action: 'hide', copy: 'b' };
  };
  const r = resolveFingerprintGroup([g, x, d], classify);
  assert.deepEqual(r.pairs.map((p) => p.keep.id + '<' + p.copy.id), ['d<g']);
  assert.deepEqual(r.review.map((p) => p.keep.id + '?' + p.copy.id), ['d?x']);
});
