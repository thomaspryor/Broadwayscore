// S4-T5 (2026 data audit, BRO-4204): Theatremonkey's index lists titles
// only, so every candidate was skipped for lack of a venue (card #1060) and
// the source contributed 0 for 23 consecutive CI runs. The venue now comes
// from each show page — bounded, cached, prioritised. These tests drive the
// REAL decision functions in scripts/lib/theatremonkey-venue.js (§15) with
// synthetic markup shaped like the live pages (verified 2026-09-28).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const {
  TM_SHOW_URL_PREFIX,
  DEFAULT_VENUE_PAGE_BUDGET,
  CACHE_TTL_MS,
  titleKey,
  parseTheatremonkeyIndex,
  extractTheatremonkeyVenue,
  extractTheatremonkeyDates,
  parseBritishDate,
  parseVenuePageBudget,
  loadVenueCache,
  saveVenueCache,
  cacheEntryUsable,
  planVenueFetches,
  recordVenueResult,
} = require('../../scripts/lib/theatremonkey-venue.js');

const INDEX_HTML = `<!doctype html><html><body>
<a href="https://www.theatremonkey.com/shows/">All shows</a>
<a href="https://www.theatremonkey.com/show/amadeus/">Amadeus</a>
<a href="https://www.theatremonkey.com/show/amadeus/">Read more...</a>
<a href="https://www.theatremonkey.com/show/hercules/">Disney&#8217;s  Hercules</a>
<a href="/show/a-month-in-the-country/">A Month in the Country</a>
<a href="https://www.theatremonkey.com/show/amadeus/">Show Details</a>
<a href="https://www.theatremonkey.com/show/beetlejuice/?utm=x">Beetlejuice</a>
<a href="https://www.theatremonkey.com/venue/noel-coward-theatre/">Noel Coward Theatre</a>
</body></html>`;

const SHOW_HTML = `<!doctype html><html><head><title>Amadeus &#8211; Theatremonkey</title></head><body>
<h1>Amadeus</h1>
<p class="wp-block-paragraph">Showing from Wed, 20th May 2026 to Sat, 17th April 2027. Press Night: 28th May 2026.</p>
<div style="text-align:center;"><button class="btn"><a href="https://www.theatremonkey.com/venue/noel-coward-theatre/">Find out where to sit and where to avoid in Noel Coward Theatre <i class="fa-solid"></i></a></button></div>
<div class="accordion-item"><h2 class="accordion-header"><button>About Noel Coward Theatre</button></h2>
<div class="accordion-body">
    Venue: Noel Coward Theatre<br/>Address: 85-88 St Martin&#8217;s Lane, Covent Garden, WC2N 4AP<br/>Box Office: <a href="tel:+443444825151">0344 482 5151</a>
</div></div>
</body></html>`;

test('parseTheatremonkeyIndex: one entry per /show/ slug, in page order, link noise dropped, Disney prefix stripped', () => {
  const entries = parseTheatremonkeyIndex(INDEX_HTML);
  assert.deepEqual(entries, [
    { title: 'Amadeus', slug: 'amadeus', url: `${TM_SHOW_URL_PREFIX}amadeus/` },
    { title: 'Hercules', slug: 'hercules', url: `${TM_SHOW_URL_PREFIX}hercules/` },
    { title: 'A Month in the Country', slug: 'a-month-in-the-country', url: `${TM_SHOW_URL_PREFIX}a-month-in-the-country/` },
    { title: 'Beetlejuice', slug: 'beetlejuice', url: `${TM_SHOW_URL_PREFIX}beetlejuice/` },
  ]);
  assert.deepEqual(parseTheatremonkeyIndex(''), []);
  assert.deepEqual(parseTheatremonkeyIndex('<html><body><p>no links</p></body></html>'), []);
});

test('extractTheatremonkeyVenue: "Venue: <name><br/>" accordion line wins, entities decoded', () => {
  assert.equal(extractTheatremonkeyVenue(SHOW_HTML), 'Noel Coward Theatre');
  const curly = SHOW_HTML.replace(/Noel Coward Theatre/g, 'Sondheim Theatre &#8211; Shaftesbury Avenue');
  assert.equal(extractTheatremonkeyVenue(curly), 'Sondheim Theatre – Shaftesbury Avenue');
});

test('extractTheatremonkeyVenue: falls back to the "where to avoid in <venue>" button text', () => {
  const buttonOnly = SHOW_HTML.replace(/Venue: Noel Coward Theatre<br\/>/, '');
  assert.equal(extractTheatremonkeyVenue(buttonOnly), 'Noel Coward Theatre');
});

test('extractTheatremonkeyVenue: never reads the venue out of the /venue/ URL (CLAUDE.md §3)', () => {
  const hrefOnly = `<html><body><h1>Amadeus</h1>
<a href="https://www.theatremonkey.com/venue/noel-coward-theatre/">Seating plan</a>
<div class="accordion-body">Address: 85-88 St Martin's Lane<br/></div></body></html>`;
  assert.equal(extractTheatremonkeyVenue(hrefOnly), null);
  assert.equal(extractTheatremonkeyVenue(''), null);
  assert.equal(extractTheatremonkeyVenue(null), null);
  // Degenerate matches (too short / markup leaking through) are rejected.
  assert.equal(extractTheatremonkeyVenue('Venue: <br/>'), null);
});

test('extractTheatremonkeyDates: "Showing from X to Y" → ISO previews start / closing', () => {
  const now = new Date('2026-09-28T00:00:00Z');
  assert.deepEqual(extractTheatremonkeyDates(SHOW_HTML, now), { showingFrom: '2026-05-20', showingTo: '2027-04-17' });
  assert.deepEqual(extractTheatremonkeyDates('<p>Showing from Mon, 5th January 2027.</p>', now), { showingFrom: '2027-01-05', showingTo: null });
  assert.deepEqual(extractTheatremonkeyDates('<p>Booking now open.</p>', now), { showingFrom: null, showingTo: null });
  assert.deepEqual(extractTheatremonkeyDates('', now), { showingFrom: null, showingTo: null });
});

test('parseBritishDate: ordinal day + month name + year, sane year window, else null', () => {
  const now = new Date('2026-09-28T00:00:00Z');
  assert.equal(parseBritishDate('20th May 2026', now), '2026-05-20');
  assert.equal(parseBritishDate('1st Sept 2027', now), '2027-09-01');
  assert.equal(parseBritishDate('3 March 2025', now), '2025-03-03');
  assert.equal(parseBritishDate('20th May 2019', now), null, 'far past rejected');
  assert.equal(parseBritishDate('20th May 2031', now), null, 'far future rejected');
  assert.equal(parseBritishDate('May 2026', now), null, 'month-only is not a date');
  assert.equal(parseBritishDate('20th Smarch 2026', now), null);
});

test('parseVenuePageBudget: default 20; --tm-page-budget=N beats TM_VENUE_PAGE_BUDGET; 0 is legal; junk → default', () => {
  assert.equal(DEFAULT_VENUE_PAGE_BUDGET, 20);
  assert.equal(parseVenuePageBudget([], {}), 20);
  assert.equal(parseVenuePageBudget(['--dry-run', '--tm-page-budget=5'], {}), 5);
  assert.equal(parseVenuePageBudget([], { TM_VENUE_PAGE_BUDGET: '7' }), 7);
  assert.equal(parseVenuePageBudget(['--tm-page-budget=3'], { TM_VENUE_PAGE_BUDGET: '7' }), 3);
  assert.equal(parseVenuePageBudget(['--tm-page-budget=0'], {}), 0);
  assert.equal(parseVenuePageBudget(['--tm-page-budget=-4'], {}), 20);
  assert.equal(parseVenuePageBudget(['--tm-page-budget=lots'], {}), 20);
  assert.equal(parseVenuePageBudget([], { TM_VENUE_PAGE_BUDGET: '' }), 20);
});

test('cacheEntryUsable: per-status TTLs; unknown status / bad timestamp are never usable', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  assert.equal(cacheEntryUsable({ status: 'ok', fetchedAt: at(59) }, now), true);
  assert.equal(cacheEntryUsable({ status: 'ok', fetchedAt: at(61) }, now), false);
  assert.equal(cacheEntryUsable({ status: 'no-venue', fetchedAt: at(6) }, now), true);
  assert.equal(cacheEntryUsable({ status: 'no-venue', fetchedAt: at(8) }, now), false);
  assert.equal(cacheEntryUsable({ status: 'not-found', fetchedAt: at(6) }, now), true);
  assert.equal(cacheEntryUsable({ status: 'error', fetchedAt: at(0.5) }, now), true);
  assert.equal(cacheEntryUsable({ status: 'error', fetchedAt: at(2) }, now), false);
  assert.equal(cacheEntryUsable({ status: 'weird', fetchedAt: at(0) }, now), false);
  assert.equal(cacheEntryUsable({ status: 'ok', fetchedAt: 'never' }, now), false);
  assert.equal(cacheEntryUsable(null, now), false);
  assert.equal(CACHE_TTL_MS.ok, 60 * day);
});

test('planVenueFetches: cache hits resolve without a fetch, stale/missing entries are fetched within the budget, rest deferred', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const entries = ['a', 'b', 'c', 'd', 'e'].map(s => ({ title: s.toUpperCase(), slug: s, url: `${TM_SHOW_URL_PREFIX}${s}/` }));
  const cache = { version: 1, updatedAt: null, entries: {
    [entries[0].url]: { title: 'A', venue: 'Apollo Theatre', status: 'ok', fetchedAt: new Date(now - 1 * day).toISOString() },
    [entries[1].url]: { title: 'B', venue: null, status: 'no-venue', fetchedAt: new Date(now - 1 * day).toISOString() },
    [entries[2].url]: { title: 'C', venue: 'Old Vic', status: 'ok', fetchedAt: new Date(now - 90 * day).toISOString() }, // stale
  } };

  const plan = planVenueFetches(entries, cache, { budget: 2, now });
  assert.deepEqual(plan.fromCache, [{ ...entries[0], venue: 'Apollo Theatre' }]);
  assert.equal(plan.knownNoVenue, 1);
  assert.deepEqual(plan.toFetch.map(e => e.slug), ['c', 'd'], 'index order when nothing is prioritised');
  assert.deepEqual(plan.deferred.map(e => e.slug), ['e']);

  // Budget 0 = cache-only run.
  const none = planVenueFetches(entries, cache, { budget: 0, now });
  assert.deepEqual(none.toFetch, []);
  assert.deepEqual(none.deferred.map(e => e.slug), ['c', 'd', 'e']);

  // Empty / missing cache: everything needs a fetch, default budget applies.
  const cold = planVenueFetches(entries, null, { now });
  assert.deepEqual(cold.fromCache, []);
  assert.equal(cold.toFetch.length, 5);
});

test('planVenueFetches: prioritised entries (titles not already in shows.json) take the budget first, order otherwise stable', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const entries = ['a', 'b', 'c', 'd'].map(s => ({ title: s.toUpperCase(), slug: s, url: `${TM_SHOW_URL_PREFIX}${s}/` }));
  const existing = new Set(['a', 'b'].map(titleKey));
  const plan = planVenueFetches(entries, { entries: {} }, {
    budget: 2,
    now,
    prioritize: (e) => !existing.has(titleKey(e.title)),
  });
  assert.deepEqual(plan.toFetch.map(e => e.slug), ['c', 'd']);
  assert.deepEqual(plan.deferred.map(e => e.slug), ['a', 'b']);
});

test('titleKey: lower-case alphanumerics, leading article dropped, diacritics folded first (matches the WE divergence log)', () => {
  assert.equal(titleKey('The Play That Goes Wrong'), 'play that goes wrong');
  assert.equal(titleKey("Disney's Hercules!"), 'disneys hercules');
  assert.equal(titleKey('A Month in the Country'), 'month in the country');
  assert.equal(titleKey('Les Misérables'), 'les miserables', 'fold, do not shred, accented letters (task #648)');
  assert.equal(titleKey('Café Müller'), 'cafe muller');
  assert.equal(titleKey(null), '');
});

test('recordVenueResult + save/load round-trip; corrupt or missing cache loads as empty', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-venue-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'theatremonkey-venue-cache.json');

  assert.deepEqual(loadVenueCache(file), { version: 1, updatedAt: null, entries: {} });
  writeFileSync(file, '{broken');
  assert.deepEqual(loadVenueCache(file), { version: 1, updatedAt: null, entries: {} });

  const cache = loadVenueCache(file);
  const now = new Date('2026-09-28T00:00:00Z');
  const b = { title: 'B', slug: 'b', url: `${TM_SHOW_URL_PREFIX}b/` };
  const a = { title: 'A', slug: 'a', url: `${TM_SHOW_URL_PREFIX}a/` };
  recordVenueResult(cache, b, { status: 'ok', venue: 'Apollo Theatre', now });
  recordVenueResult(cache, a, { status: 'error', error: 'HTTP 503 ' + 'x'.repeat(300), now });
  assert.throws(() => recordVenueResult(cache, a, { status: 'maybe', now }), /unknown cache status/);
  // 'ok' with a venue keeps it; any other status stores venue: null.
  assert.equal(cache.entries[b.url].venue, 'Apollo Theatre');
  assert.equal(cache.entries[a.url].venue, null);
  assert.ok(cache.entries[a.url].error.length <= 200, 'error text is bounded');

  saveVenueCache(cache, file, now);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.updatedAt, '2026-09-28T00:00:00.000Z');
  assert.deepEqual(Object.keys(raw.entries), [a.url, b.url], 'keys sorted for reviewable diffs');
  assert.deepEqual(loadVenueCache(file).entries, cache.entries);

  // Round-tripped entries feed the planner: the fresh 'ok' hit resolves, the fresh 'error' is skipped.
  const plan = planVenueFetches([a, b], loadVenueCache(file), { budget: 5, now: now.getTime() + 60_000 });
  assert.deepEqual(plan.fromCache, [{ ...b, venue: 'Apollo Theatre' }]);
  assert.equal(plan.knownNoVenue, 1);
  assert.deepEqual(plan.toFetch, []);
});

test('discover-new-shows.js Theatremonkey path is wired to the lib and gates venues like OLT/LT (§15 wiring)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'discover-new-shows.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/theatremonkey-venue['"]\)/);
  const fnStart = src.indexOf('async function fetchShowsFromTheatremonkey(');
  assert.ok(fnStart > 0, 'fetchShowsFromTheatremonkey must exist');
  const body = src.slice(fnStart, src.indexOf('\n// ── Official London Theatre', fnStart));
  assert.match(body, /planVenueFetches\(/, 'per-run fetch plan comes from the lib');
  assert.match(body, /extractTheatremonkeyVenue\(/, 'venue comes from the show page');
  assert.match(body, /sanitizeVenueForWrite\(entry\.venue\)/, 'venue strings go through sanitizeVenueForWrite');
  assert.match(body, /isNonTheatreVenue\(venue\) \|\| isLondonReceivingHouse\(venue\)/, 'non-theatre / receiving-house gate applied');
  assert.doesNotMatch(body, /venue:\s*'TBA'/, 'no placeholder venue may be written (card #1060)');
  assert.doesNotMatch(body, /index has no venue data/, 'the blanket skip is gone');
});
