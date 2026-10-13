// BRO-2902: the venue/date audit (validate-show-venue.js --all-provisional)
// only targeted entries that declared themselves provisional or carried a
// manual/venue-page discoverySource. The two entries with the clearest bad-stub
// signature (venue equal to title) had neither, so the audit never saw them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isProvisional, isExemptFromPlaybillCheck, hasVenueEqualsTitleSignature } = require('../../scripts/validate-show-venue.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The two entries as measured on the card (no provisional, no discoverySource).
const MUSIC_CITY = { id: 'music-city-off-broadway-2026', title: 'Music City', venue: 'Music City', category: 'off-broadway', status: 'open' };
const TRAITORS = {
  id: 'the-traitors-live-experience-off-west-end-2026', title: 'The Traitors: Live Experience',
  venue: 'The Traitors: Live Experience', category: 'off-west-end', status: 'open',
};

test('both venue===title stubs are now reachable by the --all-provisional sweep', () => {
  assert.equal(isProvisional(MUSIC_CITY), true);
  assert.equal(isProvisional(TRAITORS), true);
});

test('the signature normalises punctuation and case, and needs a venue', () => {
  assert.equal(hasVenueEqualsTitleSignature({ title: 'The Traitors: Live Experience', venue: 'the traitors live experience' }), true);
  assert.equal(hasVenueEqualsTitleSignature({ title: 'Music City', venue: "St. Luke's Theatre" }), false);
  assert.equal(hasVenueEqualsTitleSignature({ title: 'Music City', venue: '' }), false);
  assert.equal(hasVenueEqualsTitleSignature({ title: '', venue: '' }), false);
});

test('a normal sourced entry is still NOT pulled into the sweep', () => {
  assert.equal(isProvisional({ id: 'hamilton-2015', title: 'Hamilton', venue: 'Richard Rodgers Theatre', discoverySource: 'ibdb' }), false);
});

test('live corpus: every venue===title entry is reachable by the sweep', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const hits = shows.filter(hasVenueEqualsTitleSignature);
  // An exempt entry (isExemptFromPlaybillCheck) is the only allowed exception.
  const unreachable = hits.filter((s) => !isProvisional(s) && !isExemptFromPlaybillCheck(s)).map((s) => s.id);
  assert.deepEqual(unreachable, []);
  // The signature must stay a narrow selector: it runs live SERP calls in CI.
  assert.ok(hits.length <= 10, `venue===title matched ${hits.length} entries; widen deliberately, not by accident`);
});
