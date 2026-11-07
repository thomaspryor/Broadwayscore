import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reportVenueNameTypos } = require('../../scripts/lib/venue-typo-guard');
const metadata = {
  _meta: { description: 'Not a theater' },
  'Ethel Barrymore Theatre': {},
  'Helen Hayes Theater': {},
  'Vivian Beaumont Theater': {},
  'Majestic Theatre': {},
  'Lyric Theatre': {},
  'Lyceum Theatre': {},
};

for (const [venue, intended] of [
  ['Barrymore Theatre', 'Ethel Barrymore Theatre'],
  ['Hayes Theater', 'Helen Hayes Theater'],
  ['Vivian Beaumont Theater - Lincoln Center Theater', 'Vivian Beaumont Theater'],
  ['Majestic Theatre ', 'Majestic Theatre'],
  ['  Ethel Barrymore Theatre  ', 'Ethel Barrymore Theatre'],
  [' Barrymore Theatre ', 'Ethel Barrymore Theatre'],
  ['Ethel Barrymoer Theatre', 'Ethel Barrymore Theatre'],
  ['Majestic Theater', 'Majestic Theatre'],
]) {
  test(`warns for ${JSON.stringify(venue)} with its intended metadata key`, () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.equal(reportVenueNameTypos([{ id: 'fixture-show', venue }], undefined, metadata), 1);
      assert.equal(warn.mock.callCount(), 1);
      const [message] = warn.mock.calls[0].arguments;
      assert.ok(message.includes(JSON.stringify(venue)), message);
      assert.ok(message.includes(JSON.stringify(intended)), message);
      assert.ok(message.includes('fixture-show'), message);
    } finally {
      warn.mock.restore();
    }
  });
}

test('exact metadata keys, including similar real theaters, are never flagged', () => {
  const shows = Object.keys(metadata).filter(key => key !== '_meta').map(venue => ({ venue }));
  assert.equal(reportVenueNameTypos(shows, assert.fail, metadata), 0);
});

test('unknown historic houses, generic fragments and missing venues are left alone', () => {
  const shows = ['Morosco Theatre', 'Theatre', 'Theater', 'TBA', '', '  ', null, undefined, 42]
    .map(venue => ({ venue }));
  assert.equal(reportVenueNameTypos(shows, assert.fail, metadata), 0);
});

test('non-Broadway markets are excluded, even for overlapping venue names', () => {
  const shows = ['west-end', 'off-west-end', 'off-broadway', 'regional']
    .map(category => ({ category, venue: 'Majestic Theatre ' }));
  assert.equal(reportVenueNameTypos(shows, assert.fail, metadata), 0);
});

test('validation can supply its CI error reporter and reports every affected show without edits', () => {
  const shows = [
    { id: 'first', category: 'broadway', venue: 'Barrymore Theatre' },
    { id: 'second', venue: 'Barrymore Theatre' },
    { id: 'canonical', venue: 'Ethel Barrymore Theatre' },
  ];
  const original = structuredClone(shows);
  const errors = [];
  assert.equal(reportVenueNameTypos(shows, message => errors.push(message), metadata), 2);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('first'));
  assert.ok(errors[1].includes('second'));
  assert.deepEqual(shows, original);
});
