'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findSameArticleTwin } = require('./same-article-twin');

const body = 'Mischief is a creative comedic powerhouse and the clever storyline and talented cast make this a spectacular spy spoof. Every cast member is outstanding and the set design is integral. '.repeat(6);
const unknown = (c) => !c || /^unknown$/i.test(c);
const kept = () => true;

test('near-identical text at the same outlet is a twin even with a different header line', () => {
  const a = { outletId: 'x', fullText: 'Writers: Henry Lewis and Henry Shields\n\n' + body, criticName: 'Reviewer Upload' };
  const b = { outletId: 'x', fullText: body, criticName: 'Christine Stanton' };
  assert.strictEqual(findSameArticleTwin(a, [a, b], kept, unknown), b);
});
test('different outlet, different text, no text or no outletId is not a twin', () => {
  const a = { outletId: 'x', fullText: body };
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'y', fullText: body, criticName: 'B' }], kept, unknown), null);
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'x', criticName: 'B', fullText: 'A wholly different review of another production, with its own words and opinions. '.repeat(20) }], kept, unknown), null);
  assert.strictEqual(findSameArticleTwin({ outletId: 'x' }, [a], kept, unknown), null);
  assert.strictEqual(findSameArticleTwin({ fullText: body }, [{ fullText: body, criticName: 'B' }], kept, unknown), null);
});
test('an Unknown-critic candidate never vouches (rebuild keeps named critics only)', () => {
  const a = { outletId: 'x', fullText: body, criticName: 'A' };
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'x', fullText: body, criticName: 'Unknown' }], kept, unknown), null);
});
test('a candidate not represented in reviews.json never vouches', () => {
  const a = { outletId: 'x', fullText: body, criticName: 'A' };
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'x', fullText: body, criticName: 'B' }], () => false, unknown), null);
});
