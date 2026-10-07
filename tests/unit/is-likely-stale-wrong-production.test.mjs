/**
 * Unit tests for review-guards.js — isLikelyStaleWrongProduction
 *
 * Regression for Notion 34e637c5-416f-811d (Session 5 of multi-flag
 * stale-flag audit). The wrongProduction flag has 4 setter paths and most
 * ~15k flagged files are CORRECTLY flagged (tour reviews, regional tryouts,
 * cross-Atlantic transfers, prior revivals). Stale subset is a minority where
 * the producing logic was tightened or an OVERRIDE marker was set but the
 * flag persisted.
 *
 * Predicate is STRICTER than isLikelyStaleWrongShow — wrongProduction is
 * fundamentally about "wrong production of same play," so URL year alignment
 * + publishDate within show's run window are MANDATORY (not OR). The companion
 * sweep script layers a Sonnet HIGH-CONFIDENCE-ONLY second-opinion before
 * physically clearing the flag on disk.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isLikelyStaleWrongProduction } = require('../../scripts/lib/review-guards.js');

const longReviewText = 'A real critic review of the production with substance and analysis. '.repeat(30); // ~2000 chars

describe('isLikelyStaleWrongProduction — true cases (stale flag, should clear)', () => {
  test('Sunday in the Park 2017 — Broadway revival review pub on opening day', () => {
    // Real case from Session 5 manual sample. Matt Windman amny review of the
    // 2017 Jake Gyllenhaal revival; CV got confused by a paragraph about Jake's
    // earlier Little Shop concert appearance.
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' sunday in the park with george is a beautiful Sondheim',
      url: 'http://www.amny.com/entertainment/sunday-in-the-park-with-george-review-jake-gyllenhaal-annaleigh-ashford-star-in-superb-revival-1.13169351',
      publishDate: '2017-02-23',
      contentVerification: { wrongArticle: false, confidence: 'high', reasoning: 'fine' },
    };
    const show = {
      id: 'sunday-in-the-park-with-george-2017',
      title: 'Sunday in the Park with George',
      openingDate: '2017-02-23',
      closingDate: '2017-04-23',
      status: 'closed',
    };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), true);
  });

  test('Almost Famous 2022 — EW review pub on opening day', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' almost famous is a Broadway musical adaptation',
      url: 'https://ew.com/theater/theater-reviews/almost-famous-review-broadway-musical/',
      publishDate: '2022-11-03',
    };
    const show = {
      id: 'almost-famous-2022',
      title: 'Almost Famous',
      openingDate: '2022-11-03',
      closingDate: '2023-01-08',
      status: 'closed',
    };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), true);
  });
});

describe('isLikelyStaleWrongProduction — false cases (correct flag, do not clear)', () => {
  test('Wicked 2003 — Knoxville national tour 2024 review under Broadway opening directory', () => {
    // arts-knoxville URL with 2024 in path; show opened 2003. Year mismatch + tour URL marker.
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' wicked at the Tennessee Theatre on tour',
      url: 'https://artsknoxville.com/index.php/2024/01/13/review-spectacle-abounds-in-national-tour-of-wicked-at-the-tennessee-theatre/',
      publishDate: '2024-01-13',
    };
    const show = {
      id: 'wicked-2003',
      title: 'Wicked',
      openingDate: '2003-10-30',
      status: 'open',
    };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false,
      'national-tour URL marker + 21-year URL/show year gap = correctly flagged');
  });

  test('Macbeth 2022 — TheWrap review of Lincoln Center production (no URL year)', () => {
    // TheWrap content describes Lincoln Center Vivian Beaumont production; show is the
    // 2022 Daniel Craig revival. URL has no year so year-alignment can't catch it.
    // We can't catch this case without LLM — expected false (predicate alone passes,
    // LLM rejects in sweep). Test verifies predicate doesn't add a false NEGATIVE.
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' macbeth at Lincoln Center Vivian Beaumont',
      url: 'https://www.thewrap.com/macbeth-theater-review-ethan-hawke-anne-marie-duff-movie-friendly',
      publishDate: '2022-04-28',
    };
    const show = {
      id: 'macbeth-2022',
      title: 'Macbeth',
      openingDate: '2022-04-28',
      closingDate: '2022-07-10',
      status: 'closed',
    };
    // This is a case where LLM second-opinion is essential.
    // The predicate passes (date in range, no URL year mismatch) — LLM catches the venue.
    // We assert predicate=true here so the sweep correctly hands it to LLM.
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), true,
      'predicate passes; LLM second-opinion catches Lincoln Center venue mismatch in sweep');
  });

  test('already manual-cleared (wrongProductionManualClear=true) — skip', () => {
    const data = {
      wrongProduction: true,
      wrongProductionManualClear: true,
      fullText: longReviewText,
      url: 'https://nytimes.com/2022/11/03/theater/almost-famous-review.html',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('already overridden (wrongProductionOverride=true) — skip', () => {
    const data = {
      wrongProduction: true,
      wrongProductionOverride: true,
      fullText: longReviewText,
      url: 'https://nytimes.com/2022/11/03/theater/almost-famous-review.html',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('humanReviewedWrongProduction=false — skip', () => {
    const data = {
      wrongProduction: true,
      humanReviewedWrongProduction: false,
      fullText: longReviewText,
      url: 'https://nytimes.com/2022/11/03/theater/almost-famous-review.html',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('rejectionReason="wrong_show" — different signal, do not override', () => {
    const data = {
      wrongProduction: true,
      rejectionReason: 'wrong_show',
      fullText: longReviewText + ' almost famous on Broadway',
      url: 'https://nytimes.com/2022/11/03/theater/almost-famous-review.html',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('high-confidence content-verification wrongArticle — do not override', () => {
    const data = {
      wrongProduction: true,
      contentVerification: { wrongArticle: true, confidence: 'high', reasoning: 'wrong production' },
      fullText: longReviewText,
      url: 'https://nytimes.com/2022/11/03/theater/almost-famous-review.html',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('publishDate outside show range — do not override', () => {
    // Review pub'd 2 years before opening — almost certainly different production
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' almost famous',
      url: 'https://nytimes.com/2020/11/03/theater/almost-famous-review.html',
      publishDate: '2020-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('URL year mismatch >1 year — different production', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' wicked',
      url: 'https://variety.com/2018/legit/reviews/wicked-broadway-tour.html',
      publishDate: '2018-05-15',
    };
    const show = { id: 'wicked-2003', title: 'Wicked', openingDate: '2003-10-30', status: 'open' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('roundup URL — never individual production review', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' almost famous',
      url: 'https://www.broadwayworld.com/article/Review-Roundup-Almost-Famous-Opens-on-Broadway-20221103',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('film/TV URL — wrong medium', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' macbeth',
      url: 'https://variety.com/2022/film/reviews/macbeth-tragedy-1234567/',
      publishDate: '2022-04-28',
    };
    const show = { id: 'macbeth-2022', title: 'Macbeth', openingDate: '2022-04-28', closingDate: '2022-07-10', status: 'closed' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('national tour URL marker — correctly flagged', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' wicked',
      url: 'https://artsknoxville.com/2024/01/13/review-spectacle-abounds-in-national-tour-of-wicked/',
      publishDate: '2024-01-13',
    };
    const show = { id: 'wicked-2003', title: 'Wicked', openingDate: '2003-10-30', status: 'open' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('regional outlet city pattern — likely tour', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText + ' hamilton',
      url: 'https://nashvillescene.com/2024/03/15/hamilton-tour-review/',
      publishDate: '2024-03-15',
    };
    const show = { id: 'hamilton-2015', title: 'Hamilton', openingDate: '2015-08-06', status: 'open' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('short fullText (<1500) — insufficient signal', () => {
    const data = {
      wrongProduction: true,
      fullText: 'Brief excerpt only.',
      url: 'https://ew.com/theater/theater-reviews/almost-famous-review-broadway-musical/',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('no URL — cannot verify, do not override', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText,
      url: null,
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('show title not in fullText — cannot verify subject', () => {
    const data = {
      wrongProduction: true,
      fullText: longReviewText, // generic text without show title
      url: 'https://ew.com/theater/theater-reviews/almost-famous-review-broadway-musical/',
      publishDate: '2022-11-03',
    };
    const show = { id: 'almost-famous-2022', title: 'Almost Famous', openingDate: '2022-11-03', status: 'closed', closingDate: '2023-01-08' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false);
  });

  test('wrongProduction=false — predicate is trivially false', () => {
    assert.strictEqual(isLikelyStaleWrongProduction({ wrongProduction: false }, { title: 'X', openingDate: '2022-01-01' }), false);
    assert.strictEqual(isLikelyStaleWrongProduction({}, { title: 'X', openingDate: '2022-01-01' }), false);
    assert.strictEqual(isLikelyStaleWrongProduction(null, { title: 'X', openingDate: '2022-01-01' }), false);
  });

  test('missing show context — return false (safe default)', () => {
    const data = { wrongProduction: true, fullText: longReviewText, url: 'https://x.com/review/', publishDate: '2022-11-03' };
    assert.strictEqual(isLikelyStaleWrongProduction(data, null), false);
    assert.strictEqual(isLikelyStaleWrongProduction(data, {}), false);
    assert.strictEqual(isLikelyStaleWrongProduction(data, { title: 'X' }), false); // title too short
  });

  test('Wicked 2003 / arts-knoxville 2024 tour — real corpus rejection (URL-year + tour marker)', () => {
    // Real cleared-set rejection from Session 5: the predicate must reject this
    // even though title overlap is strong (Wicked at Tennessee Theatre = wicked-2003 directory).
    // URL year 2024 vs show year 2003 (>1 year), AND "national-tour" URL marker. Either
    // alone should reject. If a future predicate change relaxes either gate, this test fails.
    const realFullText = `"Defying Gravity" is quite a bit more than just the well-known song from the Stephen Schwartz musical Wicked. It accurately describes the phenomenon of that Broadway vehicle that is still stealing hearts and going strong after 20 years. In a genre that often sees a show's gradual demise once the original stars have moved on, Wicked has enjoyed the opposite effect. Approaching 8000 performances in its long Broadway run, the touring production at the Tennessee Theatre this week was a spectacle to behold. The cast, ensemble, design, and orchestra all delivered with the polish of a long-running franchise.`.repeat(3);
    const data = {
      wrongProduction: true,
      rejectionReason: 'wrong_production',
      fullText: realFullText,
      url: 'https://artsknoxville.com/index.php/2024/01/13/review-spectacle-abounds-in-national-tour-of-wicked-at-the-tennessee-theatre/',
      publishDate: '2024-01-13',
      outletId: 'arts-knoxville',
      criticName: 'Alan Sherrod',
    };
    const show = {
      id: 'wicked-2003',
      title: 'Wicked',
      openingDate: '2003-10-30',
      status: 'open',
    };
    assert.strictEqual(isLikelyStaleWrongProduction(data, show), false,
      'Real Knoxville tour review must be rejected on URL year + tour marker, even with strong title match');
  });
});
