import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resultMatchesShow, pickForShow } = require('./uk-serp-sweep.js');

const show = { id: 'animal-farm-leeds-regional-2025', title: 'Animal Farm', venue: 'Leeds Playhouse, Leeds', openingDate: '2025-03-14' };
const ctx = (held = []) => ({ resolve: (u) => (u.includes('guardian') ? 'guardian' : u.includes('reviewshub') ? 'thereviewshub' : null), reject: () => false, heldKeys: new Set(held), urlKey: (u) => u });

test('title leads and house named', () => {
  assert.ok(resultMatchesShow(show, { url: 'https://x.co.uk/2025/03/review-animal-farm-at-leeds-playhouse/', title: 'Review: Animal Farm at Leeds Playhouse' }));
});
test('another city is out', () => {
  assert.ok(!resultMatchesShow(show, { url: 'https://x.co.uk/2025/03/animal-farm-review-nottingham/', title: 'Animal Farm review Nottingham Playhouse' }));
});
test('wrong year in URL is out', () => {
  assert.ok(!resultMatchesShow(show, { url: 'https://x.co.uk/2019/03/animal-farm-leeds-playhouse-review/', title: 'Animal Farm Leeds Playhouse review' }));
});
test('longer title is not taken by a shorter show', () => {
  assert.ok(!resultMatchesShow({ ...show, title: 'Animal' }, { url: 'https://x.co.uk/2025/03/animal-farm-leeds-playhouse-review/', title: 'Animal Farm Leeds Playhouse review' }));
});
test('one per outlet, held outlet and forum skipped', () => {
  const rs = [
    { url: 'https://www.theguardian.com/stage/2025/mar/animal-farm-review-leeds-playhouse', title: 'Animal Farm review Leeds Playhouse' },
    { url: 'https://www.theguardian.com/stage/2025/mar/animal-farm-leeds-playhouse-review-2', title: 'Animal Farm review Leeds Playhouse' },
    { url: 'https://www.thereviewshub.com/animal-farm-leeds-playhouse/', title: 'Animal Farm Leeds Playhouse review' },
  ];
  assert.equal(pickForShow(show, rs, ctx()).length, 2);
  assert.equal(pickForShow(show, rs, ctx(['outlet:guardian'])).length, 1);
  assert.equal(pickForShow(show, [{ url: 'https://www.guardian.com/thread/1/animal-farm-leeds-playhouse-review', title: 'Animal Farm Leeds Playhouse review' }], ctx()).length, 0);
});
