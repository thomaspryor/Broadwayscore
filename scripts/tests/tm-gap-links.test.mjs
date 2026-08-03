// Task #956: TM-link backfill for TodayTix-gap shows.
//
// IMPORTANT CONTEXT for anyone re-running this after a gap-list change:
// the original card asked for "at least 15" TodayTix-gap shows to carry a
// Ticketmaster link. Two independent research passes (WebSearch + Playwright
// verification) checked all 41 non-Met-Opera gap shows (of 52 total; Met
// Opera sells via metopera.org, never Ticketmaster) and found only 3 with a
// genuine, currently-live Ticketmaster event page: The Gruffalo, A Christmas
// Carol (Old Vic), and Derren Brown: Only Human — all West End. Every other
// gap show (Donmar Warehouse, National Theatre, 59E59, Soho Playhouse,
// Arena Stage, La Jolla Playhouse, etc.) sells exclusively through its own
// box office or a non-TM vendor (See Tickets, OvationTix, ATG, LW Theatres).
// One additional US "hit" (La Jolla's The Family Album) was excluded: its TM
// page is resale-marketplace-only with zero primary inventory ("Tickets for
// this event are not currently available on Ticketmaster"), the same dead-end
// pattern that got StubHub hidden. This test asserts the REAL, verified
// count rather than the originally-hoped-for 15 — see the session's Notion
// outcome for the full research trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getVisibleTicketLinks } from '../../src/lib/ticket-utils.ts';

const require = createRequire(import.meta.url);
const showsData = require('../../data/shows.json');
const shows = showsData.shows;

const TM_HOSTS = ['ticketmaster.com', 'ticketmaster.co.uk'];

function isValidTmHost(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TM_HOSTS.some(h => hostname === h || hostname.endsWith(`.${h}`));
}

const LIVE_STATUSES = new Set(['open', 'upcoming', 'previews']);
const liveShows = shows.filter(s => LIVE_STATUSES.has(s.status));

test('every live/upcoming show Ticketmaster link points at ticketmaster.com or ticketmaster.co.uk', () => {
  const bad = [];
  for (const show of liveShows) {
    for (const link of show.ticketLinks || []) {
      if (link.platform === 'Ticketmaster' && !isValidTmHost(link.url)) {
        bad.push(`${show.id}: ${link.url}`);
      }
    }
  }
  assert.deepEqual(bad, [], `Ticketmaster links with invalid host:\n${bad.join('\n')}`);
});

test('verified TodayTix-gap shows carry a real Ticketmaster link', () => {
  const EXPECTED = {
    'the-gruffalo-west-end-2026': 'ticketmaster.co.uk',
    'a-christmas-carol-west-end-2026': 'ticketmaster.co.uk',
    'derren-brown-only-human-west-end-2026': 'ticketmaster.co.uk',
  };

  for (const [id, expectedHost] of Object.entries(EXPECTED)) {
    const show = shows.find(s => s.id === id);
    assert.ok(show, `show ${id} should exist in shows.json`);
    const tm = (show.ticketLinks || []).find(l => l.platform === 'Ticketmaster');
    assert.ok(tm, `show ${id} should carry a Ticketmaster link`);
    assert.ok(tm.url.includes(expectedHost), `${id} TM url should be on ${expectedHost}, got ${tm.url}`);
  }
});

test('TodayTix-gap shows without TodayTix have at least 3 real Ticketmaster links (documented ceiling — see file header)', () => {
  const gapWithTm = liveShows.filter(s => {
    const links = s.ticketLinks || [];
    const hasTodayTix = links.some(l => l.platform === 'TodayTix');
    const hasTm = links.some(l => l.platform === 'Ticketmaster');
    return !hasTodayTix && hasTm;
  });
  assert.ok(
    gapWithTm.length >= 3,
    `expected at least 3 TodayTix-gap shows with a Ticketmaster link, got ${gapWithTm.length}`
  );
});

test('getVisibleTicketLinks renders Ticketmaster for a gap show even with a non-TodayTix sibling link', () => {
  const links = [
    { platform: 'Venue Box Office', url: 'https://example.com/box-office' },
    { platform: 'Ticketmaster', url: 'https://www.ticketmaster.co.uk/example' },
  ];
  const visible = getVisibleTicketLinks(links);
  assert.ok(visible.some(l => l.platform === 'Ticketmaster'), 'Ticketmaster should be visible when no TodayTix link is present');
});

test('getVisibleTicketLinks still hides Ticketmaster when TodayTix is present (evergreen-show behavior unchanged)', () => {
  const links = [
    { platform: 'TodayTix', url: 'https://todaytix.com/example' },
    { platform: 'Official Site', url: 'https://example.com' },
    { platform: 'Ticketmaster', url: 'https://www.ticketmaster.com/example' },
  ];
  const visible = getVisibleTicketLinks(links);
  assert.ok(!visible.some(l => l.platform === 'Ticketmaster'), 'Ticketmaster should stay hidden when TodayTix is present');
});

test('getVisibleTicketLinks still hides StubHub even when it would be the only link (unchanged sole-seller carve-out exclusion)', () => {
  const links = [{ platform: 'StubHub', url: 'https://stubhub.com/example' }];
  const visible = getVisibleTicketLinks(links);
  assert.deepEqual(visible, [], 'StubHub-only links should render zero visible links');
});
