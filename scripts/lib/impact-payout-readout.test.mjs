import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeZeroPayout, renderMarkdown, isZeroPayout, isoWeek, classifyPromoCode } = require('./impact-payout-readout.js');

const OWNER = 'owner-distinct-id-123';
const BULK = 'bulk-visitor-abc';
const actions = [
  { Amount: '600.00', Payout: '0.00', IntendedPayout: '18.00', DeltaPayout: '-18.00', State: 'REVERSED', SubId1: BULK, EventDate: '2026-10-05T19:00:00-04:00', CampaignName: 'TodayTix', Oid: 'ORDER-1', CustomerCity: 'Somewhere', PromoCode: 'SINGLEUSE-ALICE', DisputeReason: 'Order 77881 duplicate for Jane Roe' },
  { Amount: '600.00', Payout: '0.00', IntendedPayout: '0.00', DeltaPayout: '0', State: 'PENDING', SubId1: BULK, EventDate: '2026-10-06T19:00:00-04:00', CampaignName: 'TodayTix', Oid: 'ORDER-2' },
  { Amount: '120.00', Payout: '0.00', State: 'PENDING', SubId1: OWNER, EventDate: '2026-09-29T13:00:00-04:00', CampaignName: 'TodayTix', Oid: 'ORDER-3' },
  { Amount: '200.00', Payout: '6.00', State: 'APPROVED', SubId1: 'someone-else', EventDate: '2026-09-28T13:00:00-04:00', CampaignName: 'TodayTix', Oid: 'ORDER-4' },
  { Amount: '0', Payout: '0', State: 'PENDING', SubId1: '', EventDate: '2026-10-01', CampaignName: 'TodayTix' },
  { Amount: '150.00', Payout: '-4.50', State: 'REVERSED', SubId1: 'clawback-v', EventDate: '2026-10-02', CampaignName: 'TodayTix' },
];

test('isZeroPayout needs a real sale amount and a zero payout', () => {
  assert.equal(isZeroPayout(actions[0]), true);
  assert.equal(isZeroPayout(actions[3]), false);
  assert.equal(isZeroPayout(actions[4]), false, 'a $0 sale is not a $0-commission sale');
});

test('isoWeek buckets by Monday', () => {
  assert.equal(isoWeek('2026-10-05T19:00:00-04:00'), '2026-10-05');
  assert.equal(isoWeek('2026-10-11'), '2026-10-05');
  assert.equal(isoWeek('2026-09-28'), '2026-09-28');
});

test('summarizeZeroPayout separates zero-payout orders and finds owner + bulk concentration', () => {
  const s = summarizeZeroPayout(actions, new Set([OWNER]));
  assert.equal(s.total, 6);
  assert.equal(s.zero.orders + s.paid.orders + s.other.orders, 6, 'every action lands in exactly one group');
  assert.equal(s.other.orders, 2);
  assert.equal(s.zero.orders, 3);
  assert.equal(s.zero.sales, 1320);
  assert.equal(s.zero.ordersFromOwner, 1);
  assert.equal(s.zero.distinctVisitors, 2);
  assert.deepEqual(s.zero.ordersPerVisitorTop, [2, 1]);
  assert.equal(s.paid.orders, 1);
  assert.equal(s.paid.payout, 6);
  assert.deepEqual(s.zero.fields.State, { PENDING: 2, REVERSED: 1 });
  // Rows without the field are '(missing)', never counted as 'unchanged'/'0'.
  assert.deepEqual(s.zero.fields.DeltaPayout, { reduced: 1, unchanged: 1, '(missing)': 1 });
  assert.deepEqual(s.zero.fields.IntendedPayout, { '>0': 1, '0': 1, '(missing)': 1 });
  assert.deepEqual(s.zero.fields['PromoCode (presence only)'], { 'has value': 1, '(empty)': 2 });
});

test('rendered markdown never contains visitor, order or customer identifiers', () => {
  const s = summarizeZeroPayout(actions, new Set([OWNER]));
  const md = renderMarkdown(s, { windowLabel: 'test', pages: 2, incomplete: false, singlePageCount: 4 });
  for (const secret of [OWNER, BULK, 'someone-else', 'clawback-v', 'ORDER-1', 'ORDER-4', 'Somewhere', 'SINGLEUSE-ALICE', '77881', 'Jane Roe']) {
    assert.ok(!md.includes(secret), `markdown leaked ${secret}`);
  }
  assert.match(md, /\$0 payout, real sale: 3 orders, \$1320\.00 sales/);
  assert.match(md, /orders from the owner's own visitor IDs: 1/);
  assert.match(md, /Fields present on actions \(names only\):.*Oid/);
  assert.match(md, /returned 4 of 6 actions, so the weekly report, accruals and health checks undercount/);
  assert.match(md, /Other \(clawbacks, \$0 sales\): 2 orders/);
});

test('an incomplete paging run is flagged, and a full single-page read says so', () => {
  const s = summarizeZeroPayout(actions, new Set());
  assert.match(renderMarkdown(s, { windowLabel: 't', pages: 50, incomplete: true }), /INCOMPLETE/);
  const full = renderMarkdown(s, { windowLabel: 't', pages: 1, incomplete: false, singlePageCount: 6 });
  assert.match(full, /returned all 6 actions in one request/);
  assert.doesNotMatch(full, /INCOMPLETE/);
});

test('classifyPromoCode names the blacklist entry without echoing the code', () => {
  assert.equal(classifyPromoCode('TPHZRSXEKZYVUMY'), 'TP…');
  assert.equal(classifyPromoCode('save'), 'SAVE (exact)');
  assert.equal(classifyPromoCode(' nofee20 '), 'NOFEE…');
  assert.equal(classifyPromoCode('BWAYLOVE10'), 'NOT ON LIST (starts BW…, 10 chars)');
});

test('promo codes are checked against the contract blacklist, off-list orders counted and not leaked', () => {
  const rows = [
    { Amount: '100', Payout: '0', SubId1: 'v1', EventDate: '2026-10-05', PromoCode: 'TPHZRSXEKZYVUMY' },
    { Amount: '50', Payout: '0', SubId1: 'v2', EventDate: '2026-10-05', PromoCode: 'SAVE' },
    { Amount: '75', Payout: '0', SubId1: 'v3', EventDate: '2026-10-05', PromoCode: 'BWAYLOVE10' },
    { Amount: '60', Payout: '0', SubId1: 'v4', EventDate: '2026-10-05' },
  ];
  const s = summarizeZeroPayout(rows);
  assert.deepEqual(s.zero.fields['PromoCode vs contract blacklist'], {
    'TP…': 1, 'SAVE (exact)': 1, 'NOT ON LIST (starts BW…, 10 chars)': 1,
  });
  assert.deepEqual(s.zero.promoOffList, { orders: 1, sales: 75 });
  const md = renderMarkdown(s, { windowLabel: 't', pages: 1, incomplete: false });
  assert.match(md, /Promo codes NOT on the contract blacklist: 1 orders, \$75\.00 sales/);
  for (const code of ['TPHZRSXEKZYVUMY', 'BWAYLOVE10']) assert.ok(!md.includes(code), `markdown leaked ${code}`);
});
