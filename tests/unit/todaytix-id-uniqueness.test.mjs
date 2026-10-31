/**
 * BRO-5796: the TodayTix id writers (enrich-todaytix-data, update-show-status)
 * must not hand a listing to a row when another row already holds it under an
 * agreeing title: that is a pair findSharedTicketIdentityDupes then flags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findTicketIdentityHolder, findSharedTicketIdentityDupes } = require('../../scripts/lib/show-duplicate-detection.js');

const amaze = { id: 'amaze-off-broadway-2025', title: 'AMAZE', status: 'open', todaytixId: 44453 };
const dupe = { id: 'amaze-magic-off-broadway-2026', title: 'AMAZE Magic', status: 'open' };

test('a row is refused a listing another row holds under an agreeing title', () => {
  assert.equal(findTicketIdentityHolder([amaze, dupe], dupe, 44453), amaze);
  // Giving it anyway is exactly the pair the audit flags.
  assert.equal(findSharedTicketIdentityDupes([amaze, { ...dupe, todaytixId: 44453 }]).length, 1);
});

test('an id held only through a ticket link url still counts', () => {
  const viaUrl = { id: 'amaze-off-broadway-2025', title: 'AMAZE', status: 'open',
    ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/44453-amaze' }] };
  assert.equal(findTicketIdentityHolder([viaUrl, dupe], dupe, '44453'), viaUrl);
});

test('a recycled id (titles disagree) is free to assign', () => {
  const old = { id: 'the-caretaker-2003', title: 'The Caretaker', status: 'closed', todaytixId: 42 };
  const lion = { id: 'the-lion-king-1997', title: 'The Lion King', status: 'open' };
  assert.equal(findTicketIdentityHolder([old, lion], lion, 42), null);
});

test('the row already holding the listing, a declared transfer, and no id are not refused', () => {
  assert.equal(findTicketIdentityHolder([amaze, dupe], amaze, 44453), null);
  const transfer = { ...dupe, transferOf: amaze.id };
  assert.equal(findTicketIdentityHolder([amaze, transfer], transfer, 44453), null);
  assert.equal(findTicketIdentityHolder([amaze, dupe], dupe, null), null);
  assert.equal(findTicketIdentityHolder([amaze, dupe], dupe, ''), null);
});

test('a closed holder does not block: TodayTix moved the listing on', () => {
  const closed = { id: 'death-becomes-her-2024', title: 'Death Becomes Her', status: 'closed', todaytixId: 34895 };
  const tour = { id: 'death-becomes-her-tour-2026', title: 'Death Becomes Her', status: 'previews' };
  assert.equal(findTicketIdentityHolder([closed, tour], tour, 34895), null);
});

test('enrich marks a row done only after the holder check passes', () => {
  const src = fs.readFileSync(new URL('../../scripts/enrich-todaytix-data.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function enrichShow('));
  assert.ok(body.indexOf('findTicketIdentityHolder(') < body.indexOf('enriched.add(show.id)'),
    'a refused duplicate listing must not mark the row enriched before its own listing arrives');
});

test('both id writers check for a holder before assigning', () => {
  for (const f of ['enrich-todaytix-data.js', 'update-show-status.js']) {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /findTicketIdentityHolder\(/, `${f} assigns todaytixId without the holder check`);
  }
});
