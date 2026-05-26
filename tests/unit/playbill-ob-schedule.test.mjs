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
