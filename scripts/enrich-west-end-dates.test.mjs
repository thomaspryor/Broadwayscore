// Unit tests for scripts/enrich-west-end-dates.js — the pure
// parsing/validation/merge functions behind Theatremonkey + Playbill London
// date enrichment. Sibling gap to BRO-1108 (enrich-off-broadway-dates.js);
// see scripts/enrich-off-broadway-dates.test.mjs for the template this
// follows (BRO-3527).
//
// Only pure functions are exercised here. Network-calling paths
// (scrapeTheatremonkey, scrapePlaybill) are covered indirectly by
// --dry-run / --show=SLUG manual runs and the weekly workflow's audit trail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBritishDate,
  parsePlaybillDate,
  cleanTitle,
  titleToTmSlugs,
  parseTheatremonkeyIndex,
  extractTheatremonkeyDates,
  parsePlaybillSchedulePage,
  mergeSources,
} = require('./enrich-west-end-dates.js');

test('parseBritishDate — parses ordinal day + month + year', () => {
  assert.equal(parseBritishDate('28th May 2026'), '2026-05-28');
  assert.equal(parseBritishDate('1st January 2027'), '2027-01-01');
  assert.equal(parseBritishDate('2nd March 2026'), '2026-03-02');
  assert.equal(parseBritishDate('3rd April 2026'), '2026-04-03');
});

test('parseBritishDate — rejects unparseable text', () => {
  assert.equal(parseBritishDate(''), null);
  assert.equal(parseBritishDate('not a date'), null);
});

test('parseBritishDate — rejects years outside the sanity window', () => {
  assert.equal(parseBritishDate('28th May 1990'), null);
  assert.equal(parseBritishDate('28th May 2099'), null);
});

test('parsePlaybillDate — parses "Month Day, Year"', () => {
  assert.equal(parsePlaybillDate('May 28, 2026'), '2026-05-28');
  assert.equal(parsePlaybillDate('September 8 2026'), '2026-09-08');
});

test('parsePlaybillDate — rejects unparseable text', () => {
  assert.equal(parsePlaybillDate(''), null);
  assert.equal(parsePlaybillDate('not a date'), null);
});

test('parsePlaybillDate — rejects years outside the sanity window', () => {
  assert.equal(parsePlaybillDate('May 28, 1990'), null);
  assert.equal(parsePlaybillDate('May 28, 2099'), null);
});

test('cleanTitle — strips Disney\'s prefix and "the Musical" suffix', () => {
  assert.equal(cleanTitle("Disney's The Lion King the Musical"), 'The Lion King');
  assert.equal(cleanTitle('Hamilton'), 'Hamilton');
});

test('cleanTitle — KNOWN LIMITATION: does not normalize real smart-quote unicode', () => {
  // The source regex is `/['']/g` — both characters inside the brackets are
  // straight ASCII apostrophes (verified via hexdump), not the U+2018/U+2019
  // smart quotes the comment above it claims to normalize. It's a no-op on
  // real smart-quote input. Pinning as documented CURRENT behavior (not
  // desired behavior), same as the OB sibling's known-limitation test —
  // out of scope to fix in a test-coverage-only change to a script with live
  // writes to shows.json (twice-weekly cron, Mon+Thu — see
  // .github/workflows/enrich-west-end-dates.yml).
  assert.equal(cleanTitle('Andy Warhol’s Frankenstein'), 'Andy Warhol’s Frankenstein');
});

test('cleanTitle — KNOWN LIMITATION: smart-quote no-op breaks Disney\'s-prefix stripping', () => {
  // Consequence of the above: cleanTitle's Disney's-prefix regex
  // (`/^Disney's\s+/i`) only matches the ASCII apostrophe. A real Playbill/TM
  // title using a smart-quote "Disney’s" (U+2019) is never normalized to
  // ASCII first, so the prefix strip silently no-ops too. Flagged by Codex
  // adversarial review (BRO-3527 ship-check) as a real interaction between
  // the two known limitations, not just a cosmetic one — pinning both here.
  assert.equal(cleanTitle('Disney’s The Lion King the Musical'), 'Disney’s The Lion King');
});

test('titleToTmSlugs — generates base slug plus the/the-less variants', () => {
  const slugs = titleToTmSlugs({ title: 'The Lion King' });
  assert.ok(slugs.includes('the-lion-king'));
  assert.ok(slugs.includes('lion-king'));
});

test('titleToTmSlugs — adds "the-" prefix when title has none', () => {
  const slugs = titleToTmSlugs({ title: 'Hamilton' });
  assert.ok(slugs.includes('hamilton'));
  assert.ok(slugs.includes('the-hamilton'));
});

test('titleToTmSlugs — appends a venue-suffixed candidate when venue present', () => {
  const slugs = titleToTmSlugs({ title: 'Hamilton', venue: "Victoria Palace Theatre" });
  assert.ok(slugs.some(s => s.includes('victoria-palace-theatre')));
});

test('titleToTmSlugs — output never contains duplicate candidates', () => {
  // NOTE: no realistic title was found that actually forces the `[...new
  // Set(slugs)]` wrapper to remove anything — the base/the-prefix/venue
  // branches don't appear to produce identical strings for any input tried
  // (Codex adversarial review, BRO-3527 ship-check: this input passes even
  // with the Set() wrapper removed). This is an invariant check, not proof
  // the dedup logic is reachable/necessary.
  const slugs = titleToTmSlugs({ title: 'the-the' });
  assert.equal(slugs.length, new Set(slugs).size);
});

test('parseTheatremonkeyIndex — extracts title + slug pairs from show links', () => {
  const html = `<!DOCTYPE html><html><body>
    <a href="/show/hamilton/">Hamilton</a>
    <a href="/show/wicked/">Wicked</a>
    <a href="/shows/">Shows</a>
  </body></html>`;
  const entries = parseTheatremonkeyIndex(html);
  assert.deepEqual(entries, [
    { title: 'Hamilton', tmSlug: 'hamilton' },
    { title: 'Wicked', tmSlug: 'wicked' },
  ]);
});

test('parseTheatremonkeyIndex — rejects "Read more..." link text even on a new, not-yet-seen slug', () => {
  // Must use a slug distinct from any other link in the fixture — reusing an
  // already-seen slug would pass this assertion via the dedup `seen` check
  // instead of the title-text filter it's meant to exercise (Codex
  // adversarial review, BRO-3527 ship-check).
  const html = `<!DOCTYPE html><html><body>
    <a href="/show/hamilton/">Hamilton</a>
    <a href="/show/wicked/">Read more...</a>
  </body></html>`;
  const entries = parseTheatremonkeyIndex(html);
  assert.deepEqual(entries, [{ title: 'Hamilton', tmSlug: 'hamilton' }]);
});

test('parseTheatremonkeyIndex — returns empty array when no show links present', () => {
  assert.deepEqual(parseTheatremonkeyIndex('<html><body>no shows</body></html>'), []);
});

// KNOWN CAVEAT (Codex adversarial review, BRO-3527 ship-check): these
// fixtures are plain text, but extractTheatremonkeyDates() regex-matches
// against the RAW HTML string (scripts/enrich-west-end-dates.js:146-156),
// not text-extracted content. The `\s*` between label and date only skips
// whitespace — an inline tag or `&nbsp;` between "Press Night:" and the date
// (e.g. `<strong>Press Night:</strong> 28th May 2026`) would defeat
// extraction in production. No archived Theatremonkey HTML sample exists in
// this checkout (private aggregator-archive data, not present here) to
// verify the real markup shape — unlike the OB sibling's test file, which
// cross-checked its fixtures against 53 logged real extractions. Pinning
// current regex behavior against plain-text-shaped input, not a verified
// real-page fixture.
test('extractTheatremonkeyDates — extracts both Showing from and Press Night dates', () => {
  const html = 'Showing from Wed, 20th May 2026 to Sat, 17th April 2027. Press Night: 28th May 2026.';
  assert.deepEqual(extractTheatremonkeyDates(html), {
    showingFrom: '2026-05-20',
    pressNight: '2026-05-28',
  });
});

test('extractTheatremonkeyDates — Press Night only (no Showing from line)', () => {
  const html = 'Press Night: 8th September 2026.';
  assert.deepEqual(extractTheatremonkeyDates(html), { showingFrom: null, pressNight: '2026-09-08' });
});

test('extractTheatremonkeyDates — returns nulls when no dates present', () => {
  assert.deepEqual(extractTheatremonkeyDates('<html><body>no dates here</body></html>'), {
    showingFrom: null,
    pressNight: null,
  });
});

// KNOWN CAVEAT (Codex adversarial review, BRO-3527 ship-check): this fixture
// only exercises the sibling `<h2>`/`<ul>` branch of
// parsePlaybillSchedulePage() (scripts/enrich-west-end-dates.js:310-361), not
// the `<p>`-based branch in the same function, and `.text()` on real markup
// does not turn `<br>` into `\n` the way the `<p>` branch's `.split('\n')`
// assumes. Same caveat as above: no archived Playbill London page sample is
// present in this checkout to verify which branch real pages actually use.
function playbillScheduleFixture(entries) {
  const blocks = entries.map(e => `
    <h2>${e.title}</h2>
    <ul>
      <li>First Preview: ${e.firstPreview}</li>
      <li>Opening: ${e.opening}</li>
      <li>Theatre: ${e.theatre || 'Some Theatre'}</li>
    </ul>`).join('\n');
  return `<!DOCTYPE html><html><body><div class="article">${blocks}</div></body></html>`;
}

test('parsePlaybillSchedulePage — extracts title + dates + theatre per entry', () => {
  const html = playbillScheduleFixture([
    { title: 'Hamilton', firstPreview: 'May 20, 2026', opening: 'May 28, 2026', theatre: 'Victoria Palace' },
  ]);
  const entries = parsePlaybillSchedulePage(html);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Hamilton');
  assert.equal(entries[0].firstPreview, '2026-05-20');
  assert.equal(entries[0].opening, '2026-05-28');
  assert.equal(entries[0].theatre, 'Victoria Palace');
});

test('parsePlaybillSchedulePage — handles multiple entries', () => {
  const html = playbillScheduleFixture([
    { title: 'Hamilton', firstPreview: 'May 20, 2026', opening: 'May 28, 2026' },
    { title: 'Wicked', firstPreview: 'June 1, 2026', opening: 'June 10, 2026' },
  ]);
  const entries = parsePlaybillSchedulePage(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].title, 'Wicked');
  assert.equal(entries[1].opening, '2026-06-10');
});

test('parsePlaybillSchedulePage — returns empty array when no entries present', () => {
  assert.deepEqual(parsePlaybillSchedulePage('<html><body>no shows</body></html>'), []);
});

test('mergeSources — Theatremonkey entry with no Playbill match stays theatremonkey-sourced', () => {
  const tm = [{ title: 'Hamilton', firstPreview: '2026-05-20', opening: '2026-05-28' }];
  const merged = mergeSources(tm, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'theatremonkey');
});

test('mergeSources — Playbill-only entry gets playbill source', () => {
  const pb = [{ title: 'Wicked', firstPreview: '2026-06-01', opening: '2026-06-10', source: 'playbill' }];
  const merged = mergeSources([], pb);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'playbill');
});

test('mergeSources — matching titles from both sources merge to "both" and fill gaps', () => {
  const tm = [{ title: 'Hamilton', firstPreview: '2026-05-20', opening: null }];
  const pb = [{ title: 'Hamilton', firstPreview: null, opening: '2026-05-28', source: 'playbill' }];
  const merged = mergeSources(tm, pb);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'both');
  assert.equal(merged[0].firstPreview, '2026-05-20');
  assert.equal(merged[0].opening, '2026-05-28');
});

test('mergeSources — existing TM value is not overwritten when both sources report it', () => {
  const tm = [{ title: 'Hamilton', firstPreview: '2026-05-20', opening: '2026-05-28' }];
  const pb = [{ title: 'Hamilton', firstPreview: '2026-05-21', opening: '2026-05-28', source: 'playbill' }];
  const merged = mergeSources(tm, pb);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].firstPreview, '2026-05-20');
  assert.equal(merged[0].source, 'both');
});

test('mergeSources — title match is case-insensitive', () => {
  const tm = [{ title: 'Hamilton', firstPreview: '2026-05-20', opening: '2026-05-28' }];
  const pb = [{ title: 'HAMILTON', firstPreview: null, opening: null, source: 'playbill' }];
  const merged = mergeSources(tm, pb);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'both');
});
