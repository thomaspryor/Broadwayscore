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

// Regression (BRO-622): Chess 1988 (original Broadway run) vs Chess 2025 (revival)
// were flagged by CI as duplicates — both closed, both at the Imperial Theatre,
// only the 2025 revival has an ibdbUrl. Same-venue-when-closed used to be
// evaluated only via the "existing is open/previews" branch; both being closed
// falls to the final `Math.abs(newYear - existingYear) > 2` check, which is
// correct here (37yr gap) — this test locks that behavior in either direction.
test('closed + closed same-title same-venue >2yr apart (historical revival) = not duplicate (Chess regression)', () => {
  const original = {
    id: 'chess-1988',
    title: 'Chess',
    status: 'closed',
    category: 'broadway',
    venue: 'Imperial Theatre',
    openingDate: '1988-04-28',
    previewsStartDate: '1988-04-11',
    closingDate: '1988-06-25',
  };
  const revival = {
    id: 'chess-2025',
    title: 'Chess',
    status: 'closed',
    category: 'broadway',
    venue: 'Imperial Theatre',
    openingDate: '2025-11-16',
    previewsStartDate: '2025-10-15',
    closingDate: '2026-06-21',
    ibdbUrl: 'https://www.ibdb.com/broadway-production/chess-543200',
  };
  const a = checkForDuplicate(original, [revival]);
  assert.equal(a.isDuplicate, false, `chess-1988-vs-2025 should not be duplicate: ${a.reason}`);
  const b = checkForDuplicate(revival, [original]);
  assert.equal(b.isDuplicate, false, `chess-2025-vs-1988 should not be duplicate: ${b.reason}`);
});

// ── BRO-4204 S5-T1: start-after-close ──────────────────────────────────────
// Same-title dedup treated a transfer or a return engagement as the old show
// whenever the new row was open/previews (isMultiProduction only exempted
// closed-vs-ANNOUNCED pairs), which hid all three of these from discovery
// until Sprint 0's isCrossLinked stopgap. The fixtures below are the real
// rows' dates, with the priorRuns cross-links deliberately left OFF so the
// verdict comes from the dates alone. Each pair is checked in both directions
// (validate-shows-prebuild.js walks shows.json in file order) and, for the
// transfers, also as the venue-less discovery stub that actually arrives.
const { startsAfterExistingRun, findSameTitleTwinIfNoOpeningDate, NEW_PRODUCTION_VENUE_GAP_DAYS } = require('../../scripts/lib/deduplication.js');

const noDup = (candidate, existing, label) => {
  const r = checkForDuplicate(candidate, [existing]);
  assert.equal(r.isDuplicate, false, `${label}: should be a new production, got "${r.reason}"`);
};
const dup = (candidate, existing, label) => {
  const r = checkForDuplicate(candidate, [existing]);
  assert.equal(r.isDuplicate, true, `${label}: should still be a duplicate`);
  assert.equal(r.existingShow.id, existing.id);
};

const itwBridge = {
  id: 'into-the-woods-west-end-2025', title: 'Into the Woods', slug: 'into-the-woods-west-end-2025',
  category: 'off-west-end', venue: 'Bridge Theatre', status: 'closed',
  previewsStartDate: '2025-12-02', openingDate: '2025-12-11', closingDate: '2026-05-30',
};
const itwNoelCoward = {
  id: 'into-the-woods-noel-coward-west-end-2026', title: 'Into the Woods', slug: 'into-the-woods-noel-coward-west-end',
  category: 'west-end', venue: 'Noël Coward Theatre', status: 'previews',
  previewsStartDate: '2026-09-22', openingDate: '2026-10-07', closingDate: '2027-01-09',
};

test('S5-T1 Into the Woods: the Noël Coward transfer starting after the Bridge run closed is a new production (both directions, and as a venue-less stub)', () => {
  noDup(itwNoelCoward, itwBridge, 'Noël Coward vs Bridge');
  noDup(itwBridge, itwNoelCoward, 'Bridge vs Noël Coward (reverse)');
  const stub = { title: 'Into the Woods', category: 'west-end', venue: null, status: 'previews', previewsStartDate: '2026-09-22', openingDate: null };
  noDup(stub, itwBridge, 'venue-less previews stub vs Bridge');
});

const arcadiaOldVic = {
  id: 'arcadia-west-end-2026', title: 'Arcadia', slug: 'arcadia-west-end',
  category: 'west-end', venue: 'The Old Vic', status: 'closed',
  previewsStartDate: '2026-01-24', openingDate: '2026-02-04', closingDate: '2026-03-21',
};
const arcadiaDukeOfYorks = {
  id: 'arcadia-duke-of-yorks-west-end-2026', title: 'Arcadia', slug: 'arcadia-duke-of-yorks-west-end',
  category: 'west-end', venue: "Duke of York's Theatre", status: 'previews',
  previewsStartDate: '2026-06-20', openingDate: '2026-07-01', closingDate: '2026-09-12',
};

test("S5-T1 Arcadia: the Duke of York's transfer starting after the Old Vic run closed is a new production (same category, both directions, venue-less stub)", () => {
  noDup(arcadiaDukeOfYorks, arcadiaOldVic, "Duke of York's vs Old Vic");
  noDup(arcadiaOldVic, arcadiaDukeOfYorks, "Old Vic vs Duke of York's (reverse)");
  const stub = { title: 'Arcadia', category: 'west-end', venue: null, status: 'previews', previewsStartDate: '2026-06-20', openingDate: null };
  noDup(stub, arcadiaOldVic, 'venue-less previews stub vs Old Vic');
});

const ldvSpring = {
  id: 'lost-in-del-valle-off-broadway-2026', title: 'Lost in Del Valle', slug: 'lost-in-del-valle-off-broadway',
  category: 'off-broadway', venue: 'SoHo Playhouse', status: 'closed',
  previewsStartDate: '2026-04-09', openingDate: '2026-04-09', closingDate: '2026-05-03',
};
const ldvReturn = {
  id: 'lost-in-del-valle-return-off-broadway-2026', title: 'Lost in Del Valle', slug: 'lost-in-del-valle-return-off-broadway',
  category: 'off-broadway', venue: 'SoHo Playhouse', status: 'open',
  previewsStartDate: '2026-09-14', openingDate: '2026-09-23', closingDate: '2026-10-14',
};

test('S5-T1 Lost in Del Valle: a return engagement at the SAME venue after the spring run closed is a new production (both directions, openingDate-less stub)', () => {
  noDup(ldvReturn, ldvSpring, 'September return vs April run');
  noDup(ldvSpring, ldvReturn, 'April run vs September return (reverse)');
  const stub = { title: 'Lost in Del Valle', category: 'off-broadway', venue: 'SoHo Playhouse', status: 'open', previewsStartDate: '2026-09-14', openingDate: null };
  noDup(stub, ldvSpring, 'same-venue open stub vs April run');
});

test('S5-T1: a same-title candidate starting DURING the existing run stays a duplicate (same venue, venue-less, and against a closed run)', () => {
  const running = { id: 'some-show-2026', title: 'Some Show', slug: 'some-show', category: 'broadway', venue: 'Booth Theatre', status: 'open', openingDate: '2026-06-01', closingDate: '2026-12-31' };
  dup({ title: 'Some Show', category: 'broadway', venue: 'Booth Theatre', status: 'previews', previewsStartDate: '2026-09-01' }, running, 'same venue, starts mid-run');
  dup({ title: 'Some Show', category: 'broadway', venue: null, status: 'previews', previewsStartDate: '2026-09-01' }, running, 'no venue, starts mid-run');
  dup({ title: 'Lost in Del Valle', category: 'off-broadway', venue: 'SoHo Playhouse', status: 'previews', previewsStartDate: '2026-04-20', openingDate: null }, ldvSpring, 'starts inside the closed spring run');
});

test('S5-T1: a start after a still-open run\'s announced closingDate is a new production (Pride shape: Dorfman closing 2026-09-12, Bridge return from 2026-11-12)', () => {
  const dorfmanStillOpen = { id: 'pride-west-end-2026', title: 'Pride', slug: 'pride-west-end', category: 'west-end', venue: 'Dorfman Theatre', status: 'open', previewsStartDate: '2026-06-11', openingDate: '2026-06-25', closingDate: '2026-09-12' };
  noDup({ title: 'Pride', category: 'west-end', venue: null, status: 'previews', previewsStartDate: '2026-11-12', openingDate: null }, dorfmanStillOpen, 'venue-less previews stub after the announced close');
});

test('S5-T1: an open twin with NO closingDate is never cleared by a later start (long-runner protection intact)', () => {
  const hamilton = { id: 'hamilton-2015', title: 'Hamilton', slug: 'hamilton', category: 'broadway', venue: 'Richard Rodgers Theatre', status: 'open', previewsStartDate: '2015-07-13', openingDate: '2015-08-06' };
  dup({ title: 'Hamilton', category: 'broadway', venue: 'Richard Rodgers Theatre', status: 'open', previewsStartDate: '2026-09-01' }, hamilton, 'TodayTix relisting of a long-runner');
  dup({ title: 'Hamilton', category: 'broadway', venue: null, status: 'open', previewsStartDate: '2026-09-01' }, hamilton, 'venue-less relisting of a long-runner');
});

test('S5-T1: the National Theatre parent/child pair (same preview date, no close) stays a duplicate', () => {
  const existing = { id: 'electra-persona-west-end-2026', title: 'Electra / Persona', slug: 'electra-persona-west-end', venue: 'National Theatre', previewsStartDate: '2026-08-19', status: 'open', category: 'west-end' };
  const candidate = { id: 'electrapersona-west-end-2026', title: 'Electra/Persona', slug: 'electrapersona-west-end', venue: 'Lyttelton Theatre', previewsStartDate: '2026-08-19', status: 'previews', category: 'west-end' };
  dup(candidate, existing, 'Lyttelton vs bare National Theatre');
});

test('startsAfterExistingRun: symmetric, date-only, and silent on missing or unparseable dates', () => {
  assert.match(startsAfterExistingRun(itwNoelCoward, itwBridge), /starts after into-the-woods-west-end-2025 ended \(2026-05-30\)/);
  assert.match(startsAfterExistingRun(itwBridge, itwNoelCoward), /into-the-woods-noel-coward-west-end-2026 starts after/, 'reverse direction gives the same evidence');
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-09-01' }, { status: 'open', openingDate: '2015-08-06' }), null, 'open twin with no closingDate: no evidence');
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-04-20' }, ldvSpring), null, 'starts inside the run: no evidence');
  assert.equal(startsAfterExistingRun({ previewsStartDate: 'not-a-date' }, ldvSpring), null, 'unparseable start: no evidence');
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-09-14' }, { ...ldvSpring, closingDate: 'soon', openingDate: null, previewsStartDate: null }), null, 'unparseable close and no openingDate to fall back on: no evidence');
  assert.ok(startsAfterExistingRun({ previewsStartDate: '2026-09-14' }, { ...ldvSpring, closingDate: 'soon' }), 'unparseable close on a closed row falls back to its openingDate');
  assert.equal(startsAfterExistingRun({}, ldvSpring), null, 'undated candidate: no evidence');
  assert.equal(startsAfterExistingRun(null, ldvSpring), null);
});

test('startsAfterExistingRun: the earliest of previewsStartDate / unconfirmedStartDate / openingDate is the start; a closed row with no closingDate is dated by its openingDate', () => {
  // openingDate alone would clear the run, but the earlier previewsStartDate does not — the earliest start decides.
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-04-20', openingDate: '2026-06-01' }, ldvSpring), null);
  assert.ok(startsAfterExistingRun({ unconfirmedStartDate: '2027-02-03' }, ldvSpring), 'quarantined far-future start counts');
  assert.ok(startsAfterExistingRun({ openingDate: '2026-09-23' }, ldvSpring), 'openingDate alone counts');
  const closedNoCloseDate = { id: 'x-2026', status: 'closed', openingDate: '2026-02-01' };
  assert.ok(startsAfterExistingRun({ previewsStartDate: '2026-03-01' }, closedNoCloseDate), 'closed + openingDate only still dates the run');
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-03-01' }, { ...closedNoCloseDate, status: 'upcoming' }), null, 'the openingDate fallback is for closed rows only');
});

test('startsAfterExistingRun: the venue-gap clause needs venuesKnownDifferent AND 120+ days after the other row opened', () => {
  const opened = { id: 'y-2026', status: 'open', openingDate: '2026-01-01' };
  const fourMonthsOn = { previewsStartDate: '2026-05-01' };
  assert.equal(startsAfterExistingRun(fourMonthsOn, opened), null, 'without the venue flag the gap alone is nothing');
  assert.match(startsAfterExistingRun(fourMonthsOn, opened, { venuesKnownDifferent: true }), /different venue 120d after/);
  assert.equal(startsAfterExistingRun({ previewsStartDate: '2026-04-30' }, opened, { venuesKnownDifferent: true }), null, '119 days is inside the window');
  assert.equal(NEW_PRODUCTION_VENUE_GAP_DAYS, 120);
});

// The openingDate-less twin guard delegates to the same rule — previously it
// read only unconfirmedStartDate and only a status:'closed' twin.
test('twin guard: a previewsStartDate after the twin closed clears the guard, and a still-open twin with a FUTURE closingDate is cleared too; an open twin with no closingDate is not', () => {
  const dorfman = { id: 'pride-west-end-2026', title: 'Pride', category: 'west-end', venue: 'Dorfman Theatre', status: 'closed', openingDate: '2026-06-25', closingDate: '2026-09-12' };
  assert.equal(findSameTitleTwinIfNoOpeningDate({ title: 'Pride', category: 'west-end', venue: null, openingDate: null, previewsStartDate: '2026-11-12' }, [dorfman]), null, 'previewsStartDate after the close');
  assert.equal(findSameTitleTwinIfNoOpeningDate({ title: 'Pride', category: 'west-end', venue: null, openingDate: null, unconfirmedStartDate: '2026-11-12' }, [{ ...dorfman, status: 'open' }]), null, 'open twin whose announced closingDate precedes the start');
  // Relative dates here: isLongClosedTwin() releases any twin closed 18+
  // months ago, so a fixed close would silently flip this assertion later.
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentlyClosed = { ...dorfman, openingDate: iso(120), closingDate: iso(30) };
  assert.equal(findSameTitleTwinIfNoOpeningDate({ title: 'Pride', category: 'west-end', venue: null, openingDate: null, previewsStartDate: iso(60) }, [recentlyClosed]), recentlyClosed, 'start inside the run: still a twin');
  const hamilton = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', venue: 'Richard Rodgers Theatre', status: 'open', openingDate: '2015-08-06', closingDate: null };
  assert.equal(findSameTitleTwinIfNoOpeningDate({ title: 'Hamilton', category: 'broadway', venue: null, openingDate: null, previewsStartDate: '2026-09-01' }, [hamilton]), hamilton, 'open twin with no closingDate is never cleared');
});
