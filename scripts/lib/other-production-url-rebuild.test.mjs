// BRO-5015 cluster: the rebuild's other-production url exclusion and its
// self-release. require()s the production functions (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectOtherProductionUrl,
  shouldReleaseOtherProductionUrl,
  OTHER_PRODUCTION_URL_REASON,
} = require('./other-production-signal.js');

// Live on 2026-10-12: a 2022 Met review swapped onto the 2026 revival, with
// the current run's date stamped on it, so every date guard passed it.
const TRAVIATA = {
  id: 'la-traviata-off-broadway-2026',
  category: 'off-broadway',
  type: 'opera',
  venue: 'Metropolitan Opera House',
  previewsStartDate: '2026-03-20',
  openingDate: '2026-03-20',
  closingDate: '2026-06-06',
};
const NYCR_2022 = {
  outletId: 'new-york-classical-review',
  url: 'https://newyorkclassicalreview.com/2022/10/sierra-captivates-as-violetta-in-mets-traviata/',
  publishDate: '2026-03-26',
};

test('2022 url on the 2026 revival is flagged even with an in-window publishDate', () => {
  const sig = detectOtherProductionUrl(NYCR_2022, TRAVIATA);
  assert.equal(sig && sig.signal, 'url-year');
});

test('a 2026 url for the same outlet is not flagged', () => {
  assert.equal(detectOtherProductionUrl({ ...NYCR_2022, url: 'https://newyorkclassicalreview.com/2026/03/traviata-review/' }, TRAVIATA), null);
});

test('a declared priorRuns window covering the url year keeps the review', () => {
  const show = { ...TRAVIATA, priorRuns: [{ openingDate: '2022-10-01', closingDate: '2022-11-30', venue: 'Metropolitan Opera House' }] };
  assert.equal(detectOtherProductionUrl(NYCR_2022, show), null);
});

test('the publishDate is never read: a pre-window date alone does not fire', () => {
  const r = { outletId: 'x', url: 'https://example.com/review-traviata', publishDate: '2019-01-01' };
  assert.equal(detectOtherProductionUrl(r, TRAVIATA), null);
});

test('tour / regional shows (no home market) are out of scope, same as the audit', () => {
  assert.equal(detectOtherProductionUrl(NYCR_2022, { ...TRAVIATA, category: 'tour' }), null);
});

test('release: our flag lifts once priorRuns covers the url, never a human decision', () => {
  const flagged = { ...NYCR_2022, wrongProduction: true, wrongProductionReason: OTHER_PRODUCTION_URL_REASON };
  assert.equal(shouldReleaseOtherProductionUrl(flagged, TRAVIATA), false, 'still another production');
  const show = { ...TRAVIATA, priorRuns: [{ openingDate: '2022-10-01', closingDate: '2022-11-30' }] };
  assert.equal(shouldReleaseOtherProductionUrl(flagged, show), true);
  assert.equal(shouldReleaseOtherProductionUrl({ ...flagged, humanReviewedWrongProduction: true }, show), false);
  assert.equal(shouldReleaseOtherProductionUrl({ ...flagged, wrongProductionReason: 'prior-run-republish' }, show), false);
});

test('full url date outside the run with a disagreeing publishDate is flagged (Oslo, Lyttelton review)', () => {
  const oslo = { id: 'oslo-2017', category: 'broadway', venue: 'Vivian Beaumont Theater', previewsStartDate: '2017-03-23', openingDate: '2017-04-13', closingDate: '2017-07-02' };
  const r = { outletId: 'guardian', url: 'https://www.theguardian.com/stage/2017/sep/24/oslo-lyttelton-review-high-drama-back-channels', publishDate: '2017-04-14' };
  assert.equal(detectOtherProductionUrl(r, oslo)?.signal, 'url-date-contradiction');
  // The Broadway review itself (url date agrees with publishDate, inside the run) stays.
  assert.equal(detectOtherProductionUrl({ ...r, url: 'https://www.theguardian.com/stage/2017/apr/14/oslo-review-broadway' }, oslo), null);
});

test('urlOnly drops the publishDate-reading class-G rule but keeps url-year', () => {
  const oslo = { id: 'oslo-2017', category: 'broadway', venue: 'Vivian Beaumont Theater', previewsStartDate: '2017-03-23', openingDate: '2017-04-13', closingDate: '2017-07-02' };
  const r = { outletId: 'guardian', url: 'https://www.theguardian.com/stage/2017/sep/24/oslo-lyttelton-review-high-drama-back-channels', publishDate: '2017-04-14' };
  assert.equal(detectOtherProductionUrl(r, oslo, { urlOnly: true }), null);
  assert.equal(detectOtherProductionUrl(NYCR_2022, TRAVIATA, { urlOnly: true })?.signal, 'url-year');
});

test('null url and missing publishDate are safe', () => {
  assert.equal(detectOtherProductionUrl({ outletId: 'x', url: null }, TRAVIATA), null);
  assert.equal(detectOtherProductionUrl({ outletId: 'x', url: NYCR_2022.url }, TRAVIATA)?.signal, 'url-year');
});

test('the url-proven flag survives the body-replacement neutralizer and the LLM stale sweep', () => {
  const { isDateBasedWrongProduction } = require('./stale-flag-neutralization.js');
  const { isLikelyStaleWrongProduction } = require('./review-guards.js');
  const flagged = {
    ...NYCR_2022,
    wrongProduction: true,
    wrongProductionReason: OTHER_PRODUCTION_URL_REASON,
    wrongProductionNote: 'Other-production url guard: url path year 2022 predates production start 2026',
    fullText: 'La Traviata at the Met. '.repeat(120),
  };
  assert.equal(isDateBasedWrongProduction(flagged), true);
  assert.equal(isLikelyStaleWrongProduction(flagged, { ...TRAVIATA, title: 'La Traviata' }), false);
});
