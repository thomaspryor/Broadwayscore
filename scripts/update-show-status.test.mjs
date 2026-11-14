import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// BRO-4286 — TodayTix reopen-guard trusted feed presence over actual
// bookability: my-joy-is-heavy-off-broadway-2025 was silently reopened
// (status flipped closed->open, closingDate deleted) because TodayTix's bulk
// feed carried a stale "ghost listing" (same todaytixId + title) for ~15
// days after the show actually closed. The guard now requires positive
// bookability evidence — see scripts/lib/todaytix-reopen-guard.js.
//
// require.main === module guards updateShowStatuses() from running at
// require time (CLAUDE.md rule 15 — require() the real function, don't
// reimplement its logic in the test).
const require = createRequire(import.meta.url);
const { hasBookableEvidence } = require('./lib/todaytix-reopen-guard.js');
const { refreshTodayTixDates } = require('./update-show-status.js');

// ── hasBookableEvidence (pure predicate) ──

test('hasBookableEvidence: true when areRegularTicketsAvailable is true', () => {
  assert.equal(hasBookableEvidence({ areRegularTicketsAvailable: true }), true);
});

test('hasBookableEvidence: false when areRegularTicketsAvailable is false and no showtimes/bookingEndDate', () => {
  assert.equal(
    hasBookableEvidence({
      areRegularTicketsAvailable: false,
      filteredShowtimeMaps: [],
      bookingEndDate: null,
    }),
    false
  );
});

test('hasBookableEvidence: false for a stale ghost listing (closingDatetime:null, empty showtimes)', () => {
  // Shape mirrors the live my-joy-is-heavy ghost listing observed 2026-09-29
  assert.equal(
    hasBookableEvidence({
      areRegularTicketsAvailable: false,
      closingDatetime: null,
      filteredShowtimeMaps: [],
      showtimes: [],
      bookingEndDate: null,
    }),
    false
  );
});

test('hasBookableEvidence: true when showtimes are non-empty even if the ticket flag is missing', () => {
  assert.equal(
    hasBookableEvidence({ filteredShowtimeMaps: [{ date: '2026-10-01' }] }),
    true
  );
});

test('hasBookableEvidence: true when bookingEndDate is in the future', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  assert.equal(
    hasBookableEvidence({ areRegularTicketsAvailable: false, bookingEndDate: '2026-12-01' }, now),
    true
  );
});

test('hasBookableEvidence: false when bookingEndDate is in the past', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  assert.equal(
    hasBookableEvidence({ areRegularTicketsAvailable: false, bookingEndDate: '2026-04-05' }, now),
    false
  );
});

test('hasBookableEvidence: false for missing/null ttShow', () => {
  assert.equal(hasBookableEvidence(null), false);
  assert.equal(hasBookableEvidence(undefined), false);
});

test('hasBookableEvidence: true when showtimes is non-empty even if filteredShowtimeMaps is present-but-empty', () => {
  // Regression: `a || b` would pick the present-but-empty filteredShowtimeMaps
  // array (truthy) and never look at showtimes at all.
  assert.equal(
    hasBookableEvidence({
      areRegularTicketsAvailable: false,
      filteredShowtimeMaps: [],
      showtimes: [{ date: '2026-10-01' }],
    }),
    true
  );
});

// ── refreshTodayTixDates integration (BRO-4286 acceptance scenario) ──

function makeClosedShow(overrides = {}) {
  return {
    id: 'my-joy-is-heavy-off-broadway-2025',
    title: 'My Joy Is Heavy',
    category: 'off-broadway',
    status: 'closed',
    todaytixId: 44328,
    closingDate: '2026-04-05',
    ...overrides,
  };
}

test('refreshTodayTixDates: does NOT reopen a closed show whose TT listing has no bookable evidence', async () => {
  const data = { shows: [makeClosedShow()] };
  const updates = [];

  const fetchShows = async (locationId) => {
    if (locationId !== 1) return [];
    return [
      {
        id: 44328,
        displayName: 'My Joy Is Heavy',
        endDate: 'null',
        areRegularTicketsAvailable: false,
        filteredShowtimeMaps: [],
        bookingEndDate: null,
      },
    ];
  };

  await refreshTodayTixDates(data, updates, { fetchShows });

  const show = data.shows[0];
  assert.equal(show.status, 'closed', 'show must remain closed');
  assert.equal(show.closingDate, '2026-04-05', 'closingDate must be preserved');
  assert.equal(
    updates.some(u => u.id === show.id && u.changes.status),
    false,
    'no reopen update should be recorded'
  );
});

test('refreshTodayTixDates: DOES reopen a closed show with positive bookability evidence', async () => {
  const data = { shows: [makeClosedShow()] };
  const updates = [];

  const fetchShows = async (locationId) => {
    if (locationId !== 1) return [];
    return [
      {
        id: 44328,
        displayName: 'My Joy Is Heavy',
        endDate: '2027-01-15',
        areRegularTicketsAvailable: true,
      },
    ];
  };

  await refreshTodayTixDates(data, updates, { fetchShows });

  const show = data.shows[0];
  assert.equal(show.status, 'open', 'show should reopen when TT shows real bookability');
  assert.equal(show.closingDate, '2027-01-15');
});

test('refreshTodayTixDates: does NOT reopen a human-corrected closing date, even with bookable evidence', async () => {
  const data = {
    shows: [
      makeClosedShow({
        humanCorrectedClosingDate: true,
        closingDateSource: 'owner manual correction',
      }),
    ],
  };
  const updates = [];

  const fetchShows = async (locationId) => {
    if (locationId !== 1) return [];
    return [
      {
        id: 44328,
        displayName: 'My Joy Is Heavy',
        endDate: '2027-01-15',
        areRegularTicketsAvailable: true,
      },
    ];
  };

  await refreshTodayTixDates(data, updates, { fetchShows });

  const show = data.shows[0];
  assert.equal(show.status, 'closed', 'human-corrected closure must not be reopened by TodayTix');
  assert.equal(show.closingDate, '2026-04-05', 'closingDate must be preserved');
});

// BRO-4883: stale-open auto-close has no closingDate to write. For West End
// that produced a closed row with a null closingDate, which validate-data.js
// rejects and the BRO-3792 unit test fails on main. West End stays open;
// Off-Broadway keeps the existing behaviour.
test('refreshTodayTixDates: stale-open detection never closes a West End show (no closingDate to write), still closes Off-Broadway', async () => {
  const longAgo = '2026-01-01';
  const data = {
    shows: [
      { id: 'stale-we-west-end-2026', title: 'Stale WE', category: 'west-end', status: 'open', todaytixId: 77001, _staleMissingSince: longAgo },
      { id: 'stale-ob-off-broadway-2026', title: 'Stale OB', category: 'off-broadway', status: 'open', todaytixId: 77002, _staleMissingSince: longAgo },
    ],
  };
  const updates = [];
  await refreshTodayTixDates(data, updates, { fetchShows: async () => [] });
  const [we, ob] = data.shows;
  assert.equal(we.status, 'open', 'West End must not be closed without a closingDate');
  assert.equal(we.closingDate, undefined);
  assert.equal(updates.some(u => u.id === we.id && u.changes.status), false);
  assert.equal(ob.status, 'closed', 'Off-Broadway stale-open close is unchanged');
});

test('refreshTodayTixDates: an open show whose TT listing has no bookable evidence is NOT treated as confirmed-active', async () => {
  const data = {
    shows: [
      {
        id: 'ghost-listing-off-broadway-2026',
        title: 'Ghost Listing',
        category: 'off-broadway',
        status: 'open',
        todaytixId: 99001,
      },
    ],
  };
  const updates = [];

  const fetchShows = async (locationId) => {
    if (locationId !== 1) return [];
    return [
      {
        id: 99001,
        displayName: 'Ghost Listing',
        endDate: 'null',
        areRegularTicketsAvailable: false,
        filteredShowtimeMaps: [],
      },
    ];
  };

  const { ttActiveShowIds } = await refreshTodayTixDates(data, updates, { fetchShows });

  const show = data.shows[0];
  assert.equal(
    ttActiveShowIds.has(show.id),
    false,
    'a ghost listing (no bookable evidence) must not count as TodayTix-confirmed-active'
  );
  // Feed presence with no bookable evidence starts stale-open tracking on first miss
  // rather than clearing it — same conservative 3-day grace period as a true absence.
  assert.equal(show._staleMissingSince, new Date().toISOString().split('T')[0]);
});
