// Parser test for scripts/lib/playbill-ob-schedule.js using a captured
// snapshot of Playbill's "Schedule of Upcoming Off-Broadway Shows" article.
// Per feedback_test_extraction_pattern.md: require the real lib, don't
// reimplement the parser in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlaybillOBSchedule } = require('../../scripts/lib/playbill-ob-schedule.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, '..', 'fixtures', 'ob-discovery', 'playbill-ob.html'), 'utf8');

test('parsePlaybillOBSchedule returns entries with title + at least one date', () => {
  const entries = parsePlaybillOBSchedule(FIXTURE);
  assert.ok(entries.length >= 3, `expected >=3 entries, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.title && e.title.length >= 2, `entry has title: ${JSON.stringify(e)}`);
    assert.equal(e.source, 'playbill');
    assert.ok(e.firstPreview || e.opening, `entry has a date: ${JSON.stringify(e)}`);
    if (e.firstPreview) assert.match(e.firstPreview, /^\d{4}-\d{2}-\d{2}$/);
    if (e.opening) assert.match(e.opening, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('parsePlaybillOBSchedule rejects HTML whose title does not match', () => {
  const wrongTitleHTML = '<html><head><title>Some Other Page</title></head><body><strong><a>X</a></strong> First Preview: April 1, 2026</body></html>';
  const entries = parsePlaybillOBSchedule(wrongTitleHTML);
  assert.deepEqual(entries, []);
});

test('parsePlaybillOBSchedule returns empty on empty HTML', () => {
  assert.deepEqual(parsePlaybillOBSchedule(''), []);
  assert.deepEqual(parsePlaybillOBSchedule(null), []);
});

test('parsePlaybillOBSchedule fixture contains the 4 target companies (where listed)', () => {
  const entries = parsePlaybillOBSchedule(FIXTURE);
  const titles = entries.map(e => e.title.toLowerCase()).join(' | ');
  // At least one entry should be tied to one of the non-profit houses we care about.
  // Signature is often absent from Playbill's article — that's OK.
  const recognizableProductions = ['indian princesses', 'are you now', 'birthright', 'a woman among women'];
  const matches = recognizableProductions.filter(p => titles.includes(p));
  assert.ok(matches.length >= 1, `expected at least one of ${recognizableProductions.join(', ')} in titles: ${titles.slice(0, 500)}`);
});

test('parsePlaybillOBSchedule extracts venue from the first bullet line', () => {
  const entries = parsePlaybillOBSchedule(FIXTURE);
  const withVenue = entries.filter(e => e.venue);
  assert.ok(withVenue.length >= 1, `expected at least one entry with venue, got 0 of ${entries.length}`);
  for (const e of withVenue) {
    assert.ok(!/^(First Preview|Opening|Open|Writers?|Playwright|Director|Cast|Music|Book|Lyrics)s?:/i.test(e.venue),
      `venue should not be a labeled field: ${JSON.stringify(e)}`);
  }
  const emporium = entries.find(e => /emporium/i.test(e.title));
  if (emporium) {
    assert.equal(emporium.venue, 'Classic Stage Company/Lynn F. Angelson Theater');
  }
});

test('extractVenue skips labeled fields and returns null when absent', () => {
  const { extractVenue } = require('../../scripts/lib/playbill-ob-schedule.js');
  assert.equal(
    extractVenue('TITLE\n• The Public Theater/Delacorte Theater\n• First Preview: May 22, 2026\n• Opening: June 11, 2026'),
    'The Public Theater/Delacorte Theater'
  );
  assert.equal(extractVenue('TITLE\n• First Preview: May 22, 2026\n• Opening: June 11, 2026'), null);
  assert.equal(extractVenue(''), null);
});

test('extractVenue rejects slash/comma labels and survives merged bullet lines', () => {
  const { extractVenue } = require('../../scripts/lib/playbill-ob-schedule.js');
  // Labels containing / , & must not be mistaken for venues
  assert.equal(extractVenue('TITLE\n• Director/Choreographer: Casey Nicholaw\n• Venue Name Here\n• Opening: June 1, 2026'), 'Venue Name Here');
  assert.equal(extractVenue('TITLE\n• Book, Music, and Lyrics: Someone\n• Opening: June 1, 2026'), null);
  // A missed <br> merging fields onto one line keeps only the venue
  assert.equal(extractVenue('TITLE\n• The Public Theater • First Preview: May 22, 2026 • Opening: June 11, 2026'), 'The Public Theater');
  // Entity decoding
  assert.equal(extractVenue('TITLE\n• St. Ann&rsquo;s Warehouse\n• Opening: June 1, 2026'), 'St. Ann’s Warehouse');
});
