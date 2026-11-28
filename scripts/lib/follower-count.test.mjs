import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countFollowers } = require('./follower-count.js');

test('counts emails across all followed shows', () => {
  assert.equal(countFollowers({
    followers: {
      'hamilton-broadway-2015': ['a@x.com', 'b@x.com'],
      'six-broadway-2021': ['c@x.com'],
    },
  }), 3);
});

test('the historical bug: summing top-level values (not .followers) always yields 0', () => {
  const data = { _meta: { updatedAt: '2026-01-01' }, followers: { 'hamilton-broadway-2015': ['a@x.com'] } };
  const buggyCount = Object.values(data).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
  assert.equal(buggyCount, 0);
  assert.equal(countFollowers(data), 1);
});

test('missing or malformed input counts as zero, not a throw', () => {
  assert.equal(countFollowers(undefined), 0);
  assert.equal(countFollowers({}), 0);
  assert.equal(countFollowers({ followers: null }), 0);
});

test('non-array follower lists are skipped rather than counted', () => {
  assert.equal(countFollowers({ followers: { 'show-1': 'not-an-array' } }), 0);
});
