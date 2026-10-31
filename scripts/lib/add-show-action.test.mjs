/**
 * Tests for scripts/lib/add-show-action.js
 * Run: node --test scripts/lib/add-show-action.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyAddShow } = require('./add-show-action.js');

const base = () => ({ id: 'x-off-broadway-2023', title: 'X', slug: 'x-off-broadway-2023', venue: 'Playwrights Horizons', status: 'closed',
  type: 'play', category: 'off-broadway', market: 'broadway', openingDate: '2023-01-02', closingDate: '2023-02-03' });

test('adds a show and stamps discoverySource', () => {
  const shows = [];
  const r = applyAddShow(shows, { show: base() });
  assert.equal(r.ok, true);
  assert.equal(shows[0].discoverySource, 'manual-user-request');
});
// Historical promoters (promote-historical-we.js buildShowEntry) write season
// and evidenceUrls; a cloud session adds their rows through this action.
test('accepts the season and evidenceUrls a historical promoter writes', () => {
  const shows = [];
  const r = applyAddShow(shows, { show: { ...base(), season: '2019-2020', evidenceUrls: ['https://www.theatrerecord.com/x'], discoverySource: 'we-historical:review-led' } });
  assert.equal(r.ok, true);
  assert.equal(shows[0].season, '2019-2020');
  assert.equal(shows[0].discoverySource, 'we-historical:review-led');
});
test('refuses duplicate id and slug', () => {
  assert.equal(applyAddShow([{ id: 'a', slug: 'x-off-broadway-2023' }], { show: base() }).ok, false);
  assert.equal(applyAddShow([{ id: 'x-off-broadway-2023', slug: 'q' }], { show: base() }).ok, false);
});
test('refuses missing required, unknown field, bad status', () => {
  assert.equal(applyAddShow([], { show: { ...base(), venue: '' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), recouped: true } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), status: 'weird' } }).ok, false);
});
test('crossLinkFrom appends priorRuns once and requires the target', () => {
  const cur = { id: 'cur', slug: 'cur' };
  const r = applyAddShow([cur], { show: base(), crossLinkFrom: 'cur' });
  assert.equal(r.ok, true);
  assert.deepEqual(cur.priorRuns, [{ id: 'x-off-broadway-2023', openingDate: '2023-01-02', closingDate: '2023-02-03', venue: 'Playwrights Horizons' }]);
  assert.equal(applyAddShow([], { show: base(), crossLinkFrom: 'nope' }).ok, false);
});
test('refuses a placeholder venue', () => {
  assert.equal(applyAddShow([], { show: { ...base(), venue: 'TBA' } }).ok, false);
});
test('stores the trimmed venue, same as the priorRuns link', () => {
  const cur = { id: 'cur', slug: 'cur' };
  const shows = [cur];
  applyAddShow(shows, { show: { ...base(), venue: '  Playwrights Horizons ' }, crossLinkFrom: 'cur' });
  assert.equal(shows[1].venue, 'Playwrights Horizons');
  assert.equal(cur.priorRuns[0].venue, 'Playwrights Horizons');
});

test('priorRunOf puts a priorRuns link to the earlier run on the NEW entry', () => {
  const old = { id: 'old', slug: 'old', venue: 'SoHo Playhouse', openingDate: '2026-04-09', closingDate: '2026-05-03' };
  const shows = [old];
  const r = applyAddShow(shows, { show: base(), priorRunOf: 'old' });
  assert.equal(r.ok, true);
  assert.deepEqual(shows[1].priorRuns, [{ id: 'old', venue: 'SoHo Playhouse', openingDate: '2026-04-09', closingDate: '2026-05-03' }]);
  assert.equal(old.priorRuns, undefined);
  assert.equal(applyAddShow([], { show: base(), priorRunOf: 'nope' }).ok, false);
});

test('priorRunOf refuses an earlier run with no openingDate', () => {
  const old = { id: 'old', slug: 'old', venue: 'SoHo Playhouse', openingDate: null };
  const shows = [old];
  assert.equal(applyAddShow(shows, { show: base(), priorRunOf: 'old' }).ok, false);
  assert.equal(shows.length, 1);
});

const regional = () => ({ id: 'x-regional-2026', title: 'X', slug: 'x-regional-2026', venue: 'Old Globe Theatre, San Diego, CA',
  status: 'open', type: 'musical', category: 'regional', market: 'regional', openingDate: '2026-09-18', tags: ['regional'], provisional: true });
const parent = { id: 'p-2024', slug: 'p-2024', category: 'broadway', market: 'broadway' };
const tour = () => ({ id: 'p-tour-2026', title: 'P', slug: 'p-tour-2026', venue: 'North American Tour', status: 'open', type: 'play',
  category: 'tour', market: 'tour', tourOf: 'p-2024', tourScheduleSlug: 'p', tourLaunchEvidence: 'NYT + Tours To You', provisional: true });

test('adds a well-formed regional entry', () => {
  const shows = [];
  assert.equal(applyAddShow(shows, { show: regional() }).ok, true);
  assert.equal(shows[0].provisional, true);
  const uk = { ...regional(), id: 'y-regional-2026', slug: 'y-regional-2026', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' };
  assert.equal(applyAddShow(shows, { show: uk }).ok, true);
});
test('refuses malformed regional entries', () => {
  assert.equal(applyAddShow([], { show: { ...regional(), market: 'broadway' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), id: 'x-2026', slug: 'x-2026' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), venue: 'Old Globe Theatre' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), tourOf: 'p-2024' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), market: 'regional' } }).ok, false);
});
test('adds a tour linked to an existing broadway parent', () => {
  const shows = [{ ...parent }];
  assert.equal(applyAddShow(shows, { show: tour() }).ok, true);
  assert.equal(shows[1].tourOf, 'p-2024');
});
test('refuses malformed tour entries', () => {
  assert.equal(applyAddShow([], { show: tour() }).ok, false); // parent missing
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), venue: 'Shubert Theatre' } }).ok, false);
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), market: 'broadway' } }).ok, false);
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), id: 'p-2026', slug: 'p-2026' } }).ok, false);
});

// ---- BRO-4931: tours of any market, and standalone tours --------------------

test('adds a tour of an Off-Broadway, regional or West End parent', () => {
  for (const category of ['off-broadway', 'regional', 'west-end', 'off-west-end']) {
    const shows = [{ ...parent, category }];
    const r = applyAddShow(shows, { show: tour() });
    assert.equal(r.ok, true, `${category}: ${r.reason}`);
    assert.equal(shows[1].tourOf, 'p-2024');
  }
});
test('refuses a tour whose tourOf is itself a tour, or does not exist', () => {
  const r = applyAddShow([{ ...parent, category: 'tour' }], { show: tour() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /is itself a tour/);
  assert.match(applyAddShow([], { show: tour() }).reason, /not found/);
});
test('adds a standalone tour with no tourOf when it carries tourScheduleSlug', () => {
  const { tourOf, ...lone } = tour();
  const shows = [];
  const r = applyAddShow(shows, { show: lone });
  assert.equal(r.ok, true, r.reason);
  assert.equal('tourOf' in shows[0], false);
  assert.equal(shows[0].tourScheduleSlug, 'p');
});
test('refuses a standalone tour with no tourScheduleSlug, and an empty tourOf', () => {
  const { tourOf, tourScheduleSlug, ...noSlug } = tour();
  const a = applyAddShow([], { show: noSlug });
  assert.equal(a.ok, false);
  assert.match(a.reason, /needs tourScheduleSlug/);
  for (const empty of [null, '']) {
    const b = applyAddShow([{ ...parent }], { show: { ...tour(), tourOf: empty } });
    assert.equal(b.ok, false, String(empty));
    assert.match(b.reason, /omit tourOf/);
  }
});
test('refuses a tour id that carries the parent market before -tour-<year>', () => {
  for (const id of ['p-off-broadway-tour-2026', 'p-regional-tour-2026', 'p-west-end-tour-2026', 'p-off-west-end-tour-2026', 'p-on-broadway-tour-2026']) {
    const r = applyAddShow([{ ...parent }], { show: { ...tour(), id, slug: id } });
    assert.equal(r.ok, false, id);
    assert.match(r.reason, /must not carry a market/);
  }
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), id: 'mexodus-tour-2026', slug: 'mexodus-tour-2026' } }).ok, true);
});
test('tourOf and tourScheduleSlug still belong only on category "tour"', () => {
  assert.equal(applyAddShow([{ ...parent }], { show: { ...base(), tourScheduleSlug: 'x' } }).ok, false);
});

// BRO-5789: write-time duplicate gate (audit-duplicate-shows found these after shipping).
const existingAmaze = { id: 'amaze-magic-off-broadway-2025', slug: 'amaze-magic-off-broadway-2025', title: 'AMAZE Magic', venue: 'New World Stages', market: 'broadway', category: 'off-broadway', status: 'open', openingDate: '2025-08-13' };
test('refuses a "presents-" prefixed copy of an existing title', () => {
  const ex = { id: 'pirates-off-west-end-2027', slug: 'pirates-off-west-end-2027', title: "Disney's Pirates of the Caribbean: The Immersive Adventure", venue: 'Secret Cinema, Greenwich Peninsula', market: 'west-end', category: 'off-west-end', status: 'open', openingDate: '2027-03-01', closingDate: '2027-09-01' };
  const row = { ...base(), id: 'presents-pirates-off-west-end-2027', slug: 'presents-pirates-off-west-end-2027', title: "Secret Cinema Presents Disney's Pirates of the Caribbean: The Immersive Adventure", venue: 'Secret Cinema, Greenwich Peninsula', market: 'west-end', category: 'off-west-end', status: 'open', openingDate: '2027-03-05', closingDate: '2027-08-01' };
  const r = applyAddShow([ex], { show: row });
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicates existing "pirates-off-west-end-2027"/);
  assert.equal(applyAddShow([{ ...ex }], { show: row, distinctFrom: ['pirates-off-west-end-2027'] }).ok, true);
  // A declared link is an explicit statement of relatedness, so it exempts the gate too.
  assert.equal(applyAddShow([{ ...ex }], { show: row, priorRunOf: 'pirates-off-west-end-2027' }).reason?.includes('duplicates existing') ?? false, false);
  assert.equal(applyAddShow([{ ...ex }], { show: row, crossLinkFrom: 'pirates-off-west-end-2027' }).reason?.includes('duplicates existing') ?? false, false);
});
test('an unrelated title is not blocked', () => {
  assert.equal(applyAddShow([{ ...existingAmaze }], { show: base() }).ok, true);
});

// BRO-6114: id market suffix must agree with category before the row is written.
import { createRequire as __cr6114 } from 'node:module';
{
  const { applyAddShow } = __cr6114(import.meta.url)('./add-show-action.js');
  const base = { title: 'Yentl', venue: 'Marylebone Theatre', openingDate: '2026-03-11', status: 'closed', market: 'west-end', type: 'play', tags: [] };
  test('BRO-6114: add-show refuses an off-west-end row whose id carries -west-end', () => {
    const r = applyAddShow([], { show: { ...base, id: 'yentl-west-end-2026', slug: 'yentl-west-end-2026', category: 'off-west-end' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /disagrees with category "off-west-end"/);
  });
  test('BRO-6114: add-show accepts the matching -off-west-end id', () => {
    const r = applyAddShow([], { show: { ...base, id: 'yentl-off-west-end-2026', slug: 'yentl-off-west-end-2026', category: 'off-west-end' } });
    assert.equal(r.ok, true, r.reason);
  });
}
// BRO-6515: a regional row carries its metro slug; anything else is refused.
test('accepts a metro-slug city and refuses a free-text one', () => {
  const shows = [];
  assert.equal(applyAddShow(shows, { show: { ...base(), city: 'manchester-uk' } }).ok, true);
  assert.equal(shows[0].city, 'manchester-uk');
  assert.equal(applyAddShow([], { show: { ...base(), city: 'Manchester, UK' } }).ok, false);
});

// BRO-6629: add-show plans never gathered their shows; execute-approved-fix.yml now
// dispatches gather-reviews for the ids gatherableAddedShowIds returns.
test('BRO-6629: gatherableAddedShowIds keeps rows past their opening date', async () => {
  const { gatherableAddedShowIds } = await import('./add-show-action.js').then(m => m.default || m);
  const rows = [
    { id: 'staff-meal-off-broadway-2024', status: 'closed', openingDate: '2024-05-08' },
    { id: 'now-running-off-broadway-2026', status: 'open', openingDate: '2026-10-01' },
    { id: 'future-off-broadway-2027', status: 'announced', openingDate: '2027-03-01' },
    { id: 'previews-off-broadway-2026', status: 'previews', openingDate: '2026-11-05' },
    { id: 'stale-previews-off-broadway-2026', status: 'previews', openingDate: '2026-10-20' },
    { id: 'open-no-date-2026', status: 'open', openingDate: null },
    { id: 'open-future-date-2026', status: 'open', openingDate: '2026-12-01' },
    null,
  ];
  assert.deepEqual(gatherableAddedShowIds(rows, '2026-10-30'), ['staff-meal-off-broadway-2024', 'now-running-off-broadway-2026', 'stale-previews-off-broadway-2026']);
  assert.deepEqual(gatherableAddedShowIds(undefined), []);
});

test('BRO-6629: execute-approved-fix wires added shows to a capped gather dispatch', async () => {
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/execute-approved-fix.yml', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../execute-approved-fix.js', import.meta.url), 'utf8');
  assert.match(js, /output\('gather_show_ids', gatherableAddedShowIds\(addedShows\)/);
  assert.match(js, /if \(result\.ok \|\| \/already exists\/\.test\(result\.reason \|\| ''\)\) addedShows\.push\(action\.show\)/);
  assert.match(wf, /rerun this workflow to gather/);
  assert.match(wf, /steps\.exec\.outputs\.gather_show_ids != ''/);
  assert.match(wf, /capped-workflow-dispatch\.js --workflow=gather-reviews\.yml/);
  assert.match(wf, /actions: write/);
});
