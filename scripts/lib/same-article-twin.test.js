'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findSameArticleTwin } = require('./same-article-twin');

const body = 'Mischief is a creative comedic powerhouse and the clever storyline and talented cast make this a spectacular spy spoof. Every cast member is outstanding and the set design is integral. '.repeat(6);

test('near-identical text at the same outlet is a twin even with a different header line', () => {
  const a = { outletId: 'x', fullText: 'Writers: Henry Lewis and Henry Shields\n\n' + body, criticName: 'Reviewer Upload' };
  const b = { outletId: 'x', fullText: body, criticName: 'Christine Stanton' };
  assert.strictEqual(findSameArticleTwin(a, [b]), b);
});
test('different outlet, different text or no text is not a twin', () => {
  const a = { outletId: 'x', fullText: body };
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'y', fullText: body }]), null);
  assert.strictEqual(findSameArticleTwin(a, [{ outletId: 'x', fullText: 'A wholly different review of another production, with its own words and opinions. '.repeat(20) }]), null);
  assert.strictEqual(findSameArticleTwin({ outletId: 'x' }, [a]), null);
});
