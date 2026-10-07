import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectDuplicateOfClearedContradiction,
  retractDuplicateOfCleared,
  hasDuplicateOfClearedValue,
  normalizeUrlForSameUrlCheck,
} = require('./duplicate-of-cleared-contradiction.js');

// 1984-2017/vulture--jesse-green.json, the real corpus shape (task #1655).
const JESSE_GREEN = {
  url: 'https://www.vulture.com/2017/06/theater-review-how-orwellian-is-1984.html',
  _duplicateOfCleared: 'auto:2026-04-12 different critics (jesse green vs christopher bonanos)',
  duplicateOf: 'vulture--christopher-bonanos.json',
  duplicateReason: 'same-url-byline-dedup on 2026-07-12: identical article as vulture--christopher-bonanos.json under a different byline',
};
const CHRISTOPHER_BONANOS = {
  url: 'https://www.vulture.com/2017/06/theater-review-how-orwellian-is-1984.html',
};

test('flags a record whose duplicateOf target shares the exact same URL as its own _duplicateOfCleared', () => {
  const v = detectDuplicateOfClearedContradiction({ review: JESSE_GREEN, target: CHRISTOPHER_BONANOS });
  assert.equal(v.contradicted, true);
  assert.equal(v.duplicateOf, 'vulture--christopher-bonanos.json');
});

test('silent when there is no _duplicateOfCleared breadcrumb', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: { url: JESSE_GREEN.url, duplicateOf: 'sibling.json' },
    target: CHRISTOPHER_BONANOS,
  });
  assert.equal(v.contradicted, false);
});

test('silent when there is no duplicateOf pointer at all', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: { url: JESSE_GREEN.url, _duplicateOfCleared: JESSE_GREEN._duplicateOfCleared },
    target: null,
  });
  assert.equal(v.contradicted, false);
});

test('silent on a duplicateOf sentinel value (not a .json filename)', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: { ...JESSE_GREEN, duplicateOf: 'known-outlet-copy-exists' },
    target: CHRISTOPHER_BONANOS,
  });
  assert.equal(v.contradicted, false);
});

test('silent when the target file is unreadable/missing (target: null)', () => {
  const v = detectDuplicateOfClearedContradiction({ review: JESSE_GREEN, target: null });
  assert.equal(v.contradicted, false);
});

test('silent when duplicateOf points at a DIFFERENT url — legitimately separate collision', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: JESSE_GREEN,
    target: { url: 'https://www.vulture.com/2017/06/some-other-article.html' },
  });
  assert.equal(v.contradicted, false);
});

test('URL comparison ignores fragment, trailing slash, and case (matches validate-data.js)', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: { ...JESSE_GREEN, url: `${JESSE_GREEN.url.toUpperCase()}/#comments` },
    target: CHRISTOPHER_BONANOS,
  });
  assert.equal(v.contradicted, true);
});

test('accepts a boolean-true breadcrumb shape, not just a string', () => {
  const v = detectDuplicateOfClearedContradiction({
    review: { ...JESSE_GREEN, _duplicateOfCleared: true },
    target: CHRISTOPHER_BONANOS,
  });
  assert.equal(v.contradicted, true);
});

test('hasDuplicateOfClearedValue rejects empty/whitespace strings', () => {
  assert.equal(hasDuplicateOfClearedValue(''), false);
  assert.equal(hasDuplicateOfClearedValue('   '), false);
  assert.equal(hasDuplicateOfClearedValue(false), false);
  assert.equal(hasDuplicateOfClearedValue(null), false);
  assert.equal(hasDuplicateOfClearedValue('a reason'), true);
});

test('normalizeUrlForSameUrlCheck strips fragment, one trailing slash, lowercases', () => {
  assert.equal(
    normalizeUrlForSameUrlCheck('HTTPS://Example.com/a/b/#frag'),
    'https://example.com/a/b'
  );
  assert.equal(normalizeUrlForSameUrlCheck(null), null);
  assert.equal(normalizeUrlForSameUrlCheck(''), null);
});

test('retractDuplicateOfCleared deletes the breadcrumb and stamps provenance, leaves duplicateOf intact', () => {
  const file = { ...JESSE_GREEN };
  const v = detectDuplicateOfClearedContradiction({ review: file, target: CHRISTOPHER_BONANOS });
  const removed = retractDuplicateOfCleared(file, v, new Date('2026-08-19T00:00:00Z'));
  assert.equal(removed, true);
  assert.equal('_duplicateOfCleared' in file, false);
  assert.equal(file.duplicateOf, 'vulture--christopher-bonanos.json');
  assert.match(file.duplicateOfClearedRetracted, /#1655/);
  assert.equal(file.duplicateOfClearedRetractedAt, '2026-08-19');
});

test('retractDuplicateOfCleared is a no-op on a non-contradiction', () => {
  const file = { url: 'https://x.com/a' };
  const removed = retractDuplicateOfCleared(file, { contradicted: false });
  assert.equal(removed, false);
  assert.deepEqual(file, { url: 'https://x.com/a' });
});
