import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate } = require('../../scripts/lib/deduplication.js');

// Regression: alice-in-wonderland-off-west-end-2026 (announced, Marylebone Theatre)
// was flagged as duplicate of alice-in-wonderland-west-end-2026 (closed, Riverside Studios)
// because the announced show had no venue at the time it was added, so the venue-diff
// shortcut didn't fire and both years were 2026.
test('closed + announced same-title same-market = not duplicate (temporal non-overlap)', () => {
  const closed = {
    id: 'alice-in-wonderland-west-end-2026',
    title: 'Alice in Wonderland',
    status: 'closed',
    category: 'off-west-end',
    venue: 'Riverside Studios',
    openingDate: '2026-03-27',
    closingDate: '2026-04-12',
  };
  const announced = {
    id: 'alice-in-wonderland-off-west-end-2026',
    title: 'Alice In Wonderland',
    status: 'announced',
    category: 'off-west-end',
    venue: null, // no venue yet when first added — this was the trigger
    openingDate: null,
  };
  const result = checkForDuplicate(announced, [closed]);
  assert.equal(result.isDuplicate, false, `should not be duplicate: ${result.reason}`);
});

test('closed + upcoming same-title same-market = not duplicate', () => {
  const closed = {
    id: 'cats-west-end-2021',
    title: 'Cats',
    status: 'closed',
    category: 'west-end',
    openingDate: '2021-05-01',
    closingDate: '2021-08-01',
  };
  const upcoming = {
    id: 'cats-west-end-2026',
    title: 'Cats',
    status: 'upcoming',
    category: 'west-end',
    openingDate: '2026-12-01',
  };
  const result = checkForDuplicate(upcoming, [closed]);
  assert.equal(result.isDuplicate, false, `should not be duplicate: ${result.reason}`);
});

test('closed + open same-title same-market same-year = still a duplicate (data error)', () => {
  // Two "open" entries for the same production = likely data error, should still flag
  const a = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    status: 'open',
    category: 'broadway',
    venue: 'Richard Rodgers Theatre',
    openingDate: '2015-08-06',
  };
  const b = {
    id: 'hamilton-2015-dup',
    title: 'Hamilton',
    status: 'open',
    category: 'broadway',
    venue: 'Richard Rodgers Theatre',
    openingDate: '2015-08-06',
  };
  const result = checkForDuplicate(b, [a]);
  assert.equal(result.isDuplicate, true, 'same open show at same venue should be flagged');
});

test('closed + previews same-title same-market different venue = not duplicate (Alice regression)', () => {
  // Regression: alice-in-wonderland-off-west-end-2026 entered previews at Marylebone Theatre
  // while alice-in-wonderland-west-end-2026 was already closed at Riverside Studios.
  // The venue check was skipped for previews/open shows, causing a false positive.
  const closed = {
    id: 'alice-in-wonderland-west-end-2026',
    title: 'Alice in Wonderland',
    status: 'closed',
    category: 'off-west-end',
    venue: 'Riverside Studios',
    openingDate: '2026-03-27',
    closingDate: '2026-04-12',
  };
  const previewing = {
    id: 'alice-in-wonderland-off-west-end-2026',
    title: 'Alice In Wonderland',
    status: 'previews',
    category: 'off-west-end',
    venue: 'Marylebone Theatre',
    openingDate: null,
  };
  const result = checkForDuplicate(previewing, [closed]);
  assert.equal(result.isDuplicate, false, `closed+previews different venue should not be duplicate: ${result.reason}`);
});

test('closed + open same-title same-market different venue = not duplicate', () => {
  const closed = {
    id: 'alice-in-wonderland-west-end-2026',
    title: 'Alice in Wonderland',
    status: 'closed',
    category: 'off-west-end',
    venue: 'Riverside Studios',
    openingDate: '2026-03-27',
    closingDate: '2026-04-12',
  };
  const open = {
    id: 'alice-in-wonderland-off-west-end-2026',
    title: 'Alice In Wonderland',
    status: 'open',
    category: 'off-west-end',
    venue: 'Marylebone Theatre',
    openingDate: null,
  };
  const result = checkForDuplicate(open, [closed]);
  assert.equal(result.isDuplicate, false, `closed+open different venue should not be duplicate: ${result.reason}`);
});

test('wrongly-reopened show (open + no closingDate) + new show at different venue = not duplicate', () => {
  // Regression: USS "reopens" alice-in-wonderland-west-end-2026 because TodayTix id=46313
  // still lists it (the ID actually refers to the new Marylebone production). USS changes
  // status to open and deletes closingDate. The old isDefinitelyClosed check no longer
  // fires. The open-show branch then falls through year=2026 vs year=null → returns false.
  const wronglyReopened = {
    id: 'alice-in-wonderland-west-end-2026',
    title: 'Alice in Wonderland',
    status: 'open', // wrongly reopened by USS
    category: 'off-west-end',
    venue: 'Riverside Studios',
    openingDate: '2026-03-27',
    closingDate: undefined, // deleted by USS reopen logic
  };
  const newShow = {
    id: 'alice-in-wonderland-off-west-end-2026',
    title: 'Alice In Wonderland',
    status: 'announced',
    category: 'off-west-end',
    venue: 'Marylebone Theatre',
    openingDate: null,
  };
  const result = checkForDuplicate(newShow, [wronglyReopened]);
  assert.equal(result.isDuplicate, false, `wrongly-reopened show at different venue should not be duplicate: ${result.reason}`);
});

test('past closingDate counts as closed even without closed status', () => {
  const pastClose = {
    id: 'some-show-west-end-2024',
    title: 'Some Show',
    status: 'open', // stale status, but closingDate is past
    category: 'west-end',
    closingDate: '2024-06-01',
  };
  const announced = {
    id: 'some-show-west-end-2026',
    title: 'Some Show',
    status: 'announced',
    category: 'west-end',
    openingDate: null,
  };
  const result = checkForDuplicate(announced, [pastClose]);
  assert.equal(result.isDuplicate, false, `past-closingDate show should be treated as closed: ${result.reason}`);
});

// Regression (2026-07-18): jack-and-the-beanstalk-theatre-on-kew (previews, Theatre
// on Kew, summer run) was flagged as duplicate of Hackney Empire's announced
// Christmas panto — same title, same category, same year, CONFIRMED different
// venues. The existing-active branch already treated venue-diff as separate when
// the EXISTING show was the active one; the check was direction-asymmetric.
test('active + announced same-title same-category at confirmed different venues = not duplicate (either direction)', () => {
  const kew = {
    id: 'jack-and-the-beanstalk-theatre-on-kew-off-west-end-2026',
    title: 'Jack and the Beanstalk - Theatre on Kew',
    status: 'previews',
    category: 'off-west-end',
    venue: 'Theatre on Kew',
    openingDate: null,
    previewsStartDate: '2026-07-18',
    closingDate: '2026-08-23',
  };
  const hackney = {
    id: 'jack-and-the-beanstalk-off-west-end-2026',
    title: 'Jack and The Beanstalk',
    status: 'announced',
    category: 'off-west-end',
    venue: 'Hackney Empire',
    openingDate: null,
    previewsStartDate: '2026-11-21',
    closingDate: '2026-12-31',
  };
  const a = checkForDuplicate(kew, [hackney]);
  assert.equal(a.isDuplicate, false, `kew-vs-hackney should not be duplicate: ${a.reason}`);
  const b = checkForDuplicate(hackney, [kew]);
  assert.equal(b.isDuplicate, false, `hackney-vs-kew should not be duplicate: ${b.reason}`);
});
