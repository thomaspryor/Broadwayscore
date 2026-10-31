import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildRoundupQuery } = require('./bww-roundup-query.js');

test('Broadway query keeps the /article path filter and broadway keyword', () => {
  assert.equal(buildRoundupQuery({ searchTitle: 'Hamilton', year: 2015 }),
    'site:broadwayworld.com/article "Review Roundup" "Hamilton" broadway 2015');
});

test('London query reaches /westend/article and does not say broadway', () => {
  const q = buildRoundupQuery({ searchTitle: 'Avenue Q', year: 2026, isLondon: true });
  assert.equal(q, 'site:broadwayworld.com "Review Roundup" "Avenue Q" 2026');
  assert.ok(!q.includes('/article'));
});

test('opera query is unchanged', () => {
  assert.equal(buildRoundupQuery({ searchTitle: 'Innocence', year: 2026, isOpera: true }),
    'site:broadwayworld.com "Innocence" review 2026');
});
