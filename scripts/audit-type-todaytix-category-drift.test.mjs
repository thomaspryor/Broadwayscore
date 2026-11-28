import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const audit = require('../docs/audits/bro-6582-type-verification.json');

// This card requests source verification, and every existing type was correct.
// Test the committed evidence record itself. Do not pin mutable private data,
// fetch live pages in CI, or reimplement discovery's classification logic here.
const expectedIds = [
  'midnight-off-broadway-2026',
  'the-pianist-off-west-end-2026',
  'whats-eating-gilbert-grape-off-broadway-2026',
  'now-you-see-me-live-2026',
  'blue-man-group-a-new-holiday-surprise-2026',
  'a-kidman-carol-off-broadway-2026',
];

test('BRO-6582 documents exactly the six requested shows', () => {
  assert.equal(audit.card, 'BRO-6582');
  assert.match(audit.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(audit.records.map(record => record.showId).sort(), [...expectedIds].sort());
});

for (const record of audit.records) {
  test(`${record.showId}: retained type has independent source evidence`, () => {
    assert.ok(['play', 'musical', 'special'].includes(record.verifiedType));
    assert.equal(record.decision, 'keep');
    assert.equal(record.observedType, record.verifiedType);
    assert.ok(record.title && record.venue);
    assert.ok(['Plays', 'Musicals'].includes(record.storedTodayTixCategory));
    assert.ok(record.sources.some(source => ['producer', 'theatre'].includes(source.kind)),
      'Each show needs a producer or theatre source, not just an aggregator');

    for (const source of record.sources) {
      assert.ok(source.name);
      assert.ok(['producer', 'theatre', 'registry'].includes(source.kind));
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.doesNotMatch(url.hostname, /(^|\.)todaytix\.com$/i);
      assert.ok(source.evidence.length >= 60, 'Explain what the page says about this production');
    }
  });
}
