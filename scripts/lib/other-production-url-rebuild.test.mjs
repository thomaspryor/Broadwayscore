// BRO-5015 cluster: the rebuild's other-production url exclusion and its
// self-release. require()s the production functions (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
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

// BRO-8440: corroborated tier. Live 2026-11-28: Birmingham Rep's Peter Pan scored on
// Polka Theatre's, the verifier's wrong-production verdict downgraded to low by its
// date-only "near opening" override.
const POLKA_PAN = {
  id: 'peter-pan-off-west-end-2026', title: 'Peter Pan', category: 'off-west-end',
  venue: 'Polka Theatre', previewsStartDate: '2026-11-14', openingDate: '2026-11-14',
};
const BRUM_PAN = {
  outletId: 'thereviewshub',
  url: 'https://www.thereviewshub.com/peter-pan-birmingham-rep/',
  publishDate: '2026-11-25',
  contentVerification: {
    wrongProduction: true, confidence: 'low',
    reasoning: '[OVERRIDE: review within 11d of opening, likely correct production] Reviews the Birmingham Rep staging.',
  },
};

test('url-place-verified: verifier + url place on a concurrent review is flagged', () => {
  const sig = detectOtherProductionUrl(BRUM_PAN, POLKA_PAN);
  assert.equal(sig && sig.signal, 'url-place-verified');
  assert.match(sig.detail, /birmingham rep/);
});

test('url-place-verified: the url place alone (no verifier verdict) never fires', () => {
  assert.equal(detectOtherProductionUrl({ ...BRUM_PAN, contentVerification: undefined }, POLKA_PAN), null);
  assert.equal(detectOtherProductionUrl({ ...BRUM_PAN, contentVerification: { wrongProduction: false } }, POLKA_PAN), null);
});

test('url-place-verified: no publishDate, no production dates, or a pre-production date: no signal', () => {
  assert.equal(detectOtherProductionUrl({ ...BRUM_PAN, publishDate: undefined }, POLKA_PAN), null);
  assert.equal(detectOtherProductionUrl(BRUM_PAN, { ...POLKA_PAN, previewsStartDate: undefined, openingDate: undefined }), null);
  assert.equal(detectOtherProductionUrl({ ...BRUM_PAN, publishDate: '2026-10-01' }, POLKA_PAN), null);
});

test('url-place-verified: a priorRuns / tourLegs window covering the date, and urlOnly mode, stay out', () => {
  const run = { openingDate: '2026-11-20', closingDate: '2026-12-20', venue: 'Birmingham Rep' };
  assert.equal(detectOtherProductionUrl(BRUM_PAN, { ...POLKA_PAN, priorRuns: [run] }), null);
  assert.equal(detectOtherProductionUrl(BRUM_PAN, { ...POLKA_PAN, tourLegs: [{ startDate: '2026-11-20', endDate: '2026-12-20', venue: 'Birmingham Rep' }] }), null);
  assert.equal(detectOtherProductionUrl(BRUM_PAN, POLKA_PAN, { urlOnly: true }), null);
  // A prior run in another year does not exempt a concurrent regional staging.
  const old = { openingDate: '2019-11-20', closingDate: '2019-12-20', venue: 'Polka Theatre' };
  assert.equal(detectOtherProductionUrl(BRUM_PAN, { ...POLKA_PAN, priorRuns: [old] })?.signal, 'url-place-verified');
});

test('url-place-verified: a verdict on an older copy of the body, or a body naming this cast, stays out', () => {
  const refetched = { ...BRUM_PAN, textFetchedAt: '2026-11-27T10:00:00Z', contentVerification: { ...BRUM_PAN.contentVerification, verifiedAt: '2026-11-26T10:00:00Z' } };
  assert.equal(detectOtherProductionUrl(refetched, POLKA_PAN), null);
  const cast = ['Ava Pollard', 'Tomas Reyne', 'Judith Okafor', 'Liam Castell'];
  const withCast = { ...POLKA_PAN, cast: cast.map((name) => ({ name })) };
  const body = `A joyful night. ${cast.join(' and ')} lead the company with real wit.`;
  assert.equal(detectOtherProductionUrl({ ...BRUM_PAN, fullText: body }, withCast), null);
});

test('url-place-verified: short-stem venue named in full vetoes; .html slugs and title-only home words still match', () => {
  const cv = BRUM_PAN.contentVerification;
  const at = (url, show) => detectOtherProductionUrl({ outletId: 'x', url, publishDate: '2026-11-25', contentVerification: cv }, show);
  assert.equal(at('https://example.co.uk/reviews/peter-pan-polka-theatre-birmingham-rep-transfer', POLKA_PAN), null);
  const mince = { id: 'm', title: 'Operation Mincemeat', category: 'west-end', venue: 'Fortune Theatre', previewsStartDate: '2026-11-01' };
  assert.equal(at('https://example.co.uk/operation-mincemeat-touring.html', mince)?.signal, 'url-place-verified');
  const road = { id: 'r', title: 'London Road', category: 'off-west-end', venue: 'Bush Theatre', previewsStartDate: '2026-11-01' };
  assert.equal(at('https://example.co.uk/reviews/london-road-review-sheffield-crucible-theatre', road)?.signal, 'url-place-verified');
});

test('url-place-verified: real-url negatives (home market, venue, title words, tryout slugs)', () => {
  const cv = BRUM_PAN.contentVerification;
  const at = (url, show, publishDate = '2026-11-25') => detectOtherProductionUrl({ outletId: 'x', url, publishDate, contentVerification: cv }, show);
  // names London / the venue
  assert.equal(at('https://www.whatsonstage.com/london-theatre/reviews/peter-pan-polka-theatre-review/', POLKA_PAN), null);
  // Sheffield is the setting, not the staging (Standing at the Sky's Edge at the NT)
  const sky = { id: 's', title: 'Standing at the Sky’s Edge', category: 'west-end', venue: 'Olivier Theatre', previewsStartDate: '2023-02-09' };
  assert.equal(at('https://www.standard.co.uk/culture/theatre/standing-at-the-skys-edge-national-theatre-review-richard-hawley-chris-bush-sheffield-b1060115.html', sky, '2023-02-14'), null);
  // "Chicago" the musical: the show's own title words never count
  const chi = { id: 'c', title: 'Chicago', category: 'broadway', venue: 'Ambassador Theatre', previewsStartDate: '1996-10-23' };
  assert.equal(at('https://www.nytimes.com/2026/11/20/theater/chicago-review.html', chi), null);
});

test('url-place-verified: NYC show, regional-city review slug and London house', () => {
  const blue = { id: 'b', title: 'Blue Man Group: A New Holiday Surprise', category: 'broadway', venue: 'Lunt-Fontanne Theatre', previewsStartDate: '2026-11-12' };
  const r = { ...BRUM_PAN, url: 'https://www.chicagotribune.com/2026/11/27/review-blue-man-holiday-chicago/', publishDate: '2026-11-27' };
  assert.equal(detectOtherProductionUrl(r, blue)?.signal, 'url-place-verified');
  const ghosts = { id: 'g', title: 'Ghosts', category: 'off-broadway', venue: 'Mitzi E. Newhouse Theater', previewsStartDate: '2025-02-13' };
  const g = { ...BRUM_PAN, url: 'https://www.theguardian.com/stage/2025/apr/17/ghosts-review-ibsen-taboos-lyric-hammersmith-london', publishDate: '2025-04-17' };
  assert.equal(detectOtherProductionUrl(g, ghosts)?.signal, 'url-place-verified');
});

test('url-place-verified release: holds while both witnesses agree, lifts if the verifier flips', () => {
  const flagged = { ...BRUM_PAN, wrongProduction: true, wrongProductionReason: OTHER_PRODUCTION_URL_REASON };
  assert.equal(shouldReleaseOtherProductionUrl(flagged, POLKA_PAN), false);
  const flipped = { ...flagged, contentVerification: { wrongProduction: false, confidence: 'high' } };
  assert.equal(shouldReleaseOtherProductionUrl(flipped, POLKA_PAN), true);
  assert.equal(shouldReleaseOtherProductionUrl({ ...flipped, wrongProductionManualClear: true }, POLKA_PAN), false);
});

// BRO-8449 (c): cast overlap proves the show, not the production. A tour reuses the home cast
// (the Operation Mincemeat tour on the-recs), so a touring url must not take the cast exemption.
test('url-place-verified (BRO-8449): a body naming the cast does not exempt a touring url, but still exempts a named city', () => {
  const cast = ['Ava Pollard', 'Tomas Reyne', 'Judith Okafor', 'Liam Castell'];
  const mince = { id: 'm', title: 'Operation Mincemeat', category: 'west-end', venue: 'Fortune Theatre', previewsStartDate: '2026-11-01', cast: cast.map((name) => ({ name })) };
  const body = `A joyful night. ${cast.join(' and ')} lead the company with real wit.`;
  const cv = { wrongProduction: true, confidence: 'high' };
  const at = (url) => detectOtherProductionUrl({ outletId: 'x', url, publishDate: '2026-11-25', fullText: body, contentVerification: cv }, mince);
  assert.equal(at('https://example.co.uk/operation-mincemeat-touring/')?.signal, 'url-place-verified');
  assert.equal(at('https://example.co.uk/operation-mincemeat-uk-tour-review/'), null, 'tour word mid-slug is no place');
  assert.equal(at('https://example.co.uk/reviews/operation-mincemeat-review-birmingham-rep/'), null, 'a city staging with the home cast stays exempt (transfers share the cast)');
  // A declared tourLegs window still wins over the url.
  const legged = { ...mince, tourLegs: [{ startDate: '2026-11-20', endDate: '2026-12-20', venue: 'UK tour' }] };
  assert.equal(detectOtherProductionUrl({ outletId: 'x', url: 'https://example.co.uk/operation-mincemeat-touring/', publishDate: '2026-11-25', fullText: body, contentVerification: cv }, legged), null);
});
