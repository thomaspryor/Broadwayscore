import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideClusterAction, looksLikeConsentWall, hasStar } =
  require('../../scripts/lib/cluster-canonical.js');

// Fixtures modelled on the REAL 2026-07-05 cluster corpus so each production
// verdict is locked to the empirical case it came from.

test('recover: one real-body file among empty wrong-production siblings (much-ado-globe WOS)', () => {
  const files = [
    ...['alun', 'daisy', 'judi', 'matt', 'michael', 'mickey'].map((c) => ({
      file: `whatsonstage--${c}.json`, contentTier: 'invalid', fullTextLen: 0,
      wrongProduction: true, wrongShow: true, aggregatorStars: '4/5 stars',
    })),
    { file: 'whatsonstage--sarah-crompton.json', contentTier: 'complete', fullTextLen: 3498,
      fullTextHead: "Chelsea Walker's production of the Bard's much-loved comedy runs until 24 October",
      wrongProduction: false, wrongShow: false, originalScore: '4/5', criticName: 'Sarah Crompton' },
  ];
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'recover');
  assert.equal(r.canonical, 'whatsonstage--sarah-crompton.json');
});

test('recover via venueMatch overriding a stale wrongShow (midsummer-regents WOS)', () => {
  // All copies carry the SAME correct body + a false wrongShow flag; one sibling
  // is wrongProduction and must be dropped from candidacy.
  const body = "Atri Banerjee's production, music by Maimuna Memon, runs until 18 July at the Regent's Park Open Air Theatre";
  const files = [
    ...['alex-wood', 'alun-hood', 'daniel-perks', 'miriam-sallon'].map((c) => ({
      file: `whatsonstage--${c}.json`, contentTier: 'invalid', fullTextLen: 3417, fullTextHead: body,
      wrongProduction: false, wrongShow: true, venueMatch: true, originalScore: '2/5 stars', criticName: c,
    })),
    { file: 'whatsonstage--theo-bosanquet.json', contentTier: 'stub', fullTextLen: 0,
      wrongProduction: true, wrongShow: false, aggregatorStars: '4/5 stars', criticName: 'Theo Bosanquet' },
  ];
  const r = decideClusterAction(files, {});
  assert.equal(r.action, 'recover');
  assert.notEqual(r.canonical, 'whatsonstage--theo-bosanquet.json'); // wrongProduction dropped
  assert.ok(r.canonical.startsWith('whatsonstage--'));
});

test('recover with preferredCanonical override among identical bodies (aint-no-mo Variety)', () => {
  const files = ['aramide-tinubu', 'charles-isherwood', 'frank-rizzo', 'naveen-kumar', 'peter-marks'].map((c, i) => ({
    file: `variety--${c}.json`, contentTier: 'complete',
    fullTextLen: c === 'frank-rizzo' ? 6529 : 6069, // frank is longest → would win by length
    fullTextHead: 'The question at the heart of Ain’t No Mo’, the incendiary production',
    wrongProduction: false, wrongShow: false, criticName: c, includable: true,
  }));
  // Without override, length tiebreak picks the (invented) longest byline.
  const noOverride = decideClusterAction(files, { hardReject: false });
  assert.equal(noOverride.canonical, 'variety--frank-rizzo.json');
  // With override → the genuine critic wins.
  const withOverride = decideClusterAction(files, { preferredCanonical: 'variety--aramide-tinubu.json' });
  assert.equal(withOverride.action, 'recover');
  assert.equal(withOverride.canonical, 'variety--aramide-tinubu.json');
});

test('wrongProduction with a manual clear is a valid candidate (death-of-a-salesman-2022 wsj)', () => {
  // Real 2026-08-15 corpus: wsj--charles-isherwood.json carries a STALE
  // wrongProduction:true (cross-show URL collision) that an operator already
  // cleared via wrongProductionManualClear — review-guards.js's real scoring
  // gate already treats this file as includable. isCandidate() must agree,
  // or a preferredCanonical override pointing at it is silently ignored.
  const files = [
    { file: 'wsj--charles-isherwood.json', contentTier: 'complete', fullTextLen: 5848,
      fullTextHead: 'Wendell Pierce and Sharon D Clarke Joan MarcusNew York',
      wrongProduction: true, wrongProductionManualClear: true, wrongShow: false,
      criticName: 'Charles Isherwood' },
    { file: 'wsj--chris-jones.json', contentTier: 'excerpt', fullTextLen: 0,
      wrongProduction: true, wrongShow: false, criticName: 'Chris Jones' },
    { file: 'wsj--unknown.json', contentTier: 'complete', fullTextLen: 5706,
      fullTextHead: 'Charles Isherwood\n\nNew York',
      wrongProduction: false, wrongShow: false, criticName: null },
  ];
  // Without the manual-clear-respecting fix, isCandidate drops isherwood.json
  // outright and a preferredCanonical pointing at it would be silently ignored.
  const withOverride = decideClusterAction(files, { preferredCanonical: 'wsj--charles-isherwood.json' });
  assert.equal(withOverride.action, 'recover');
  assert.equal(withOverride.canonical, 'wsj--charles-isherwood.json');

  // An UNCLEARED wrongProduction file must still be excluded from candidacy.
  const stillExcluded = [
    { file: 'wsj--chris-jones.json', contentTier: 'excerpt', fullTextLen: 0,
      wrongProduction: true, wrongShow: false, criticName: 'Chris Jones' },
    { file: 'wsj--unknown.json', contentTier: 'complete', fullTextLen: 5706,
      fullTextHead: 'Charles Isherwood\n\nNew York',
      wrongProduction: false, wrongShow: false, criticName: null },
  ];
  const noPref = decideClusterAction(stillExcluded, {});
  assert.equal(noPref.canonical, 'wsj--unknown.json');
});

test('skip no-recoverable-review: all wrong-production tour files (moulin Chicago tour)', () => {
  const files = Array.from({ length: 29 }, (_, i) => ({
    file: `broadwayworld--${i}.json`, contentTier: 'invalid', fullTextLen: 0, wrongProduction: true,
  }));
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'no-recoverable-review');
  assert.equal(r.canonical, null);
});

test('skip cluster-url-wrong-show: hardReject even when bodies look real (christmas-carol under play-that-goes-wrong)', () => {
  const files = ['arifa', 'kate', 'mark', 'unknown'].map((c) => ({
    file: `guardian--${c}.json`, contentTier: 'complete', fullTextLen: 3200,
    fullTextHead: 'A Christmas Carol Goes Wrong at the Apollo — Mischief Theatre',
    wrongProduction: false, wrongShow: false, criticName: c,
  }));
  const r = decideClusterAction(files, { hardReject: true });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'cluster-url-wrong-show');
});

test('skip no-recoverable-review: all empty extractions of the right URL (midsummer-globe WOS — needs re-gather)', () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    file: `whatsonstage--${i}.json`, contentTier: 'invalid', fullTextLen: 0, wrongProduction: false, wrongShow: false,
  }));
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'skip'); // driver treats empty-but-valid-URL as re-gather candidate
  assert.equal(r.reason, 'no-recoverable-review');
});

test('consent-wall body is NOT a recoverable candidate even at 10k chars', () => {
  const wall = 'Please note that your choices apply across all our subdomains. Once you give consent, a flat list of partners will store and/or access information. Manage your consent, reject all, allow all.';
  assert.equal(looksLikeConsentWall(wall), true);
  const files = [{ file: 'whatsonstage--theo.json', contentTier: 'complete', fullTextLen: 10760,
    fullTextHead: wall, wrongProduction: false, wrongShow: false }];
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'skip'); // length alone must not admit the banner
});

test('consent-wall guard does not false-reject a real review mentioning cookies', () => {
  assert.equal(looksLikeConsentWall('This production of the play is a review triumph; cookies are served in the interval.'), false);
});

test('a body-less star/includable stub is NOT recoverable (moulin Chicago-tour herbert-paine guard)', () => {
  // 4/5 star + includable but empty body at a wrong-production tour URL the
  // show-match gate does not hard-reject → must SKIP, never score the tour.
  const files = [{ file: 'broadwayworld--herbert-paine.json', contentTier: 'excerpt', fullTextLen: 0,
    aggregatorStars: '4/5', includable: true, wrongProduction: false }];
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'no-recoverable-review');
});

test('hasStar parses X/5 forms', () => {
  assert.equal(hasStar('4/5 stars'), true);
  assert.equal(hasStar('3.5 / 5'), true);
  assert.equal(hasStar('B+'), false);
  assert.equal(hasStar(undefined), false);
});

test('a human-vouched review is pinned as canonical even against a longer junk sibling', () => {
  const files = [
    { file: 'nyt--junk.json', contentTier: 'complete', fullTextLen: 9000,
      fullTextHead: 'A long but wrong review of the production', wrongProduction: false, wrongShow: false },
    { file: 'nyt--real.json', contentTier: 'truncated', fullTextLen: 300, humanReviewScore: 85,
      fullTextHead: 'Short human-scored review', wrongProduction: false, wrongShow: false, criticName: 'Ben Brantley' },
  ];
  const r = decideClusterAction(files, { hardReject: false });
  assert.equal(r.action, 'recover');
  assert.equal(r.canonical, 'nyt--real.json'); // human score outranks length
});

test('empty input → skip, never throws', () => {
  assert.deepEqual(decideClusterAction([], {}), { action: 'skip', reason: 'no-recoverable-review', canonical: null });
  assert.deepEqual(decideClusterAction(null, {}), { action: 'skip', reason: 'no-recoverable-review', canonical: null });
});
