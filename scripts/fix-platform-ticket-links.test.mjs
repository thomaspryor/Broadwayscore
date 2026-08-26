// Regression test for the recurring "A Christmas Carol (Old Vic) had the New
// York Ticketmaster link (again)" data corruption — happened at least 6 times
// (792d249c, c1344d6, c76a8af, ed9d424, 4f18b22, e721c202b in the private
// data repo; BRO-172 / task #956 / #1002). Root cause: fix-platform-ticket-links.js's
// Ticketmaster SERP re-verification only queried/matched ticketmaster.com,
// so a West End show could never re-confirm its real .co.uk page and instead
// got silently overwritten by a loosely title-matching US result — the exact
// class isRegionMismatch() (scripts/lib/ticket-link-discovery.js) exists to
// stop, but it was never wired into this writer. This file had zero CI
// coverage before this test (not in any test.yml push-path filter), which is
// how the regression shipped unnoticed 6 times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTicketmasterFromResults } from './fix-platform-ticket-links.js';

const WEST_END_SHOW = {
  id: 'a-christmas-carol-west-end-2026',
  title: 'A Christmas Carol',
  market: 'west-end',
};

const BROADWAY_SHOW = {
  id: 'some-broadway-show-2026',
  title: 'Some Broadway Show',
  market: 'broadway',
};

const CORRECT_UK_URL = 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/890378';
const WRONG_US_URL = 'https://www.ticketmaster.com/a-christmas-carol-ny-tickets/artist/2923062';

test('SERP match on a US-only result is rejected for a West End show (region mismatch)', () => {
  const results = [
    { url: WRONG_US_URL, title: 'A Christmas Carol (NY) Tickets | Ticketmaster.com' },
  ];
  const match = matchTicketmasterFromResults(results, WEST_END_SHOW, CORRECT_UK_URL);
  assert.equal(match, null, 'a region-mismatched result must never be treated as a match');
});

test('SERP match on the correct .co.uk result confirms the existing UK link', () => {
  const results = [
    { url: CORRECT_UK_URL, title: 'A Christmas Carol Tickets | Ticketmaster.co.uk' },
  ];
  const match = matchTicketmasterFromResults(results, WEST_END_SHOW, CORRECT_UK_URL);
  assert.deepEqual(match, { status: 'ok' });
});

test('SERP match on a different .co.uk result updates to the new UK URL', () => {
  const newUkUrl = 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/999999';
  const results = [
    { url: newUkUrl, title: 'A Christmas Carol Tickets | Ticketmaster.co.uk' },
  ];
  const match = matchTicketmasterFromResults(results, WEST_END_SHOW, CORRECT_UK_URL);
  assert.deepEqual(match, { status: 'updated', newUrl: newUkUrl });
});

test('US Ticketmaster results still match normally for a Broadway show (no regression)', () => {
  const usUrl = 'https://www.ticketmaster.com/some-broadway-show-tickets/artist/1234567';
  const results = [
    { url: usUrl, title: 'Some Broadway Show Tickets | Ticketmaster.com' },
  ];
  const match = matchTicketmasterFromResults(results, BROADWAY_SHOW, 'https://www.ticketmaster.com/stale-url/artist/1');
  assert.deepEqual(match, { status: 'updated', newUrl: usUrl });
});

test('a region-mismatched result is skipped in favor of a later valid one', () => {
  const correctUpdate = 'https://www.ticketmaster.co.uk/a-christmas-carol-tickets/artist/555';
  const results = [
    { url: WRONG_US_URL, title: 'A Christmas Carol (NY) Tickets | Ticketmaster.com' },
    { url: correctUpdate, title: 'A Christmas Carol Tickets | Ticketmaster.co.uk' },
  ];
  const match = matchTicketmasterFromResults(results, WEST_END_SHOW, CORRECT_UK_URL);
  assert.deepEqual(match, { status: 'updated', newUrl: correctUpdate });
});
