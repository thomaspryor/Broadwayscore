import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTheatrCoverageFlags } = require('../../scripts/lib/theatr-coverage-audit.js');

const shows = [
  {
    id: 'the-jonathan-larson-project-off-west-end-2026',
    title: 'The Jonathan Larson Project',
    category: 'off-west-end',
    openingDate: '2026-07-13',
  },
  {
    id: 'some-off-broadway-show-2026',
    title: 'Some Off Broadway Show',
    category: 'off-broadway',
    openingDate: '2026-01-01',
  },
];

function unmatchedEntry(name, watched = 150) {
  return { name, eventCategory: 'Off & Off-Off Broadway', totalWatchedUsers: watched };
}

function emptyBuzz() {
  return { shows: {} };
}

describe('buildTheatrCoverageFlags', () => {
  test('never flags a London-market show — Theatr has no West End catalog', () => {
    const flagged = buildTheatrCoverageFlags(
      shows,
      emptyBuzz(),
      [unmatchedEntry('The Jonathan Larson Project')]
    );
    assert.strictEqual(flagged.length, 0, `expected no flags for a West End show, got: ${JSON.stringify(flagged)}`);
  });

  test('still flags a matching Broadway/Off-Broadway show (control)', () => {
    const flagged = buildTheatrCoverageFlags(
      shows,
      emptyBuzz(),
      [unmatchedEntry('Some Off Broadway Show')]
    );
    assert.strictEqual(flagged.length, 1);
    assert.strictEqual(flagged[0].ourShowId, 'some-off-broadway-show-2026');
  });

  test('skips a show that already has theatr data linked', () => {
    const buzz = { shows: { 'some-off-broadway-show-2026': { sources: { theatr: { score: 80 } } } } };
    const flagged = buildTheatrCoverageFlags(shows, buzz, [unmatchedEntry('Some Off Broadway Show')]);
    assert.strictEqual(flagged.length, 0);
  });
});
