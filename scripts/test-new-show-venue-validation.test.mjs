// BRO-3679: "the just assassins" searched twice with zero results. Playbill/web
// check (2026-10-05) found no NYC production of Camus's The Just Assassins (only
// Paris Chatelet 2019, Bucharest TNB 2026), so no shows.json stub is added
// (CLAUDE.md §3). This pins the validator behavior that keeps a from-memory stub
// out: a manual stub is provisional, and a stub whose venue/year come from a
// different production is flagged by the real compareShow(). Uses real exports (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isProvisional } = require('./validate-show-venue.js');
const { compareShow } = require('./lib/venue-date-compare.js');

const STUB = {
  id: 'the-just-assassins-off-broadway-2026',
  title: 'The Just Assassins',
  venue: 'Theatre Row',
  category: 'off-broadway',
  type: 'play',
  openingDate: '2026-10-15',
  discoverySource: 'manual-user-request',
};
const PARIS_PAGE = {
  titleParse: { venue: 'Theatre du Chatelet', year: 2019 },
  dates: { openingDate: '2019-10-04' },
  tagLine: { revivalStatus: 'unknown', showType: 'unknown' },
};

test('manual-user-request stub for the missing show is provisional (must be validated)', () => {
  assert.equal(isProvisional(STUB), true);
});

test('stub backed only by a different-venue, different-year production is flagged', () => {
  const { mismatches } = compareShow(STUB, PARIS_PAGE, 'https://playbill.com/production/the-just-assassins-theatre-du-chatelet-2019');
  const fields = mismatches.map(m => m.field);
  for (const f of ['venue', 'opening-year', 'openingDate']) assert.ok(fields.includes(f), `expected ${f} mismatch`);
});

test('a matching production page produces no mismatches', () => {
  const ok = { titleParse: { venue: 'Theatre Row', year: 2026 }, dates: { openingDate: '2026-10-15' }, tagLine: { revivalStatus: 'unknown', showType: 'unknown' } };
  assert.deepEqual(compareShow(STUB, ok, 'https://playbill.com/production/the-just-assassins-theatre-row-2026').mismatches, []);
});
