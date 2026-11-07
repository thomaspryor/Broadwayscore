import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chooseFirstSeen } = require('./backfill-first-seen.js');

test('chooseFirstSeen never overwrites an existing firstSeenAt (immutable)', () => {
  assert.equal(chooseFirstSeen({ firstSeenAt: '2020-01-01T00:00:00Z' }, '2026-05-05T00:00:00Z'),
    '2020-01-01T00:00:00Z', 'existing value wins over git date');
});

test('chooseFirstSeen uses the git first-add date when the file lacks firstSeenAt', () => {
  assert.equal(chooseFirstSeen({ publishDate: '2026-03-01' }, '2026-02-19T00:25:25Z'), '2026-02-19T00:25:25Z');
  assert.equal(chooseFirstSeen({}, null), null, 'no git date → null (skipped, not stamped with now)');
});
