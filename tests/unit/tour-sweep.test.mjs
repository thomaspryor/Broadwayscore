/**
 * tour-sweep / tour-create-decision (BRO-4931): one Tours To You page through
 * classifier -> candidate -> buildTourEntry, and the sweep fixture's integrity.
 * Synthetic shows and pages; the live check is scripts/check-tour-sweep.js.
 *
 * Run: node --test tests/unit/tour-sweep.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evaluateTourPage, compareOutcome, OUTCOME_OF_KIND } = require('../../scripts/lib/tour-sweep.js');
const { decideTourCreation, candidateRoundupUrl } = require('../../scripts/lib/tour-create-decision.js');
const { loadTourPageClasses, overrideProblems } = require('../../scripts/lib/tour-page-class.js');

const NOW = new Date('2026-10-09T12:00:00Z');
const row = (city, venue, dates) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td></tr>`;
const page = rows => `<html><head><title>X &#8211; Tours To You</title></head><body><table><tr><th>Location</th><th>Venue</th><th>Dates</th></tr>${rows.join('')}</table></body></html>`;
// A tour booked ahead: five cities from 2026-11-10.
const BOOKED = page([
  row('Boston, MA', 'Citizens Opera House', 'November 10-15, 2026'),
  row('Hartford, CT', 'The Bushnell', 'November 17-22, 2026'),
  row('Providence, RI', 'PPAC', 'November 24-29, 2026'),
  row('Albany, NY', 'Proctors', 'December 1-6, 2026'),
  row('Buffalo, NY', 'Shea\'s', 'December 8-13, 2026'),
]);
// A tour that has run for months: its first row is not a launch.
const LONG_RUNNING = page([
  row('Boston, MA', 'Citizens Opera House', 'March 3-8, 2026'),
  row('Hartford, CT', 'The Bushnell', 'March 10-15, 2026'),
  row('Providence, RI', 'PPAC', 'May 5-10, 2026'),
  row('Albany, NY', 'Proctors', 'September 22-27, 2026'),
  row('Buffalo, NY', 'Shea\'s', 'October 6-11, 2026'),
  row('Erie, PA', 'Warner', 'October 13-18, 2026'),
]);
const THREE = page([row('Boston, MA', 'A', 'November 10-15, 2026'), row('Hartford, CT', 'B', 'November 17-22, 2026'), row('Albany, NY', 'C', 'November 24-29, 2026')]);

const SHOWS = [
  { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway', status: 'closed', openingDate: '2026-03-10', type: 'musical', images: { hero: null, thumbnail: null, poster: null } },
];
const OVERRIDE = (title, type = 'musical') => ({ class: 'production', title, type, reason: 'owner', issue: 'BRO-4931', reviewedAt: '2026-10-09' });
const ev = args => evaluateTourPage({ slug: 'some-show', pageTitle: 'Some Show', html: BOOKED, shows: SHOWS, now: NOW, ...args });

test('a standalone production booked ahead is created with no tourOf, its page as the anchor, and the type from Wikipedia', async () => {
  const r = await ev({ fetchWiki: async () => '{{Infobox musical\n| name = Some Show\n}}' });
  assert.equal(r.outcome, 'create');
  assert.equal(r.entry.id, 'some-show-tour-2026');
  assert.equal('tourOf' in r.entry, false, 'omitted, never null');
  assert.deepEqual([r.entry.type, r.entry.status, r.entry.openingDate, r.entry.tourScheduleSlug], ['musical', 'upcoming', '2026-11-10', 'some-show']);
  assert.equal(r.entry.discoverySource, 'tour-schedule:tourstoyou');
});

test('a page nothing can classify is never created: needs-classification, not a guess', async () => {
  assert.equal((await ev({ fetchWiki: async () => '' })).outcome, 'needs-classification');
  assert.equal((await ev({})).outcome, 'needs-classification', 'no Wikipedia text at all');
  assert.equal((await ev({ fetchWiki: async () => '{{Infobox book\n| name = Some Show\n}}' })).outcome, 'needs-classification');
});

test('a concert, circus or dance infobox turns a candidate into a skipped event at the create step', async () => {
  const r = await ev({ fetchWiki: async () => '{{Infobox concert tour\n| name = Some Show\n}}' });
  assert.equal(r.outcome, 'skip-event');
});

test('the owner-approved override creates a standalone tour with its own title and type, no Wikipedia needed', async () => {
  const r = await ev({ slug: 'the-cat-in-the-hat', pageTitle: 'Dr. Seuss&#8217; The Cat in the Hat', overrides: { 'the-cat-in-the-hat': OVERRIDE("Dr. Seuss' The Cat in the Hat") }, fetchWiki: async () => '' });
  assert.equal(r.outcome, 'create');
  assert.equal(r.entry.id, 'dr-seuss-the-cat-in-the-hat-tour-2026');
  assert.equal(r.entry.title, "Dr. Seuss' The Cat in the Hat");
});

test('evidence rules are unchanged for a standalone tour: too few stops, a long-running tour with no confirmed launch, a copied table', async () => {
  const few = await ev({ html: THREE, overrides: { 'some-show': OVERRIDE('Some Show', 'play') } });
  assert.equal(few.outcome, 'skip-too-few-stops');
  assert.match(few.reason, /only 3 engagements/);
  // Running since March with Wikipedia silent: the first row is no launch, so the owner is asked.
  const longRunning = await ev({ html: LONG_RUNNING, overrides: { 'some-show': OVERRIDE('Some Show') } });
  assert.equal(longRunning.outcome, 'suggest');
  assert.match(longRunning.reason, /no launch date confirmed/);
  // Another tour's table on this page.
  const copy = await ev({ overrides: { 'some-show': OVERRIDE('Some Show') }, tourSchedules: { 'other-tour-2026': { stops: [
    { city: 'Boston, MA', venue: 'Citizens Opera House', start: '2026-11-10' },
    { city: 'Hartford, CT', venue: 'The Bushnell', start: '2026-11-17' },
    { city: 'Providence, RI', venue: 'PPAC', start: '2026-11-24' },
  ] } } });
  assert.equal(copy.outcome, 'skip-duplicate-schedule');
});

test('a tour of an Off-Broadway production is created with that parent, and its id carries no market', async () => {
  const r = await evaluateTourPage({ slug: 'mexodus', pageTitle: 'Mexodus', html: BOOKED, shows: SHOWS, now: NOW, fetchWiki: async () => '' });
  assert.equal(r.outcome, 'create');
  assert.deepEqual([r.entry.id, r.entry.tourOf], ['mexodus-tour-2026', 'mexodus-off-broadway-2026']);
  assert.equal(r.candidate.broadwayShowId, undefined);
});

test('pages that are not productions are told apart before any schedule is read', async () => {
  const tour = { id: 'hamilton-tour-2024', title: 'Hamilton', category: 'tour', tourOf: 'hamilton-2015', tourScheduleSlug: 'hamilton' };
  const shows = [...SHOWS, tour];
  const cases = [['dear-evan-hansen-tester', 'skip-template'], ['hamilton-angelica', 'skip-company'], ['cirque-holiday', 'skip-event'], ['nothing-here', 'skip-nothing-running']];
  for (const [slug, outcome] of cases) {
    const r = await evaluateTourPage({ slug, pageTitle: null, html: slug === 'nothing-here' ? '<p>no table</p>' : BOOKED, shows, now: NOW });
    assert.equal(r.outcome, outcome, slug);
  }
  assert.deepEqual(Object.values(OUTCOME_OF_KIND).sort(), ['skip-aggregator', 'skip-company', 'skip-event', 'skip-no-parent', 'skip-nothing-running', 'skip-template', 'skip-too-few-stops', 'skip-tracked']);
});

test('the BWW roundup backing a standalone tour is carried from the ledger row that names it', () => {
  const c = { key: 'page:some-show', source: 'tourstoyou', title: 'Some Show', tourScheduleSlug: 'some-show', url: 'https://tourstoyou.org/shows/some-show/' };
  const roundup = { key: 'roundup:review-roundup-some-show-launches-national-tour-20261115', source: 'bww-roundup', title: 'Some Show', roundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-SOME-SHOW-Launches-National-Tour-20261115' };
  assert.equal(candidateRoundupUrl(c, [roundup]), roundup.roundupUrl);
  assert.equal(candidateRoundupUrl(c, []), null);
  assert.equal(candidateRoundupUrl({ ...c, roundupUrl: 'https://own' }, [roundup]), 'https://own', 'its own roundup wins');
  // A roundup-sourced candidate's evidence is its own url.
  assert.equal(candidateRoundupUrl({ source: 'bww-roundup', url: 'https://x' }, []), 'https://x');
});

test('a BWW roundup dated after the first stop confirms a standalone tour\'s launch when Wikipedia is silent (BRO-4563)', () => {
  // Running since September 1 (38 days ago): too old for a fresh launch, so only the roundup can confirm it.
  const sinceSeptember = page([
    row('Boston, MA', 'Citizens Opera House', 'September 1-6, 2026'),
    row('Hartford, CT', 'The Bushnell', 'September 8-13, 2026'),
    row('Providence, RI', 'PPAC', 'September 15-20, 2026'),
    row('Albany, NY', 'Proctors', 'September 22-27, 2026'),
    row('Buffalo, NY', 'Shea\'s', 'October 6-11, 2026'),
  ]);
  const candidate = { key: 'page:some-show', source: 'tourstoyou', title: 'Some Show', type: 'musical', pageClass: 'production', tourScheduleSlug: 'some-show', segmentStart: '2026-09-01', url: 'https://tourstoyou.org/shows/some-show/' };
  const without = decideTourCreation({ candidate, parent: null, shows: SHOWS, scheduleUrl: candidate.url, html: sinceSeptember, roundupUrl: null, now: NOW });
  assert.equal(without.outcome, 'suggest');
  const url = 'https://www.broadwayworld.com/article/Review-Roundup-SOME-SHOW-Launches-National-Tour-20260910';
  const withRoundup = decideTourCreation({ candidate, parent: null, shows: SHOWS, scheduleUrl: candidate.url, html: sinceSeptember, roundupUrl: url, now: NOW });
  assert.equal(withRoundup.outcome, 'create');
  assert.equal(withRoundup.built.entry.discoverySource, 'aggregator-roundup:bww-tour-roundup');
  assert.equal(withRoundup.built.entry.openingDate, '2026-09-01');
});

test('compareOutcome: class mismatches fail; a date-dependent difference warns; id and parent are checked for a create', () => {
  const create = { outcome: 'create', entry: { id: 'a-tour-2026', tourOf: 'a-regional-2025' } };
  assert.equal(compareOutcome({ expect: 'create', id: 'a-tour-2026', parent: 'a-regional-2025' }, create).status, 'ok');
  assert.equal(compareOutcome({ expect: ['create', 'skip-tracked'], id: 'a-tour-2026' }, { outcome: 'skip-tracked' }).status, 'ok');
  assert.match(compareOutcome({ expect: 'create', id: 'b-tour-2026' }, create).why, /id a-tour-2026, expected b-tour-2026/);
  assert.match(compareOutcome({ expect: 'create', parent: null }, create).why, /parent a-regional-2025, expected none/);
  assert.equal(compareOutcome({ expect: 'skip-event' }, { outcome: 'create' }).status, 'fail');
  // The page was running on the fixture date and has since ended: time passing, not a regression.
  assert.equal(compareOutcome({ expect: 'create' }, { outcome: 'skip-nothing-running' }, { outcome: 'create' }).status, 'warn');
  // A class that never depends on the date is a failure even if the fixture date agreed.
  assert.equal(compareOutcome({ expect: 'skip-event' }, { outcome: 'create' }, { outcome: 'skip-event' }).status, 'fail');
  assert.equal(compareOutcome({ expect: 'suggest' }, { outcome: 'skip-template' }, { outcome: 'suggest' }).status, 'fail');
});

test('the committed sweep fixture is well formed and its overrides are valid', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tour-pages');
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'sweep-2026-10-09.json'), 'utf8'));
  const valid = new Set(['create', 'suggest', 'needs-classification', 'skip-tracked', ...Object.values(OUTCOME_OF_KIND)]);
  assert.match(fixture.asOf, /^\d{4}-\d{2}-\d{2}$/);
  const slugs = Object.keys(fixture.pages);
  assert.equal(slugs.length, 80);
  for (const slug of slugs) {
    const p = fixture.pages[slug];
    for (const e of [].concat(p.expect)) assert.ok(valid.has(e), `${slug}: ${e}`);
    if (p.saved) assert.ok(fs.existsSync(path.join(dir, 'pages', `${slug}.html`)), `${slug}: saved page missing`);
    if ([].concat(p.expect).includes('create')) assert.ok(p.id && p.parent !== undefined, `${slug}: a create names its id and parent`);
  }
  // The owner's answers (BRO-4931), as outcomes.
  const want = (cls, list) => list.forEach(s => assert.ok([].concat(fixture.pages[s].expect).includes(cls), `${s} should be ${cls}`));
  want('skip-event', ['riverdance', 'stomp', 'the-hip-hop-nutcracker', 'mannheim-steamroller-christmas', 'the-simon-and-garfunkel-story', 'a-charlie-brown-christmas', 'cirque-dreams-holidaze']);
  want('create', ['the-cat-in-the-hat', 'hallmarkish', 'dolly-partons-smoky-mountain-christmas-carol', 'heathers-the-musical']);
  want('skip-too-few-stops', ['potted-potter']);
  want('skip-aggregator', ['holiday-shows', 'miscellaneous-shows']);
  assert.deepEqual(overrideProblems(loadTourPageClasses()), []);
});
