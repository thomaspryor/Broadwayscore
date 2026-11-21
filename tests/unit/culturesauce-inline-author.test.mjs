import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cq = require('../../scripts/lib/content-quality.js');

const slam = "Theater 'Slam Frank' lampoons wokeness with jackboots and rap verses while testing the limits of taste (Off Broadway review) Date: October 4, 2026 Author: Thom Geier Taste is subjective.";

test('culturesauce inline Author line resolves the critic', () => {
  assert.equal(cq.extractCultureSauceInlineAuthor(slam), 'Thom Geier');
});

test('extractAuthorFromHtml uses it for culturesauce.com without a registry', () => {
  const name = cq.extractAuthorFromHtml('<html></html>', slam, { url: 'https://culturesauce.com/slam-frank-off-broadway-review/' });
  assert.equal(name, 'Thom Geier');
});

test('no byline line returns null', () => {
  assert.equal(cq.extractCultureSauceInlineAuthor('A review with no byline.'), null);
});
