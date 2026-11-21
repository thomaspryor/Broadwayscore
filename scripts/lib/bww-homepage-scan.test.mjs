// BRO-6676: BWW roundup anchors under /off-broadway/ and /westend/ were invisible to discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractRoundupAnchors } = require('./bww-homepage-scan.js');

const SLUG = 'Review-Roundup-IN-THE-HEIGHTS-Opens-at-New-York-City-Center-20261028';

test('extractRoundupAnchors accepts /off-broadway/ and /westend/ article forms', () => {
  const html = [
    `<a href="https://www.broadwayworld.com/off-broadway/article/${SLUG}">a</a>`,
    `<a href="/westend/article/Review-Roundup-FOO-20261001">b</a>`,
    `<a href="//www.broadwayworld.com/london/article/Review-Roundup-BAR-20261002">c</a>`,
    `<a href="/article/Review-Roundup-BAZ-20261003">d</a>`,
  ].join('\n');
  const out = extractRoundupAnchors(html).join('\n');
  assert.match(out, /off-broadway\/article\/Review-Roundup-IN-THE-HEIGHTS/);
  assert.match(out, /westend\/article\/Review-Roundup-FOO/);
  assert.match(out, /london\/article\/Review-Roundup-BAR/);
  assert.match(out, /\/article\/Review-Roundup-BAZ/);
});
