import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { detectPriorRunRepublish, shouldReleasePriorRunRepublish } = require('./prior-run-republish-guard');
const { guardPublishDate } = require('./date-guard');

const show = { id: 'slam-frank-off-broadway-2026', title: 'Slam Frank', previewsStartDate: '2026-09-17', openingDate: '2026-10-04', closingDate: '2026-11-30', category: 'off-broadway' };

// Verbatim shape of the live Jewish Voice page (BRO-4641).
const JV = 'Brash, Brilliant, Irreverent – Slam Frank Jun 12, 2026 by Two Sues On the Aisle [Updated June 2026] Slam Frank returns Off-Broadway at the Orpheum Theatre October 4 – November 30, 2026. Note: Our review is based on the 2025 performance at the Asylum Theater Slam Frank, a musical comedic satire, playing at the Asylum Theater through December 28, reimagines Anne Frank.';

test('flags "based on the 2025 performance" on a 2026 production', () => {
  const v = detectPriorRunRepublish({ text: JV, show });
  assert.equal(v.flag, true);
  assert.equal(v.reason, 'based-on-prior-year-production');
});

test('flags "was at: <venue> ... through <date before previews>"', () => {
  const t = 'Slam Frank was at: Asylum NYC, 123 W 3rd St through December 28, 2025. A fine show.';
  const v = detectPriorRunRepublish({ text: t, show });
  assert.equal(v.flag, true);
  assert.equal(v.reason, 'prior-run-ended-before-previews');
});

test('genuine 2026 review is not flagged', () => {
  const t = 'Slam Frank opened Sunday at the Orpheum Theatre. The show had a 2025 run at the Asylum Theater, but this staging is sharper. Our review is based on the 2026 performance on October 4.';
  assert.equal(detectPriorRunRepublish({ text: t, show }).flag, false);
});

test('"was at ... through" with an in-run date is not flagged', () => {
  const t = 'Slam Frank was at: Orpheum Theatre through November 30, 2026.';
  assert.equal(detectPriorRunRepublish({ text: t, show }).flag, false);
});

test('declared priorRuns suppresses the detector (same production)', () => {
  const s = { ...show, priorRuns: [{ start: '2025-10-01', end: '2025-12-28', venue: 'Asylum NYC' }] };
  assert.equal(detectPriorRunRepublish({ text: JV, show: s }).flag, false);
});

test('empty inputs are safe', () => {
  assert.equal(detectPriorRunRepublish({ text: '', show }).flag, false);
  assert.equal(detectPriorRunRepublish({ text: JV, show: null }).flag, false);
});

// Documents WHY the date guard missed it: an llm-scoring date before the window is
// replaced by the fetch date (BRO-4473), so the review read as in-window.
test('date guard is blind here: llm-scoring 2026-06-12 is swapped for the fetch date', () => {
  const r = guardPublishDate({ publishDate: '2026-06-12', dateSource: 'llm-scoring', textFetchedAt: '2026-10-04T22:33:59Z' }, show);
  assert.equal(r.substituted, true);
  assert.equal(r.publishDate, '2026-10-04');
});

test('"was at:" about a different show (sidebar) is not flagged', () => {
  const t = 'Great new show. Related: Other Musical was at: Asylum NYC through December 28, 2025.';
  assert.equal(detectPriorRunRepublish({ text: t, show: { ...show, title: 'Slam Frank' } }).flag, false);
});

const flagged = (extra = {}) => ({ wrongProduction: true, wrongProductionReason: 'prior-run-republish', fullText: JV, ...extra });

test('release: still matching body stays flagged', () => {
  assert.equal(shouldReleasePriorRunRepublish(flagged(), show), false);
});

test('release: show gaining priorRuns releases the flag', () => {
  const s = { ...show, priorRuns: [{ start: '2025-10-01', end: '2025-12-28' }] };
  assert.equal(shouldReleasePriorRunRepublish(flagged(), s), true);
});

test('release: refetched clean body releases the flag', () => {
  assert.equal(shouldReleasePriorRunRepublish(flagged({ fullText: 'Slam Frank opened at the Orpheum.' }), show), true);
});

// BRO-4956: Time Out re-dates its evergreen review url when a show returns.
const OAK = { id: 'an-oak-tree-off-west-end-2026', title: 'An Oak Tree', previewsStartDate: '2026-10-07', openingDate: '2026-10-08', category: 'off-west-end' };
const TIMEOUT_CARRY = 'Review An Oak Tree 4 out of 5 stars Theatre, West End The Other Palace, Victoria 9 Oct 15 Nov 2026 Recommended Wednesday 23 September 2026 Written by Tim Bano Time Out says This review is from 2025. An Oak Tree returns yet again for 2026 as part of a season at The Other Palace.';

test('Time Out "This review is from <prior year>" carry-forward is flagged', () => {
  const r = detectPriorRunRepublish({ text: TIMEOUT_CARRY, show: OAK });
  assert.equal(r.flag, true);
  assert.equal(r.reason, 'review-from-prior-year');
});

test('"This review is from" the current year is not flagged', () => {
  const t = TIMEOUT_CARRY.replace('from 2025', 'from 2026');
  assert.equal(detectPriorRunRepublish({ text: t, show: OAK }).flag, false);
});

test('release: operator decisions and other reasons are never released', () => {
  const clean = { fullText: 'Slam Frank opened at the Orpheum.' };
  for (const extra of [{ wrongProductionManualClear: true }, { wrongProductionOverride: true }, { humanReviewedWrongProduction: true }, { allowEarlyDate: true }, { wrongProductionReason: 'dateless-revival' }]) {
    assert.equal(shouldReleasePriorRunRepublish(flagged({ ...clean, ...extra }), show), false, JSON.stringify(extra));
  }
});
