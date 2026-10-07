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
// pattern that got StubHub hidden. This test checks the verified shows
// (VERIFIED_TM_GAP below) rather than the originally-hoped-for 15. It
// asserts no count of live gap shows, because shows leave the gap as they
// close or gain TodayTix. See the session's Notion outcome for the research.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getVisibleTicketLinks } from '../../src/lib/ticket-utils.ts';

const require = createRequire(import.meta.url);
const { isRegionMismatch } = require('../lib/ticket-link-discovery.js');
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

// Corpus gate for the market/storefront class, not just Ticketmaster: the
// original failure was a West End show (Old Vic) carrying the US
// ticketmaster.com "A Christmas Carol (NY)" artist page — a valid host, wrong
// country, unbuyable for the user (task #1002). pickTicketUrl() now refuses
// these at write time, but that only covers the SERP fallback writer; this
// assertion covers ANY producer, including a hand-edited backfill (which is
// how the bad link got in).
test('no live/upcoming show links to a ticket storefront that cannot sell its market', () => {
  const bad = [];
  for (const show of liveShows) {
    for (const link of show.ticketLinks || []) {
      if (isRegionMismatch(link.url, show)) {
        bad.push(`${show.id} (${show.market || show.category}): ${link.platform} ${link.url}`);
      }
    }
  }
  assert.deepEqual(bad, [], `ticket links on the wrong regional storefront:\n${bad.join('\n')}`);
});

// Verified gap shows and their Ticketmaster host. The Gruffalo (Lyric) left
// on 2026-09-08 when it closed and its TM page went dead. Re-verify and add
// when a new gap show gets a live TM page.
const VERIFIED_TM_GAP = {
  'a-christmas-carol-west-end-2026': 'ticketmaster.co.uk',
  'derren-brown-only-human-west-end-2026': 'ticketmaster.co.uk',
};

// These assertions follow the live data, so they must only fail on a real
// loss. A verified show that closes, or that gains TodayTix (Derren Brown did
// on 2026-10-07 and turned main red under the old ">= 2 gap shows" count,
// BRO-4842), has left the gap; that is not a regression. A past closingDate
// counts as closed even while the status flip lags, since TM pages die then.
const today = new Date().toISOString().slice(0, 10);
const stillInGap = Object.keys(VERIFIED_TM_GAP)
  .map(id => liveShows.find(s => s.id === id))
  .filter(s => s && !(s.closingDate && s.closingDate < today))
  .filter(s => !(s.ticketLinks || []).some(l => l.platform === 'TodayTix'));

test('every verified gap id still exists in shows.json (a rename would silently empty the checks below)', () => {
  for (const id of Object.keys(VERIFIED_TM_GAP)) {
    assert.ok(shows.some(s => s.id === id), `show ${id} should exist in shows.json; update VERIFIED_TM_GAP if it was renamed`);
  }
});

test('verified TodayTix-gap shows still live and still without TodayTix carry their Ticketmaster link', (t) => {
  if (stillInGap.length === 0) t.diagnostic('no verified gap show is still live without TodayTix; only the fixture tests below guard the rendering rule');
  for (const show of stillInGap) {
    const expectedHost = VERIFIED_TM_GAP[show.id];
    const tm = (show.ticketLinks || []).find(l => l.platform === 'Ticketmaster');
    assert.ok(tm, `show ${show.id} should carry a Ticketmaster link`);
    assert.ok(tm.url.includes(expectedHost), `${show.id} TM url should be on ${expectedHost}, got ${tm.url}`);
  }
});

test('verified gap shows still in the gap render their Ticketmaster link', () => {
  for (const show of stillInGap) {
    const visible = getVisibleTicketLinks(show.ticketLinks || []);
    assert.ok(visible.some(l => l.platform === 'Ticketmaster'), `${show.id} hides its only Ticketmaster link`);
  }
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
