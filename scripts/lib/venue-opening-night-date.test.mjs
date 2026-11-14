import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseVenueOpeningNight, isVenueOpeningCandidate, prioritizeVenueOpeningChecks,
  validateWithVenueOpeningNight } = require('./venue-opening-night-date');
const { buildAuditResults } = require('./venue-date-compare');
const { classifyNamedShowRun } = require('./named-show-verdict');
const fixture = fs.readFileSync(new URL('../../tests/fixtures/ob-discovery/irish-rep-opening-night.html', import.meta.url), 'utf8');
const show = {
  id: 'the-good-thief-off-broadway-2026', title: 'The Good Thief',
  venue: 'Irish Repertory Theatre', category: 'off-broadway', status: 'previews',
  discoverySource: 'venue-page:irish-rep', openingDate: '2026-11-12',
  officialUrl: 'https://irishrep.org/',
  ticketLinks: [{ platform: 'Venue Box Office', url: 'https://irishrep.org/whats-on/the-good-thief' }],
};
const todayIso = '2026-11-10';
const fallback = async s => ({ id: s.id, result: 'no-playbill-url', mismatches: [] });

test('Irish Rep key dates identify November 17, not on-sale or patron night', () => {
  const parsed = parseVenueOpeningNight(fixture, show);
  assert.equal(parsed.openingDate, '2026-11-17');
  assert.match(parsed.evidence, /PRIVATE EVENT Tuesday, November 17/);
});

test('wrong show, soft 404, absent label and calendar-only badge supply no evidence', () => {
  for (const html of [
    fixture.replaceAll('The Good Thief', 'A Different Show'),
    '<h1>Page Not Found</h1><p>Opening Night November 17, 2026</p>',
    '<h1>The Good Thief</h1><p>November 7 to December 13, 2026</p>',
    '<h1>The Good Thief</h1><div class="tags"><span>Opening Night</span></div><p>Patron Night November 19, 2026</p>',
    '<h1>The Good Thief</h1><p>Opening Night</p><p>Public On-Sale Begins October 1, 2026</p>',
  ]) assert.equal(parseVenueOpeningNight(html, show), null);
});

test('explicit label years, inline markup and definition lists are supported', () => {
  for (const row of [
    '<p><strong>Opening Night:</strong> Tuesday, November 17, 2026 at 7pm</p>',
    '<dl><dt>Opening Night</dt><dd>PRIVATE EVENT<br>November 17, 2026</dd></dl>',
    '<table><tr><th>Opening Night</th><td>November 17, 2026</td></tr></table>',
  ]) assert.equal(parseVenueOpeningNight(`<h1>The Good Thief</h1>${row}`, show)?.openingDate, '2026-11-17');
});

test('impossible or ambiguous dates and stale production ranges are refused', () => {
  for (const html of [
    '<h1>The Good Thief</h1><p>Opening Night February 30, 2026</p>',
    '<h1>The Good Thief</h1><p>Opening Night November 17, 2026</p><p>Opening Night November 18, 2026</p>',
    fixture.replaceAll('2026', '2025'),
    '<h1>The Good Thief</h1><p>Opening Night November 17</p>',
  ]) assert.equal(parseVenueOpeningNight(html, show), null);
});

test('yearless dates use the page run across New Year', () => {
  const html = '<h1>The Good Thief</h1><p class="date-summary">December 28, 2026 to January 20, 2027</p><p>Opening Night January 3</p>';
  assert.equal(parseVenueOpeningNight(html, { ...show, openingDate: '2026-12-31' }).openingDate, '2027-01-03');
});

test('ignored page regions cannot supply another production opening', () => {
  const html = fixture.replace('</main>', '<aside><p>Opening Night November 18, 2026</p></aside><div hidden><p>Opening Night November 19, 2026</p></div></main>');
  assert.equal(parseVenueOpeningNight(html, show).openingDate, '2026-11-17');
});

test('only active venue-discovered OB shows from today through day 10 qualify', () => {
  for (const date of ['2026-11-10', '2026-11-20']) {
    assert.equal(isVenueOpeningCandidate({ ...show, openingDate: date }, todayIso), true);
  }
  for (const overrides of [
    { openingDate: '2026-11-09' }, { openingDate: '2026-11-21' },
    { openingDate: '2026-02-30' }, { openingDate: null },
    { status: 'closed' }, { status: 'cancelled' }, { status: 'postponed' },
    { category: 'broadway' }, { category: 'off-west-end' },
    { discoverySource: 'playbill' },
  ]) assert.equal(isVenueOpeningCandidate({ ...show, ...overrides }, todayIso), false);
});

test('upcoming opening checks precede the backlog, preserving rotation within groups', () => {
  const old = { ...show, id: 'old', openingDate: '2026-09-01' };
  const next = { ...show, id: 'next', openingDate: '2026-11-20' };
  const far = { ...show, id: 'far', openingDate: '2026-12-01' };
  assert.deepEqual(prioritizeVenueOpeningChecks([old, show, far, next], todayIso).map(s => s.id),
    [show.id, 'next', 'old', 'far']);
});

test('five-day disagreement becomes a persisted mismatch even without a Playbill page', async () => {
  const fetched = [];
  const row = await validateWithVenueOpeningNight(show, {
    todayIso, fetchPage: async url => { fetched.push(url); return { content: fixture }; },
    validateFallback: () => assert.fail('venue evidence must not depend on Playbill'),
  });
  assert.deepEqual(fetched, [show.ticketLinks[0].url]);
  assert.equal(row.result, 'mismatch');
  assert.equal(row.mismatches[0].deltaDays, 5);
  assert.equal(row.mismatches[0].playbill, '2026-11-17');
  assert.equal(row.mismatches[0].source, 'venue-opening-night');
  assert.equal(classifyNamedShowRun({ showFilter: show.id, results: [row], targetCount: 1 }).exitCode, 1);
  const [saved] = buildAuditResults({ freshResults: [row], previousResultsById: {},
    currentProvisionalIds: new Set([show.id]), showsById: { [show.id]: show } });
  assert.equal(saved.lastDefinitiveResult, 'mismatch');
  assert.equal(saved.venueOpeningNight.sourceUrl, show.ticketLinks[0].url);
});

test('a one-day discrepancy is enough; exact agreement retains the fallback verdict', async () => {
  for (const [openingDate, expected] of [['2026-11-16', 'mismatch'], ['2026-11-17', 'no-playbill-url']]) {
    const row = await validateWithVenueOpeningNight({ ...show, openingDate }, {
      todayIso, fetchPage: async () => ({ content: fixture }), validateFallback: fallback,
    });
    assert.equal(row.result, expected);
    assert.equal(row.venueOpeningNight.openingDate, '2026-11-17');
  }
});

test('venue agreement never suppresses a mismatch from the ordinary audit', async () => {
  const row = await validateWithVenueOpeningNight({ ...show, openingDate: '2026-11-17' }, {
    todayIso, fetchPage: async () => ({ content: fixture }),
    validateFallback: async () => ({ result: 'mismatch', mismatches: [{ field: 'venue' }] }),
  });
  assert.equal(row.result, 'mismatch');
  assert.equal(row.mismatches[0].field, 'venue');
});

test('missing show URLs resolve by venue listing link text with no slug metadata or SERP', async () => {
  const fetched = [];
  const row = await validateWithVenueOpeningNight({ ...show, ticketLinks: [] }, {
    todayIso, validateFallback: fallback,
    fetchPage: async url => {
      fetched.push(url);
      return { content: fetched.length === 1
        ? '<a href="/whats-on/unrelated-slug">The Good Thief</a><a href="https://untrusted.test/show">The Good Thief</a>'
        : fixture };
    },
  });
  assert.deepEqual(fetched, ['https://irishrep.org/', 'https://irishrep.org/whats-on/unrelated-slug']);
  assert.equal(row.result, 'mismatch');
});

test('unknown venue, fetch failures, ambiguous links and missing dates remain unverified', async () => {
  for (const [overrides, fetchPage, reason] of [
    [{ discoverySource: 'venue-page:unknown' }, () => assert.fail('unknown host'), 'unknown-venue'],
    [{}, async () => { throw new Error('unavailable'); }, 'fetch-error'],
    [{}, async () => ({ content: '<h1>The Good Thief</h1>' }), 'no-unambiguous-opening-night'],
    [{ ticketLinks: [] }, async () => ({ content: '<a href="/a">The Good Thief</a><a href="/b">The Good Thief</a>' }), 'no-unique-show-page'],
  ]) {
    const messages = [];
    const row = await validateWithVenueOpeningNight({ ...show, ...overrides }, {
      todayIso, fetchPage, validateFallback: fallback, log: m => messages.push(m),
    });
    assert.equal(row.result, 'no-playbill-url');
    assert.equal(row.venueOpeningNight.reason, reason);
    assert.ok(messages.some(m => m.startsWith('::warning::')));
  }
});

test('ineligible shows cost zero venue fetches and retain their original result', async () => {
  for (const overrides of [{ openingDate: '2026-12-01' }, { category: 'west-end' }, { status: 'closed' }]) {
    const row = await validateWithVenueOpeningNight({ ...show, ...overrides }, {
      todayIso, fetchPage: () => assert.fail('out of scope'), validateFallback: fallback,
    });
    assert.equal(row.result, 'no-playbill-url');
    assert.equal(row.venueOpeningNight, undefined);
  }
});
