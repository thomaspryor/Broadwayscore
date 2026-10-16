import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { checkShowCompleteness, hasTourTickets } = createRequire(import.meta.url)('./check-show-freshness.js');

const tour = { id: 'x-tour-2026', status: 'open', ticketLinks: [] };
const types = (s, t) => checkShowCompleteness(s, t).map(i => i.type);

test('open show with no links and no tour tickets is missing_tickets', () => {
  assert.ok(types(tour, {}).includes('missing_tickets'));
});
test('tour with per-stop tour-tickets entries is not missing_tickets (BRO-5455)', () => {
  const t = { 'x-tour-2026': [{ city: 'A', start: '2026-01-01', url: 'https://x', onSale: true }] };
  assert.ok(!types(tour, t).includes('missing_tickets'));
  assert.equal(hasTourTickets(tour, t), true);
});
test('empty tour-tickets array still counts as missing', () => {
  assert.ok(types(tour, { 'x-tour-2026': [] }).includes('missing_tickets'));
});
