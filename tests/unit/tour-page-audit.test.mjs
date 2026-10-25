/**
 * Tour page audit (BRO-4723): the checks behind scripts/audit-tour-pages.js,
 * and the schedule-parser fixes it found. Calls the real exported functions
 * (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../scripts/lib/tour-page-audit.js');
const { parseDateRange, parseTourSchedule, fixYearTypos, singleCompanyPath } = require('../../scripts/lib/tour-schedule.js');
const { tourStops } = require('../../scripts/fetch-tour-schedules.js');

const iso = d => d.toISOString().slice(0, 10);
const row = (city, venue, dates) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td></tr>`;
const codes = fs => fs.map(f => f.code);

// ---- parser fixes -----------------------------------------------------------

test('parseDateRange strips footnote marks and fixes a year that wraps backwards', () => {
  const plus = parseDateRange('May 9-28, 2023 +');
  assert.equal(iso(plus.start), '2023-05-09');
  assert.equal(iso(plus.end), '2023-05-28');
  const wrap = parseDateRange('November 17, 2022–January 14, 2022');
  assert.equal(iso(wrap.end), '2023-01-14', "Lion King's source typo: the end year is the next one");
});

test('parseTourSchedule drops footnote marks from city names', () => {
  const rows = parseTourSchedule(`<table>${row('Charlotte, NC +', 'Belk Theater', 'March 1-6, 2026')}</table>`);
  assert.equal(rows[0].city, 'Charlotte, NC');
});

test('fixYearTypos moves a row the table order proves is a year off', () => {
  const r = (s, e) => ({ city: 'X', start: new Date(`${s}T00:00:00Z`), end: new Date(`${e}T00:00:00Z`) });
  const rows = [r('2025-02-11', '2025-02-16'), r('2024-02-18', '2024-02-19'), r('2025-02-21', '2025-02-23')];
  const out = fixYearTypos(rows);
  assert.equal(iso(out[1].start), '2025-02-18');
  const normal = [r('2025-02-11', '2025-02-16'), r('2025-02-18', '2025-02-19')];
  assert.deepEqual(fixYearTypos(normal).map(x => iso(x.start)), ['2025-02-11', '2025-02-18']);
});

test('singleCompanyPath keeps one physically possible path and drops overlaps', () => {
  const r = (city, s, e) => ({ city, start: new Date(`${s}T00:00:00Z`), end: new Date(`${e}T00:00:00Z`) });
  const rows = [
    r('Buffalo, NY', '2026-07-01', '2026-07-12'),
    r('Washington, DC', '2026-07-28', '2026-08-16'),
    r('Chicago, IL', '2026-08-04', '2026-08-16'),
    r('Denver, CO', '2026-08-19', '2026-08-30'),
  ];
  const { kept, dropped } = singleCompanyPath(rows);
  assert.deepEqual(kept.map(x => x.city), ['Buffalo, NY', 'Washington, DC', 'Denver, CO']);
  assert.deepEqual(dropped.map(x => x.city), ['Chicago, IL']);
  // A normal schedule comes out unchanged.
  assert.equal(singleCompanyPath([rows[0], rows[1], rows[3]]).dropped.length, 0);
});

test('tourStops: two companies in one table no longer merge into overlapping stops', () => {
  const html = `<table>${[
    row('Fayetteville, AR', 'Walton Arts Center', 'August 16-25, 2024'),
    row('Los Angeles, CA', 'Pantages Theatre', 'September 4–October 13, 2024'),
    row('Tulsa, OK', 'Tulsa PAC', 'August 28–September 8, 2024'),
    row('Wichita, KS', 'Century II', 'September 11-22, 2024'),
  ].join('')}</table>`;
  const got = tourStops({ id: 'x-tour-2024', openingDate: '2024-08-16' }, html, new Date('2024-09-15T00:00:00Z'));
  assert.deepEqual(got.map(s => s.city), ['Fayetteville, AR', 'Tulsa, OK', 'Wichita, KS']);
});

test('tourStops: an open tour whose leg ended carries on into the next leg', () => {
  const html = `<table>${[
    row('Elmira, NY', 'Clemens Center', 'November 19-20, 2025'),
    row('Binghamton, NY', 'Forum Theatre', 'November 22-23, 2025'),
    row('Victoria, BC', 'Royal Theatre', 'December 10-12, 2025'),
    row('Modesto, CA', 'Gallo Center', 'September 26-27, 2026'),
    row('Houston, TX', 'Hobby Center', 'September 30–October 11, 2026'),
  ].join('')}</table>`;
  const open = tourStops({ id: 'x-tour-2025', openingDate: '2025-11-19' }, html, new Date('2026-10-05T00:00:00Z'));
  assert.equal(open[open.length - 1].city, 'Houston, TX');
  const midLeg = tourStops({ id: 'x-tour-2025', openingDate: '2025-11-19' }, html, new Date('2025-11-21T00:00:00Z'));
  assert.equal(midLeg[midLeg.length - 1].city, 'Victoria, BC', 'a leg still running keeps its own segment');
  const closed = tourStops({ id: 'x-tour-2025', openingDate: '2025-11-19', closingDate: '2025-12-12' }, html, new Date('2026-10-05T00:00:00Z'));
  assert.ok(!(closed || []).some(s => s.city === 'Modesto, CA'), 'a tour with a closing date never takes the next leg');
  const farHtml = html.replace('September 26-27, 2026', 'March 26-27, 2027').replace('September 30–October 11, 2026', 'March 30–April 11, 2027');
  const far = tourStops({ id: 'x-tour-2025', openingDate: '2025-11-19' }, farHtml, new Date('2026-10-05T00:00:00Z'));
  assert.ok(!(far || []).some(s => s.city === 'Modesto, CA'), 'a layoff over a year is a new company, not the next leg');
});

// ---- data checks ------------------------------------------------------------

const parent = { id: 'x-2020', title: 'X', category: 'broadway' };
const base = { id: 'x-tour-2025', title: 'X', category: 'tour', status: 'open', tourOf: 'x-2020', openingDate: '2025-09-01', synopsis: 'A'.repeat(60), images: { poster: '/images/shows/x-tour-2025/poster.webp' } };
const stop = (city, start, end) => ({ city, venue: 'Hall', start, end });

test('checkTourData passes a clean tour', () => {
  const schedule = { source: 'https://tourstoyou.org/shows/x/', stops: [stop('Boston, MA', '2026-10-01', '2026-10-12'), stop('Hartford, CT', '2026-10-14', '2026-10-19')] };
  assert.deepEqual(A.checkTourData({ show: base, parent, schedule, today: '2026-10-05' }).filter(f => f.severity === 'error'), []);
});

test('checkTourData flags wrong parents, foreign art, overlaps and stops past closing', () => {
  const schedule = { source: 'https://tourstoyou.org/shows/x/', stops: [stop('Boston, MA', '2026-10-01', '2026-10-12'), stop('Chicago, IL', '2026-10-10', '2026-10-20'), stop('Denver, CO', '2026-12-01', '2026-12-05')] };
  const show = { ...base, closingDate: '2026-11-01', images: { poster: '/images/shows/y-2019/poster.webp' } };
  const got = codes(A.checkTourData({ show, parent: { ...parent, title: 'Y' }, schedule, today: '2026-10-05' }));
  for (const c of ['tourof-title-mismatch', 'art-from-other-production', 'stops-overlap', 'stops-after-closing']) assert.ok(got.includes(c), c);
});

test('checkTourData: tickets on a closed tour, and a missing schedule on a listed tour', () => {
  const schedule = { stops: [stop('Boston, MA', '2026-01-01', '2026-01-12')] };
  const tickets = [{ city: 'Boston, MA', start: '2026-01-01', url: 'https://www.todaytix.com/x', onSale: true }];
  assert.ok(codes(A.checkTourData({ show: { ...base, status: 'closed' }, parent, schedule, tickets, today: '2026-10-05' })).includes('ticket-on-closed-tour'));
  const missing = A.checkTourData({ show: base, parent, schedule: undefined, today: '2026-10-05', listed: true });
  assert.equal(missing.find(f => f.code === 'schedule-missing').severity, 'error');
  const ended = A.checkTourData({ show: base, parent, schedule, today: '2026-10-05' });
  assert.ok(codes(ended).includes('schedule-ended'));
});

// ---- page parsing -----------------------------------------------------------

test('unwrapTicketUrl reads the TodayTix URL out of an affiliate link', () => {
  const inner = 'https://www.todaytix.com/los-angeles/shows/123';
  assert.equal(A.unwrapTicketUrl(`https://todaytix.pxf.io/c/1/2/3?u=${encodeURIComponent(inner)}`), inner);
  assert.equal(A.unwrapTicketUrl(inner), inner);
});

test('parseShowPage reads schedule rows, city links and the Now in line', () => {
  const html = `<html><head><title>t</title><meta name="robots" content="index, follow"></head><body>
    <div data-testid="show-meta-line"><p>Now in Boston, MA · Opera House · 2h 30m</p></div>
    <section id="tour-schedule"><ul>
      <li class="flex"><span>Oct 1–12</span><span class="flex-1 min-w-0"><a href="/tours/boston-ma">Boston, MA</a><span>Opera House</span></span><span>Now playing</span></li>
      <li class="flex"><span>Oct 14–19</span><span class="flex-1 min-w-0"><span>Hartford, CT</span><span>The Bushnell</span></span></li>
    </ul></section></body></html>`;
  const p = A.parseShowPage(html);
  assert.deepEqual(p.now, { city: 'Boston, MA', venue: 'Opera House' });
  assert.equal(p.scheduleShown[0].cityHref, '/tours/boston-ma');
  assert.equal(p.scheduleShown[1].cityHref, null);
  assert.equal(p.scheduleShown[1].venue, 'The Bushnell');
});

// ---- JSON-LD ----------------------------------------------------------------

test('validateEvent accepts a complete Event and rejects a broken one', () => {
  const good = {
    '@type': 'TheaterEvent', name: 'X', startDate: '2026-10-01', endDate: '2026-10-12',
    eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: 'Opera House', address: { '@type': 'PostalAddress', addressLocality: 'Boston', addressRegion: 'MA', addressCountry: 'US' } },
    image: 'https://broadwayscorecard.com/x.png',
  };
  assert.deepEqual(A.validateEvent(good, 'w').filter(f => f.severity === 'error'), []);
  const bad = { ...good, startDate: 'Oct 1', endDate: '2025-01-01', location: undefined, eventStatus: 'Scheduled' };
  assert.ok(A.validateEvent(bad, 'w').filter(f => f.severity === 'error').length >= 3);
  // schema.org allows @type as an array.
  assert.deepEqual(A.validateEvent({ ...good, '@type': ['Event', 'TheaterEvent'] }, 'w').filter(f => f.severity === 'error'), []);
});

test('eventsIn finds events in @graph, ItemList and array @type, never in other nodes', () => {
  const ev = n => ({ '@type': 'TheaterEvent', name: n });
  const blocks = [
    { value: { '@context': 'https://schema.org', '@graph': [ev('a'), { '@type': 'WebPage' }] } },
    { value: { '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: ev('b') }, ev('c')] } },
    { value: [{ '@type': ['Event', 'TheaterEvent'], name: 'd' }, { '@type': 'Organization' }] },
    { error: 'bad json' },
  ];
  assert.deepEqual(A.eventsIn(blocks).map(e => e.name), ['a', 'b', 'c', 'd']);
});

test('eventsIn reaches events nested deeper than one level, without double counting', () => {
  const ev = n => ({ '@type': 'TheaterEvent', name: n });
  const blocks = [
    { value: { '@graph': [{ '@type': 'WebPage', '@graph': [ev('deep')] }] } },
    { value: [[ev('arr')]] },
    { value: [{ '@graph': [ev('once')] }] },
  ];
  assert.deepEqual(A.eventsIn(blocks).map(e => e.name), ['deep', 'arr', 'once']);
});

// ---- alert routing ----------------------------------------------------------

test('runAlerts files one card per error code and closes codes that cleared', async () => {
  const filed = [];
  const resolved = [];
  const router = {
    loadLedger: () => ({ conditions: { 'tour-page-audit:old-code': { status: 'open' }, 'tour-page-audit:page-status': { status: 'open' }, 'other:x': { status: 'open' } } }),
    resolveCondition: key => resolved.push(key),
    routeAlert: async opts => { filed.push(opts); return { action: 'auto', linearIdentifier: 'BRO-1', dispatchOk: true }; },
  };
  const findings = [
    { severity: 'error', code: 'page-status', where: '/show/a', message: 'HTTP 500' },
    { severity: 'error', code: 'page-status', where: '/show/b', message: 'HTTP 500' },
    { severity: 'warn', code: 'runtime-missing', where: '/show/a', message: 'x' },
  ];
  const { alerts, alertDispatchFailed } = await A.runAlerts({ findings, router, log: () => {} });
  assert.deepEqual(filed.map(f => f.conditionKey), ['tour-page-audit:page-status']);
  assert.match(filed[0].description, /\/show\/b: HTTP 500/);
  assert.deepEqual(resolved, ['tour-page-audit:old-code'], "only this audit's cleared codes close");
  assert.equal(alertDispatchFailed, false);
  assert.equal(alerts[0].linearIdentifier, 'BRO-1');
});

test('runAlerts waits for a second run before filing a new code, unless its card is open', async () => {
  const filed = [];
  const router = {
    loadLedger: () => ({ conditions: { 'tour-page-audit:known': { status: 'open' } } }),
    resolveCondition: () => {},
    routeAlert: async opts => { filed.push(opts.conditionKey); return { action: 'auto', linearIdentifier: 'BRO-2', dispatchOk: true }; },
  };
  const findings = ['fresh', 'repeat', 'known'].map(code => ({ severity: 'error', code, where: 'w', message: 'm' }));
  const out = await A.runAlerts({ findings, router, previousCodes: new Set(['repeat']), log: () => {} });
  assert.deepEqual(filed.sort(), ['tour-page-audit:known', 'tour-page-audit:repeat']);
  assert.deepEqual(out.pending, ['fresh']);
  assert.deepEqual(out.codes, ['fresh', 'known', 'repeat']);
  assert.equal(out.alertDispatchFailed, false);
});

test('runAlerts reports a card that was not filed as a failure', async () => {
  const router = { loadLedger: () => ({ conditions: {} }), resolveCondition: () => {}, routeAlert: async () => ({ action: 'auto', dispatchOk: true }) };
  const out = await A.runAlerts({ findings: [{ severity: 'error', code: 'x', where: 'w', message: 'm' }], router, log: () => {} });
  assert.equal(out.alertDispatchFailed, true);
});

// ---- BRO-4931: tours of any market, and standalone tours --------------------

const okSchedule = { source: 'https://tourstoyou.org/shows/x/', stops: [stop('Boston, MA', '2026-10-01', '2026-10-12'), stop('Hartford, CT', '2026-10-14', '2026-10-19')] };
const errorsOf = fs => fs.filter(f => f.severity === 'error').map(f => f.code);
const warnsOf = fs => fs.filter(f => f.severity === 'warn').map(f => f.code);

test('checkTourData: a tour of an Off-Broadway, regional or West End parent passes, and tourof-not-broadway is gone', () => {
  for (const category of ['off-broadway', 'regional', 'west-end', 'off-west-end']) {
    const p = { ...parent, category };
    const got = A.checkTourData({ show: base, parent: p, schedule: okSchedule, today: '2026-10-05', shows: [p, base] });
    assert.deepEqual(errorsOf(got), [], category);
    assert.ok(!codes(got).includes('tourof-not-broadway'), category);
  }
});

test('checkTourData: tourof-is-tour when the parent is itself a tour', () => {
  const got = A.checkTourData({ show: base, parent: { ...parent, category: 'tour' }, schedule: okSchedule, today: '2026-10-05' });
  assert.ok(errorsOf(got).includes('tourof-is-tour'));
});

test('checkTourData: tourof-missing is only a warning, and only when a same-title production exists', () => {
  const { tourOf, ...lone } = base;
  const standalone = A.checkTourData({ show: lone, parent: undefined, schedule: okSchedule, today: '2026-10-05', shows: [lone] });
  assert.deepEqual(errorsOf(standalone), []);
  assert.ok(!codes(standalone).includes('tourof-missing'), 'a genuinely standalone tour is clean');
  const withTwin = A.checkTourData({ show: lone, parent: undefined, schedule: okSchedule, today: '2026-10-05', shows: [lone, parent] });
  assert.deepEqual(errorsOf(withTwin), []);
  assert.ok(warnsOf(withTwin).includes('tourof-missing'));
  // No shows passed (legacy caller): nothing to compare, so no warning.
  assert.ok(!codes(A.checkTourData({ show: lone, parent: undefined, schedule: okSchedule, today: '2026-10-05' })).includes('tourof-missing'));
});

test('checkTourData: art may come from the parent category or Broadway twin, not another market', () => {
  const offB = { ...parent, id: 'x-off-broadway-2020', category: 'off-broadway' };
  const bway = { id: 'x-2027', title: 'X', category: 'broadway' };
  const wEnd = { id: 'x-west-end-2019', title: 'X', category: 'west-end' };
  const show = art => ({ ...base, tourOf: offB.id, images: { poster: `/images/shows/${art}/poster.webp` } });
  const run = art => A.checkTourData({ show: show(art), parent: offB, schedule: okSchedule, today: '2026-10-05', shows: [offB, bway, wEnd] });
  for (const ok of ['x-tour-2025', offB.id, bway.id]) assert.ok(!codes(run(ok)).includes('art-from-other-production'), ok);
  assert.ok(codes(run(wEnd.id)).includes('art-from-other-production'));
  assert.ok(codes(run('y-2019')).includes('art-from-other-production'));
  // Without `shows` the parent's own art is still allowed.
  const bare = A.checkTourData({ show: show(offB.id), parent: offB, schedule: okSchedule, today: '2026-10-05' });
  assert.ok(!codes(bare).includes('art-from-other-production'));
});

test('parseShowPage reads the market label of the parent link; checkShowPage wants the label and href of the parent category', () => {
  const html = (label, href) => `<html><head><title>t</title></head><body><a href="${href}">See the ${label} production →</a></body></html>`;
  const p = A.parseShowPage(html('Off-Broadway', '/show/x-off-broadway-2020'));
  assert.equal(p.parentLinkLabel, 'Off-Broadway');
  assert.equal(p.broadwayLink, '/show/x-off-broadway-2020');
  assert.equal(A.parseShowPage('<html><body><a href="/z">Elsewhere</a></body></html>').parentLinkLabel, null);

  const offB = { ...parent, id: 'x-off-broadway-2020', slug: 'x-off-broadway-2020', category: 'off-broadway' };
  const check = (label, href, par = offB) => A.checkShowPage({
    url: 'https://broadwayscorecard.com/show/x-tour-2025', page: A.parseShowPage(html(label, href)), show: { ...base, tourOf: par.id }, parent: par,
    schedule: okSchedule, tickets: [], todays: ['2026-10-05'], listed: true, inSitemap: true, cityPages: null,
  });
  const linkCodes = fs => codes(fs).filter(c => /link/.test(c));
  assert.deepEqual(linkCodes(check('Off-Broadway', '/show/x-off-broadway-2020')), []);
  assert.deepEqual(linkCodes(check('regional', '/show/x-regional-2020', { ...offB, id: 'x-regional-2020', slug: 'x-regional-2020', category: 'regional' })), []);
  assert.ok(linkCodes(check('Off-Broadway', '/show/other')).includes('broadway-link-wrong'));
  assert.ok(linkCodes(check('Broadway', '/show/x-off-broadway-2020')).includes('parent-link-label-wrong'), 'an Off-Broadway parent is not called Broadway');
  // The label is the copy contract (src/lib/tour-display.ts): a capitalised
  // "Regional" mid-sentence is the wording the page used to ship.
  const reg = { ...offB, id: 'x-regional-2020', slug: 'x-regional-2020', category: 'regional' };
  assert.ok(linkCodes(check('Regional', '/show/x-regional-2020', reg)).includes('parent-link-label-wrong'), 'regional reads lower-case');
  assert.deepEqual(linkCodes(check('West End', '/show/x-west-end', { ...offB, id: 'x-west-end', slug: 'x-west-end', category: 'west-end' })), []);
});
