/**
 * Tests for scripts/lib/showscore-closure-guard.js (BRO-4617)
 * Run: node --test scripts/lib/showscore-closure-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldTrustShowScoreClosed, todayTixIdMismatch } = require('./showscore-closure-guard.js');

// slam-frank-off-broadway-2026 as it sat on 2026-10-04: stale 2025-run ShowScore page.
const slam = { id: 'slam-frank-off-broadway-2026', status: 'open', openingDate: '2026-10-04', closingDate: '2026-11-30',
  previewsStartDate: '2026-09-17', todaytixId: 45252,
  ticketLinks: [{ url: 'https://www.todaytix.com/nyc/shows/47340-slam-frank' }] };

test('slam-frank: just-opened show is not closed by a stale ShowScore page', () => {
  const r = shouldTrustShowScoreClosed(slam, { closingDate: '2025-06-01' }, '2026-10-05');
  assert.equal(r.trust, false);
});
test('future-dated show is never closed by ShowScore', () => {
  assert.equal(shouldTrustShowScoreClosed({ openingDate: '2026-12-01' }, {}, '2026-10-05').trust, false);
});
test('recent previews with no openingDate is not closed by ShowScore', () => {
  assert.equal(shouldTrustShowScoreClosed({ previewsStartDate: '2026-09-25' }, {}, '2026-10-05').trust, false);
});
test('todaytixId mismatch makes the close untrusted even for an old show', () => {
  const s = { openingDate: '2026-01-10', todaytixId: 1, ticketLinks: [{ url: 'https://www.todaytix.com/nyc/shows/22-chicago' }] };
  assert.equal(shouldTrustShowScoreClosed(s, {}, '2026-10-05').trust, false);
});
test('long-open show with a consistent closed reading may close', () => {
  const s = { openingDate: '2026-01-10', previewsStartDate: '2025-12-20' };
  assert.equal(shouldTrustShowScoreClosed(s, {}, '2026-10-05').trust, true);
});
test('no dates at all: trust (legacy behaviour preserved)', () => {
  assert.equal(shouldTrustShowScoreClosed({}, {}, '2026-10-05').trust, true);
});
test('flags todaytixId vs ticketLinks mismatch', () => {
  assert.equal(todayTixIdMismatch(slam), true);
  assert.equal(todayTixIdMismatch({ ...slam, todaytixId: 47340 }), false);
  assert.equal(todayTixIdMismatch({ todaytixId: 1 }), false);
});
