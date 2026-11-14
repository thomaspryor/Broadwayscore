import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runningTourCandidate, UPCOMING_DAYS } = require('../../scripts/lib/tour-discovery.js');
const { decideTourCreation, FRESH_LAUNCH_DAYS } = require('../../scripts/lib/tour-create-decision.js');
const fixtures = require('../fixtures/tour-pages/upcoming-tours.json');

// Run the real server component and its TypeScript dependencies with plain node.
const unregister = require('tsx/cjs/api').register();
const React = require('react');
// tsx uses classic JSX for the project's jsx:preserve setting. Next normally
// supplies the JSX runtime; supply React for this worker and restore it after.
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});
const { renderToStaticMarkup } = require('react-dom/server');
const TourScheduleCard = require('../../src/components/show-page/TourScheduleCard.tsx').default;
const ToursByCity = require('../../src/components/ToursByCity.tsx').default;

const NOW = new Date('2026-10-22T00:00:00Z');
const day = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
// Only render captured input. Discovery, date decisions and links use real code.
const table = stops => '<table><tr><th>Location</th><th>Venue</th><th>Dates</th></tr>'
  + stops.map(s => `<tr><td>${s.city}</td><td>${s.venue}</td><td>${day(s.start)} - ${day(s.end)}</td></tr>`).join('')
  + '</table>';

function discover(fixture, now = NOW, tracked = []) {
  return runningTourCandidate({
    slug: fixture.slug, pageTitle: fixture.show.title, scheduleUrl: fixture.source,
    html: table(fixture.stops), shows: [fixture.parent, ...fixture.predecessors, ...tracked], now,
  });
}

function create(fixture, now = NOW) {
  const found = discover(fixture, now);
  assert.ok(found.candidate, found.skip);
  return decideTourCreation({
    candidate: found.candidate, parent: fixture.parent,
    shows: [fixture.parent, ...fixture.predecessors], scheduleUrl: fixture.source,
    html: table(fixture.stops), now,
  });
}

for (const fixture of fixtures) {
  test(`${fixture.show.title}: captured schedule discovers and creates the correct tour`, () => {
    const found = discover(fixture);
    assert.ok(found.candidate, found.skip);
    assert.equal(found.candidate.segmentStart, fixture.show.openingDate);
    assert.equal(Boolean(found.candidate.upcoming), fixture.show.status === 'upcoming');
    const result = create(fixture);
    assert.equal(result.outcome, 'create', result.reason);
    assert.equal(result.built.entry.id, fixture.show.id);
    assert.equal(result.built.entry.status, fixture.show.status);
    assert.equal(result.built.entry.openingDate, fixture.show.openingDate);
    assert.equal(result.built.entry.tourOf, fixture.parent.id);
    assert.equal(result.built.entry.tourScheduleSlug, fixture.slug);
    assert.equal(result.decision.launchSource, fixture.show.status === 'upcoming'
      ? 'tourstoyou-upcoming' : 'tourstoyou-fresh');
    assert.equal(discover(fixture, NOW, [fixture.show]).candidate, undefined,
      'a tracked tour must not be created again');
  });
}

test('Tommy auto-creates on launch and through the fresh-launch window, then needs evidence', () => {
  const tommy = fixtures.find(f => f.show.id === 'the-whos-tommy-tour-2026');
  const launch = Date.parse(`${tommy.show.openingDate}T00:00:00Z`);
  for (const elapsed of [0, FRESH_LAUNCH_DAYS]) {
    const result = create(tommy, new Date(launch + elapsed * 86400000));
    assert.equal(result.outcome, 'create', result.reason);
    assert.equal(result.built.entry.status, 'open');
    assert.equal(result.built.entry.openingDate, '2026-10-06');
  }
  const stale = create(tommy, new Date(launch + (FRESH_LAUNCH_DAYS + 1) * 86400000));
  assert.equal(stale.outcome, 'suggest');
  assert.equal(stale.built.entry, undefined);
});

test('future tours outside the discovery horizon are left alone', () => {
  const blonde = fixtures.find(f => f.show.id === 'legally-blonde-tour-2027');
  const launch = Date.parse(`${blonde.show.openingDate}T00:00:00Z`);
  assert.ok(discover(blonde, new Date(launch - UPCOMING_DAYS * 86400000)).candidate);
  assert.equal(discover(blonde, new Date(launch - (UPCOMING_DAYS + 1) * 86400000)).candidate, undefined);
});

test('TourScheduleCard links existing city pages and leaves other cities as text', () => {
  const tommy = fixtures.find(f => f.show.id === 'the-whos-tommy-tour-2026');
  const props = { stops: tommy.stops, today: '2026-10-06', reviewCounts: {}, show: tommy.show };
  const linked = renderToStaticMarkup(React.createElement(TourScheduleCard, {
    ...props, cityPages: new Set(['cleveland-oh', 'denver-co']),
  }));
  assert.match(linked, /href="\/tours\/cleveland-oh">Cleveland, OH<\/a>/);
  assert.match(linked, /href="\/tours\/denver-co">Denver, CO<\/a>/);
  assert.doesNotMatch(linked, /href="\/tours\/(?:overland-park-ks|tucson-az)"/);
  assert.match(linked, />Overland Park, KS<\/span>/);
  const plain = renderToStaticMarkup(React.createElement(TourScheduleCard, props));
  assert.doesNotMatch(plain, /href="\/tours\//);
});

test('Tours by city renders links to the city pages supplied by the browse page', () => {
  const html = renderToStaticMarkup(React.createElement(ToursByCity, {
    cities: [{ slug: 'cleveland-oh', city: 'Cleveland, OH', stops: [], upcomingListed: 5, indexed: true }],
  }));
  assert.match(html, /Tours by city/);
  assert.match(html, /href="\/tours\/cleveland-oh"/);
  assert.equal(renderToStaticMarkup(React.createElement(ToursByCity, { cities: [] })), '');
});
