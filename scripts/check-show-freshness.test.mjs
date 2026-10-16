import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { checkShowCompleteness, hasTourTickets } = createRequire(import.meta.url)('./check-show-freshness.js');

const tour = { id: 'x-tour-2026', status: 'open', category: 'tour', ticketLinks: [] };
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
test('tour with only onSale:false rows is still missing_tickets (site shows no button)', () => {
  const t = { 'x-tour-2026': [{ city: 'A', start: '2026-01-01', url: 'https://x', onSale: false }] };
  assert.ok(types(tour, t).includes('missing_tickets'));
});
test('non-tour show is not covered by a tour-tickets key', () => {
  const t = { 'x-tour-2026': [{ city: 'A', start: '2026-01-01', url: 'https://x', onSale: true }] };
  assert.ok(types({ ...tour, category: 'broadway' }, t).includes('missing_tickets'));
});
test('show with its own ticketLinks and a closed show are not flagged', () => {
  assert.ok(!types({ ...tour, ticketLinks: [{ url: 'https://y' }] }, {}).includes('missing_tickets'));
  assert.ok(!types({ ...tour, status: 'closed' }, {}).includes('missing_tickets'));
});
test('undefined tourTickets and an on-sale row without url do not cover a tour', () => {
  assert.ok(types(tour, undefined).includes('missing_tickets'));
  assert.ok(types(tour, { 'x-tour-2026': [{ city: 'A', start: 's', onSale: true }] }).includes('missing_tickets'));
});
test('real data/tour-tickets.json keeps the {tours:{id:[rows]}} shape this check reads', async () => {
  const fs = await import('node:fs');
  const f = new URL('../data/tour-tickets.json', import.meta.url);
  if (!fs.existsSync(f)) return;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(d.tours && typeof d.tours === 'object');
  assert.ok(Object.values(d.tours).every(Array.isArray));
});
