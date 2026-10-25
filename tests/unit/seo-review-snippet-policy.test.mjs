/**
 * Google review-snippet policy (BRO-5967): no per-critic Review nodes with
 * site-assigned ratings, no aggregateRating on ItemList items, no
 * EventScheduled on closed runs, no price-less Offers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as seo from '../../src/lib/seo';
import { generateShowSchema, generateItemListSchema, eventStatusField } from '../../src/lib/seo';

test('per-critic Review generator is gone', () => {
  assert.equal(seo.generateCriticReviewsSchema, undefined);
});

test('ItemList items carry no aggregateRating and only priced offers', () => {
  const list = generateItemListSchema([{
    name: 'A', url: '/a', score: 90, reviewCount: 20, venue: 'X', status: 'open',
    ticketLinks: [{ platform: 'NoPrice', url: 'u' }, { platform: 'Priced', url: 'v', priceFrom: 30 }],
  }], 'L');
  const item = list.itemListElement[0].item;
  assert.equal(item.aggregateRating, undefined);
  assert.deepEqual(item.offers.map(o => o.seller.name), ['Priced']);
});

test('closed runs drop eventStatus; running ones keep it', () => {
  assert.deepEqual(eventStatusField('closed', '1997-01-01'), {});
  assert.deepEqual(eventStatusField('open', '2001-01-01'), {});
  assert.equal(eventStatusField('open', null).eventStatus, 'https://schema.org/EventScheduled');
  const s = generateShowSchema({ title: 'S', slug: 's', venue: 'V', category: 'broadway', status: 'closed', openingDate: '1997-01-01', closingDate: '1997-06-01' });
  assert.equal(s.eventStatus, undefined);
});

test('show offers without a price are omitted', () => {
  const s = generateShowSchema({ title: 'S', slug: 's', venue: 'V', category: 'broadway', status: 'open', openingDate: '2020-01-01', closingDate: null,
    ticketLinks: [{ platform: 'NoPrice', url: 'u' }] });
  assert.equal(s.offers, undefined);
});
