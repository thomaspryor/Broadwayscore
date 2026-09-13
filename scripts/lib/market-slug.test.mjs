import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripMarketSuffix, withMarketSuffix } = require('./market-slug.js');

test('withMarketSuffix appends the suffix once for a clean base slug', () => {
  assert.equal(withMarketSuffix('beetlejuice-the-musical', 'west-end'), 'beetlejuice-the-musical-west-end');
  assert.equal(withMarketSuffix('beetlejuice-the-musical', 'off-west-end'), 'beetlejuice-the-musical-off-west-end');
  assert.equal(withMarketSuffix('beetlejuice-the-musical', 'off-broadway'), 'beetlejuice-the-musical-off-broadway');
});

test('withMarketSuffix is idempotent -- never doubles an existing suffix (BRO-3237)', () => {
  assert.equal(
    withMarketSuffix('beetlejuice-the-musical-west-end', 'west-end'),
    'beetlejuice-the-musical-west-end',
  );
  assert.equal(
    withMarketSuffix('beetlejuice-the-musical-off-west-end', 'off-west-end'),
    'beetlejuice-the-musical-off-west-end',
  );
});

test('withMarketSuffix leaves broadway-category slugs unsuffixed', () => {
  assert.equal(withMarketSuffix('hamilton', 'broadway'), 'hamilton');
  assert.equal(withMarketSuffix('hamilton', undefined), 'hamilton');
});

test('withMarketSuffix does not strip a suffix-shaped title for a category with no suffix mapping', () => {
  // A Broadway (or otherwise unmapped-category) show whose own title happens
  // to end in a market phrase must NOT be truncated -- only the branch that
  // is about to re-append a suffix may strip one (caught in review, BRO-3237).
  assert.equal(withMarketSuffix('the-real-west-end', 'broadway'), 'the-real-west-end');
  assert.equal(withMarketSuffix('an-off-broadway-story', undefined), 'an-off-broadway-story');
});

test('stripMarketSuffix removes only a trailing market suffix, not mid-title occurrences', () => {
  assert.equal(stripMarketSuffix('beetlejuice-the-musical-west-end'), 'beetlejuice-the-musical');
  assert.equal(stripMarketSuffix('west-end-girls'), 'west-end-girls');
});
