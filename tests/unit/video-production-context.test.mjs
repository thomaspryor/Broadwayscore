// BRO-4328: ~10% of video reviews were filed under the wrong production.
// require()s the real helpers (CLAUDE.md §15). Fixtures are real shows.json rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeProduction, videoPredatesProduction } = require('../../scripts/lib/video-production-context.js');

const hamletBam = { id: 'hamlet-off-broadway-2026', title: 'Hamlet', venue: 'BAM Harvey Theater', category: 'off-broadway', market: 'broadway', previewsStartDate: '2026-04-19', openingDate: '2026-05-04', closingDate: '2026-05-17' };
const oedipus = { id: 'oedipus-2025', title: 'Oedipus', venue: 'Studio 54', theaterAddress: '254 W 54th St, New York, NY 10019', category: 'broadway', market: 'broadway', previewsStartDate: '2025-10-30', openingDate: '2025-11-13', closingDate: '2026-02-08', isRevival: true };
const rhino = { id: 'rhinoceros-regional-2026', title: 'Rhinoceros', venue: 'American Repertory Theater, Cambridge, MA', category: 'regional', market: 'regional', previewsStartDate: null, openingDate: '2026-08-24' };

test('a 2023 Shakespeare in the Park video predates the 2026 BAM Hamlet', () => {
  assert.equal(videoPredatesProduction('20230622', hamletBam), true);
});

test('a first-preview reaction and anything after it do not predate', () => {
  assert.equal(videoPredatesProduction('20260419', hamletBam), false);
  assert.equal(videoPredatesProduction('20260415', hamletBam), false); // inside the grace window
  assert.equal(videoPredatesProduction('2026-05-10', hamletBam), false);
});

test('unknown dates never count', () => {
  assert.equal(videoPredatesProduction('NA', hamletBam), false);
  assert.equal(videoPredatesProduction(null, hamletBam), false);
  assert.equal(videoPredatesProduction('20230101', { title: 'X' }), false);
});

test('falls back to opening date when previews are unknown', () => {
  assert.equal(videoPredatesProduction('20260701', rhino), true);
  assert.equal(videoPredatesProduction('20260820', rhino), false);
});

test('production description names city, venue and run dates', () => {
  const d = describeProduction(oedipus);
  assert.match(d, /Broadway, New York City/);
  assert.match(d, /Studio 54/);
  assert.match(d, /previews from 2025-10-30/);
  assert.match(d, /a revival/);
  assert.match(describeProduction(rhino), /US regional theater.*Cambridge, MA/);
});
