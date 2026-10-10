// BRO-4487: the Monday friction auto-fixer must keep finding friction issues
// after parked filings were capped at Medium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFrictionFixCandidate } = require('./friction-fix-eligibility.js');
const { PARKED_CLAMP_MARKER } = require('./linear-issue-create.js');

const friction = (priority, extra = '') => ({ priority, description: `PARKED: weekly scan${extra}\n\nTags: friction, fhash:1a2b3c4d` });

test('Urgent/High friction issues filed before the clamp stay eligible', () => {
  assert.equal(isFrictionFixCandidate(friction(1)), true);
  assert.equal(isFrictionFixCandidate(friction(2)), true);
});

test('a friction issue clamped from High to Medium stays eligible', () => {
  assert.equal(isFrictionFixCandidate(friction(3, `\n\n${PARKED_CLAMP_MARKER} A P0/P1 must be dispatched`)), true);
});

test('a friction issue the analyzer itself filed at Medium/Low is not picked up', () => {
  assert.equal(isFrictionFixCandidate(friction(3)), false);
  assert.equal(isFrictionFixCandidate(friction(4, `\n\n${PARKED_CLAMP_MARKER}`)), false);
});

test('missing-show issues and issues without an fhash are never eligible', () => {
  assert.equal(isFrictionFixCandidate({ priority: 2, description: 'Tags: friction, missing-show, fhash:1a2b3c4d' }), false);
  assert.equal(isFrictionFixCandidate({ priority: 2, description: 'no hash here' }), false);
  assert.equal(isFrictionFixCandidate(null), false);
});
