// BRO-6678: castBilling copy from cast-changes.json snapshots into shows.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enrichCastBillingFromSnapshot, enrichCastBilling, extractPlaybillCastBilling } = require('./playbill-cast-billing.js');

const URL = 'https://playbill.com/production/the-heart-example';
const snap = names => ({ names, sourceUrl: URL });

test('fills empty billing and stamps its source', () => {
  const show = { status: 'open' };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL), true);
  assert.deepEqual(show.castBilling, ['A', 'B']);
  assert.equal(show.castBillingSource, URL);
});

test('non-forced run refreshes billing it copied after a cast replacement', () => {
  const show = { status: 'open', castBilling: ['A', 'B'], castBillingSource: URL };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['C', 'B']), URL), true);
  assert.deepEqual(show.castBilling, ['C', 'B']);
});

test('unchanged snapshot is a no-op', () => {
  const show = { status: 'open', castBilling: ['A', 'B'], castBillingSource: URL };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL), false);
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL, { force: true }), false);
});

test('hand-entered (unstamped) billing that differs is never overwritten without force', () => {
  const show = { status: 'open', castBilling: ['Manual Lead'] };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL), false);
  assert.deepEqual(show.castBilling, ['Manual Lead']);
  assert.equal(show.castBillingSource, undefined);
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL, { force: true }), true);
  assert.deepEqual(show.castBilling, ['A', 'B']);
  assert.equal(show.castBillingSource, URL);
});

test('legacy unstamped copy equal to the snapshot is adopted, then refreshes on change', () => {
  const show = { status: 'open', castBilling: ['A', 'B'] };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A', 'B']), URL), true);
  assert.equal(show.castBillingSource, URL);
  assert.deepEqual(show.castBilling, ['A', 'B']);
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['C', 'B']), URL), true);
  assert.deepEqual(show.castBilling, ['C', 'B']);
});

test('billing stamped with a different source is left alone without force', () => {
  const other = 'https://playbill.com/production/other';
  const show = { status: 'open', castBilling: ['X'], castBillingSource: other };
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['A']), URL), false);
  assert.deepEqual(show.castBilling, ['X']);
  assert.equal(show.castBillingSource, other);
});

test('closed shows, mismatched source URLs and bad names never write', () => {
  const closed = { status: 'closed', castBilling: ['A'], castBillingSource: URL };
  assert.equal(enrichCastBillingFromSnapshot(closed, snap(['C']), URL), false);
  assert.deepEqual(closed.castBilling, ['A']);
  const show = { status: 'open', castBilling: ['A'], castBillingSource: URL };
  assert.equal(enrichCastBillingFromSnapshot(show, { names: ['C'], sourceUrl: 'https://playbill.com/production/x' }, URL), false);
  assert.equal(enrichCastBillingFromSnapshot(show, snap([]), URL), false);
  assert.equal(enrichCastBillingFromSnapshot(show, snap(['C', ' ']), URL), false);
  assert.equal(enrichCastBillingFromSnapshot(show, undefined, URL), false);
  assert.deepEqual(show.castBilling, ['A']);
});

test('HTML path keeps first-fill-only semantics for the scraper and requires canonical match', () => {
  const html = `<html><head><link rel="canonical" href="${URL}"></head><body>
    <div data-nav-title="Cast Current"><div class="bsp-list-promo-title"><a>Lead One</a></div>
    <div class="bsp-list-promo-title"><a>Lead Two</a></div></div></body></html>`;
  assert.deepEqual(extractPlaybillCastBilling(html), ['Lead One', 'Lead Two']);
  const fresh = { status: 'open' };
  assert.equal(enrichCastBilling(fresh, html, URL), true);
  assert.deepEqual(fresh.castBilling, ['Lead One', 'Lead Two']);
  assert.equal(enrichCastBilling({ status: 'open' }, html, 'https://playbill.com/production/other'), false);
});

import { createRequire as __cr } from 'node:module';
import __test from 'node:test';
import __assert from 'node:assert/strict';
const __lib = __cr(import.meta.url)('./playbill-cast-billing.js');
const __url = 'https://playbill.com/production/x';
__test('BRO-6678 review: hand-corrected stamped billing is kept', () => {
  const show = { status: 'open', castBilling: ['A', 'B', 'C', 'D'] };
  __lib.enrichCastBillingFromSnapshot(show, { sourceUrl: __url, names: ['A', 'B', 'C', 'D'] }, __url);
  show.castBilling = ['B', 'A', 'C', 'D'];
  const changed = __lib.enrichCastBillingFromSnapshot(show, { sourceUrl: __url, names: ['A', 'B', 'C', 'E'] }, __url);
  __assert.equal(changed, false);
  __assert.deepEqual(show.castBilling, ['B', 'A', 'C', 'D']);
});
__test('BRO-6678 review: implausible shrink needs force', () => {
  const show = { status: 'open', castBilling: ['A', 'B', 'C', 'D', 'E', 'F'] };
  __lib.enrichCastBillingFromSnapshot(show, { sourceUrl: __url, names: ['A', 'B', 'C', 'D', 'E', 'F'] }, __url);
  __assert.equal(__lib.enrichCastBillingFromSnapshot(show, { sourceUrl: __url, names: ['A'] }, __url), false);
  __assert.equal(__lib.enrichCastBillingFromSnapshot(show, { sourceUrl: __url, names: ['A', 'B', 'C', 'X', 'E', 'F'] }, __url), true);
});
