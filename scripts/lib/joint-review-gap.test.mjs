// Run: node --test scripts/lib/joint-review-gap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findCitedLiveElsewhere } = require('./joint-review-gap.js');

const rows = [
  { showId: 'silver', url: 'https://www.lavoce.example/en/col/' },
  { showId: 'bughouse', url: 'https://example.com/a?x=1' },
];

test('a cited url live only under another show is reported; own-show and unknown urls are not', () => {
  const gap = [
    { showId: 'burnout', missing: [{ url: 'http://lavoce.example/en/col' }, { url: 'https://nowhere.example/x' }] },
    { showId: 'silver', missing: [{ url: 'https://lavoce.example/en/col/' }] },
    { showId: 'bughouse', censusVerdict: { missing: [{ url: 'https://lavoce.example/en/col' }, { url: 'https://lavoce.example/en/col/' }] } },
  ];
  const out = findCitedLiveElsewhere(gap, rows);
  assert.deepEqual(out.map((o) => [o.showId, o.liveUnder]), [['burnout', ['silver']], ['bughouse', ['silver']]]);
});

test('host filter restricts the report', () => {
  const gap = [{ showId: 'burnout', missing: [{ url: 'http://lavoce.example/en/col' }] }];
  assert.equal(findCitedLiveElsewhere(gap, rows, { hosts: /vulture/ }).length, 0);
  assert.equal(findCitedLiveElsewhere(gap, rows, { hosts: /lavoce/ }).length, 1);
});
