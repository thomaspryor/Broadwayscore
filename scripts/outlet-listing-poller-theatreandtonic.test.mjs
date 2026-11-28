/**
 * BRO-8216: theatreandtonic had no listing strategy, so the first pass relied on SERP and
 * missed Desire Under the Elms, Eurotrash and A Homo Alone 2 (all found days later by
 * audit-aggregator-gap). Its Squarespace blog RSS lists every review. The fixture is a trimmed
 * live copy of https://theatreandtonic.co.uk/blog?format=rss (2026-11-22).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const poller = require('./outlet-listing-poller.js');
const { parseRssFeed } = require('./lib/outlet-listing-helpers');

const cfg = poller.OUTLET_STRATEGY_CONFIG.theatreandtonic;

test('theatreandtonic has an rss listing strategy on the Squarespace blog feed', () => {
  assert.ok(cfg, 'theatreandtonic missing from OUTLET_STRATEGY_CONFIG');
  assert.equal(cfg.strategy, 'rss');
  assert.match(cfg.url, /theatreandtonic\.co\.uk\/blog\?format=rss$/);
  assert.equal(poller.SKIP_OUTLETS.has('theatreandtonic'), false);
});

test('feed fixture yields the three missed Off-West End reviews and drops non-reviews', () => {
  assert.ok(cfg, 'theatreandtonic missing from OUTLET_STRATEGY_CONFIG');
  const xml = fs.readFileSync(new URL('./fixtures/theatreandtonic-blog-feed.xml', import.meta.url), 'utf8');
  const urls = parseRssFeed(xml, new Date('2026-01-01')).map((i) => i.url).filter((u) => cfg.urlFilter.test(u));
  for (const slug of ['desire-under-the-elms-at-almeida-theatre-review', 'eurotrash-at-the-young-vic-review', 'a-homo-alone-2-at-the-other-palace-review']) {
    assert.ok(urls.some((u) => u.endsWith('/blog/' + slug)), slug);
  }
  assert.ok(!urls.some((u) => u.includes('chloe-keneally')), 'interview must be filtered out');
});
