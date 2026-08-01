import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortTicketLinks } from '../../src/lib/ticket-utils';

// HIDDEN_PLATFORMS (Ticketmaster/Telecharge/StubHub) must never leave a show
// with zero buy buttons — the hide rationale is conditioned on a visible
// sibling existing. Live incident: Les Mis Arena Concert (Radio City) had
// Ticketmaster as its ONLY seller and rendered no ticket CTA at all.

test('hidden platforms stay hidden when a visible sibling exists', () => {
  const links = [
    { platform: 'Ticketmaster', url: 'https://tm.example/x' },
    { platform: 'TodayTix', url: 'https://tt.example/x' },
  ];
  const sorted = sortTicketLinks(links);
  assert.deepEqual(sorted.map(l => l.platform), ['TodayTix']);
});

test('a show whose ONLY link is Ticketmaster still gets that button', () => {
  const sorted = sortTicketLinks([{ platform: 'Ticketmaster', url: 'https://tm.example/only' }]);
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].platform, 'Ticketmaster');
});

test('StubHub never falls back — resale-only shows stay buttonless', () => {
  assert.equal(sortTicketLinks([{ platform: 'StubHub', url: 'https://sh.example/x' }]).length, 0);
});

test('Ticketmaster+StubHub only: Ticketmaster renders, StubHub does not', () => {
  const sorted = sortTicketLinks([
    { platform: 'StubHub', url: 'https://sh.example/x' },
    { platform: 'Ticketmaster', url: 'https://tm.example/x' },
  ]);
  assert.deepEqual(sorted.map(l => l.platform), ['Ticketmaster']);
});
