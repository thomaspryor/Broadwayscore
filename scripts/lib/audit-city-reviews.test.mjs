import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseJson, sameCritic, buildPrompt } = createRequire(import.meta.url)('./audit-city-reviews.js');

test('parseJson strips fences and rejects non-objects', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJson('nope'));
  assert.throws(() => parseJson('[1]'));
});
test('sameCritic compares last name and first initial; site names differ from bylines', () => {
  assert.ok(sameCritic('Jane Smith', 'J. Smith'));
  assert.ok(!sameCritic('Jane Smith', 'Bob Smith'));
  assert.ok(!sameCritic('Theatre In San Diego', 'Jane Doe'));
});
test('prompt never carries our record (no anchoring)', () => {
  assert.ok(!buildPrompt({ title: 'T', venue: 'V', openingDate: '2026-01-01' }, { outlet: 'SECRET', criticName: 'SECRETNAME', publishDate: '2026-02-02' }, 'x', 'm').includes('SECRET'));
});
