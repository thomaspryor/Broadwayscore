// BRO-7144: areTitlesSimilar uses a bounded Levenshtein; it must give the same verdict
// as the original "full distance, then compare" rule, and the per-row profile cache
// must not serve stale values after an in-place title edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { areTitlesSimilar, levenshteinDistance, checkForDuplicate } = require('../../scripts/lib/deduplication.js');

function reference(t1, t2) {
  const maxLen = Math.max(t1.length, t2.length);
  if (maxLen === 0) return false;
  const threshold = maxLen < 6 ? 0.9 : 0.85;
  if (Math.abs(t1.length - t2.length) > maxLen * (1 - threshold)) return false;
  return 1 - levenshteinDistance(t1, t2) / maxLen >= threshold;
}

test('areTitlesSimilar matches the full-Levenshtein rule on random near-miss strings', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alpha = 'abcde ';
  const word = (n) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');
  let similar = 0;
  for (let i = 0; i < 4000; i++) {
    const a = word(2 + Math.floor(rnd() * 24));
    let b = a.split('');
    const edits = Math.floor(rnd() * 5);
    for (let e = 0; e < edits; e++) {
      const k = Math.floor(rnd() * (b.length + 1));
      const op = Math.floor(rnd() * 3);
      if (op === 0) b.splice(k, 0, alpha[Math.floor(rnd() * 6)]);
      else if (op === 1 && b.length) b.splice(Math.min(k, b.length - 1), 1);
      else if (b.length) b[Math.min(k, b.length - 1)] = alpha[Math.floor(rnd() * 6)];
    }
    b = b.join('');
    const want = reference(a, b);
    if (want) similar++;
    assert.equal(areTitlesSimilar(a, b), want, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  assert.ok(similar > 100, 'sample must include real similar pairs');
});

test('checkForDuplicate notices an in-place title edit (profile cache is not stale)', () => {
  const existing = { id: 'foo-2026', slug: 'foo-2026', title: 'Totally Different', category: 'broadway', venue: 'A Theatre' };
  const cand = { id: 'hamilton-2026', slug: 'hamilton-2026', title: 'Hamilton Returns Again', category: 'broadway', venue: 'A Theatre' };
  assert.equal(checkForDuplicate(cand, [existing]).isDuplicate, false);
  existing.title = 'Hamilton Returns Again';
  assert.equal(checkForDuplicate(cand, [existing]).isDuplicate, true);
});
