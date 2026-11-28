import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getOpenCommercialCoverage } = require('../../scripts/lib/commercial-coverage');

test('coverage uses Broadway scope, including announced, upcoming, previews and default category', () => {
  const shows = [
    { id: 'covered-2026', slug: 'covered', category: 'broadway', status: 'open' },
    { id: 'preview-2026', slug: 'preview', status: 'previews' },
    ...['off-broadway', 'west-end', 'off-west-end', 'regional', 'tour'].map(category => (
      { slug: category, category, market: 'broadway', status: 'open' }
    )),
    { slug: 'closed', category: 'broadway', status: 'closed' },
    ...['announced', 'upcoming'].map(status => ({ slug: status, category: 'broadway', status })),
    { slug: 'dev', status: 'open', _devOnly: true },
  ];
  const before = structuredClone(shows);
  const result = getOpenCommercialCoverage(shows, { covered: { designation: 'TBD' } });
  assert.deepEqual(result.withCommercial.map(s => s.slug), ['covered']);
  assert.deepEqual(result.withoutCommercial.map(s => s.slug), ['preview', 'announced', 'upcoming']);
  assert.deepEqual(shows, before, 'audit does not mutate show data');
});

test('coverage checks canonical slugs, never an ID sibling or an inherited property', () => {
  const result = getOpenCommercialCoverage([
    { id: 'hamilton-2015', slug: 'hamilton', status: 'open' },
    { id: 'mamma-mia-2001', slug: 'mamma-mia-2001', status: 'open' },
    { id: 'constructor-2026', slug: 'constructor', status: 'open' },
  ], { 'hamilton-2015': {}, 'mamma-mia-2001': {} });
  assert.deepEqual(result.withCommercial.map(s => s.slug), ['mamma-mia-2001']);
  assert.deepEqual(result.withoutCommercial.map(s => s.slug), ['hamilton', 'constructor']);
});

test('an empty market has no missing records', () => {
  assert.deepEqual(getOpenCommercialCoverage([], {}), { withCommercial: [], withoutCommercial: [] });
});
