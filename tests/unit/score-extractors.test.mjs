/**
 * BRO-866: explicit star ratings at star-rating outlets must win over LLM scores.
 * Cases from the card: NYSR "Data" (5 unicode stars), Guardian "Cats" (4 stars),
 * Culture Sauce "Cats" (★★★★☆ at the end of the text).
 * Uses the real extractScore/getBestScore so a production regression fails here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore, KNOWN_STAR_OUTLETS } = require('../../scripts/lib/score-extractors.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const { setKnownShowTitlesForTest } = require('../../scripts/lib/known-show-titles.js');

const BODY = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40);

describe('BRO-866 explicit star extraction', () => {
  test('NYSR five unicode stars extract to 100', () => {
    const r = extractScore('', `★★★★★ ${BODY}`, 'nysr', 'Data');
    assert.strictEqual(r.normalizedScore, 100);
    assert.strictEqual(r.originalScore, '5/5 stars');
  });

  test('Guardian (known star outlet) extracts anchored stars when no extractor hit', () => {
    assert.ok(KNOWN_STAR_OUTLETS.has('guardian'));
    const r = extractScore('', `★★★★☆ ${BODY}`, 'guardian', 'Cats');
    assert.strictEqual(r.normalizedScore, 80);
  });

  test('Culture Sauce trailing stars extract to 80', () => {
    const r = extractScore('', `${BODY} ★★★★☆`, 'culture-sauce', 'Cats');
    assert.strictEqual(r.normalizedScore, 80);
  });

  test('mid-body stars (pull quotes) are not trusted', () => {
    const mid = `${BODY.slice(0, 1000)} ★★★★★ ${BODY.slice(0, 1000)}`;
    assert.strictEqual(extractScore('', mid, 'guardian', 'Cats'), null);
  });
});

describe('BRO-866 getBestScore does not defer to LLM', () => {
  const base = { showTitle: 'Cats', llmScore: { score: 82, confidence: 'high' } };

  test('explicit originalScore wins over LLM', () => {
    const r = getBestScore({ ...base, outletId: 'culture-sauce', originalScore: '4/5 stars', fullText: BODY });
    assert.ok(r && r.score === 80, JSON.stringify(r));
    assert.notStrictEqual(r.source, 'llmScore');
  });

  test('known star outlet with only fullText stars recovers the star score', () => {
    const r = getBestScore({ ...base, outletId: 'guardian', fullText: `★★★★☆ ${BODY}` });
    assert.ok(r && r.score === 80, JSON.stringify(r));
    assert.strictEqual(r.source, 'originalScore-inline-recovery');
  });
});

// BRO-4838: the fallthrough only matched contiguous runs of 3-5 glyphs, so a
// 1★/2★ verdict or a spaced run ("★ ★ ★ ★ ☆") was never stored and the review
// scored unanchored (Affluenza, Theatre and Tonic "★" scored 42).
describe('BRO-4838 star groups', () => {
  const CHROME = ' The Latest 6 October 2026 Another show at Somewhere Review Read more'.repeat(20);

  test('lone ★ before the sign-off is a 1-star verdict even with trailing chrome', () => {
    const t = `${BODY} Affluenza plays at Riverside Studios until 28th November 2026. ★ Written by Bronagh for Theatre and Tonic, October 2026.${CHROME}`;
    const r = extractScore('', t, 'theatreandtonic', 'Affluenza');
    assert.strictEqual(r.originalScore, '1/5 stars');
    assert.strictEqual(r.normalizedScore, 20);
  });

  test('spaced and wrapped runs count as one rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ★ ★ ★ ★ ☆`, 'guardian', 'X').originalScore, '4/5 stars');
    assert.strictEqual(extractScore('', `${BODY} ★★ ★★★ Written by Bronagh`, 'theatreandtonic', 'X').originalScore, '5/5 stars');
  });

  test('2-star opening line is read', () => {
    const r = extractScore('', `Teeth 'N' Smiles review and star rating: ★★ ${BODY}`, 'city-am', "Teeth 'N' Smiles");
    assert.strictEqual(r.originalScore, '2/5 stars');
  });

  test('roundup picks the short run named for this show, not its neighbour', () => {
    const t = `${BODY} Star ratings (out of five) Infinite Life ★★★★★ The Homecoming ★★ Pacific Overtures ★★★ Infinite Life is at the Dorfman.`;
    assert.strictEqual(extractScore('', t, 'guardian', 'The Homecoming').originalScore, '2/5 stars');
    assert.strictEqual(extractScore('', t, 'guardian', 'Pacific Overtures').originalScore, '3/5 stars');
  });

  test('a lone ★ among other unnamed star groups is decoration, not a rating', () => {
    const t = `${BODY} Theatre Royal ★ Save up to 56% Lyceum Theatre ★ No booking fee`;
    assert.strictEqual(extractScore('', t, 'guardian', 'Cats'), null);
  });

  // Second-opinion findings on the first cut of this change.
  test('a lone ☆ is not a 0-star rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ☆ Save to favourites`, 'guardian', 'Cats'), null);
  });

  test('a half before the empty stars keeps the half', () => {
    assert.strictEqual(extractScore('', `${BODY} ★★★½☆`, 'guardian', 'Cats').originalScore, '3.5/5 stars');
  });

  test('a rating and a decoration on the next line do not merge', () => {
    const r = extractScore('', `${BODY} Verdict ★★★★\n\n★ Recommended`, 'guardian', 'Cats');
    assert.notStrictEqual(r && r.originalScore, '5/5 stars');
  });

  test('a sole ★ badge with no rating context is not a 1-star verdict', () => {
    assert.strictEqual(extractScore('', `${BODY} ★ Top pick this week`, 'guardian', 'Cats'), null);
  });

  test('more than five glyphs is not a 5-star rating', () => {
    assert.strictEqual(extractScore('', `${BODY} ★★★★★★★`, 'guardian', 'Cats'), null);
  });
});

// BRO-5223: stars in page chrome (a "More reviews"/"Related" rail, a headline
// list of other articles) rated OTHER shows. Time Out's Orphans (2013) ended
// with "Theater review: Well, I'll Let You Go (★★★★★) is a mourning glory" and
// the fallthrough stored 5/5 (100) for a 2/5 review. A group is dropped only
// with positive evidence it is another show's: a chrome heading, or a label
// that IS another known show title. Never because a label fails to match.
describe('BRO-5223 chrome star groups', () => {
  const REVIEW = `Theater review by David Cote. Gerald Schoenfeld Theatre. ${BODY} It's a dull, mechanical night.`;
  const HEADLINES = ' Bars around NY will be allowed to stay open later during the World Cup A massive Portugal watch party is happening in Dumbo';
  before(() => setKnownShowTitlesForTest(["Well, I'll Let You Go", 'Hamlet', 'Orphans', 'Harry Potter and the Cursed Child', 'Cats', 'Another Show',
    'Score', 'The End', 'Summer', 'Company', 'Romeo + Juliet']));
  after(() => setKnownShowTitlesForTest(null));

  test('a chrome headline naming another show with ★★★★★ gives no score', () => {
    const t = `${REVIEW} Ladies and gentlemen, NYC is getting a new area code: 465 Theater review: Well, I'll Let You Go (★★★★★) is a mourning glory${HEADLINES}`;
    assert.strictEqual(extractScore('', t, 'timeout', 'Orphans'), null);
  });

  test("a chrome '5 stars' next to another show's title gives no score", () => {
    assert.strictEqual(extractScore('', `${REVIEW} More reviews Hamlet ★★★★★ 5 stars Read the review`, 'timeout', 'Orphans'), null);
    assert.strictEqual(extractScore('', `${REVIEW} More reviews Hamlet ★★★★★ 5 stars Read the review`, 'timeout'), null, 'chrome heading needs no title');
    assert.strictEqual(extractScore('', `${REVIEW} Well, I'll Let You Go ★★★★★ 5 stars Read the review`, 'timeout', 'Orphans'), null);
  });

  test("the review's own headline and verdict still count", () => {
    assert.strictEqual(extractScore('', `Theater review: Orphans (★★) ${BODY}`, 'timeout', 'Orphans').originalScore, '2/5 stars');
    assert.strictEqual(extractScore('', `Theater review: Orphans (★★☆☆☆) ${BODY}`, 'timeout').originalScore, '2/5 stars');
    assert.strictEqual(extractScore('', `${BODY} Orphans ★★☆☆☆`, 'timeout', 'Orphans').originalScore, '2/5 stars');
    assert.strictEqual(extractScore('', `${BODY} Verdict: ★★★★☆`, 'guardian', 'Cats').originalScore, '4/5 stars');
    assert.strictEqual(extractScore('', `${BODY} It is a dull night. ★★☆☆☆`, 'timeout', 'Orphans').originalScore, '2/5 stars');
  });

  test('a byline, venue or short title before a trailing verdict is not another show', () => {
    const cases = [
      [`${BODY} Neil Dowden ★★★★☆`, 'guardian', 'Cats', '4/5 stars'],
      [`${BODY} At the Gielgud Theatre ★★★★☆`, 'guardian', 'Cats', '4/5 stars'],
      [`${BODY} BY ADAM FELDMAN ★★☆☆☆`, 'timeout', 'Orphans', '2/5 stars'],
      [`${BODY} Cursed Child ★★★★☆`, 'guardian', 'Harry Potter and the Cursed Child', '4/5 stars'],
      [`${BODY} Theater review: Cursed Child (★★★★☆)`, 'timeout', 'Harry Potter and the Cursed Child', '4/5 stars'],
      [`${BODY} Theater review: Orphans ★★☆☆☆`, 'timeout', undefined, '2/5 stars'],
      [`${BODY} Theater review: Well, I'll Let You Go (★★★★★)`, 'timeout', undefined, '5/5 stars'],
    ];
    for (const [t, outlet, title, want] of cases) {
      const r = extractScore('', t, outlet, title);
      assert.strictEqual(r && r.originalScore, want, `${t.slice(-50)} / ${title}`);
    }
  });

  test('a verdict label or a common-word known title before the stars is not another show', () => {
    for (const label of ['Score:', 'The End', 'Summer', 'Our rating:', 'Verdict']) {
      const r = extractScore('', `${BODY} ${label} ★★★★☆`, 'guardian', 'Cats');
      assert.strictEqual(r && r.originalScore, '4/5 stars', label);
    }
  });

  test('"Romeo + Juliet" names the same show as "Romeo and Juliet"', () => {
    const r = extractScore('', `${BODY} Theater review: Romeo + Juliet (★★★★☆)`, 'timeout', 'Romeo and Juliet');
    assert.strictEqual(r && r.originalScore, '4/5 stars');
  });

  test('"More reviews" in prose is not a chrome heading', () => {
    for (const t of [`${BODY} More reviews are coming soon. Verdict ★★★★☆`, `${BODY} More reviews are coming soon. It is a triumph. ★★★★☆`]) {
      const r = extractScore('', t, 'guardian', 'Cats');
      assert.strictEqual(r && r.originalScore, '4/5 stars', t.slice(-60));
    }
  });

  test('a verdict box outside the review <article> still counts', () => {
    const html = `<html><body><main><article><h1>Orphans</h1><p>${REVIEW}</p></article><div class="verdict">Verdict ★★☆☆☆</div></main></body></html>`;
    const text = `Orphans ${REVIEW} Verdict ★★☆☆☆`;
    assert.strictEqual(extractScore('', text, 'timeout', 'Orphans').originalScore, '2/5 stars');
    assert.strictEqual(extractScore(html, text, 'timeout', 'Orphans').originalScore, '2/5 stars');
  });

  test('a capitalised "Most read" sentence is not a chrome heading', () => {
    const t = `${BODY} Most read novels never reach the stage. ${BODY} ★★★★☆`;
    assert.strictEqual(extractScore('', t, 'guardian', 'Cats').originalScore, '4/5 stars');
  });

  const page = (reviewWrap, related) => `<html><head><title>Orphans</title></head><body>
    <header><nav>Things to do</nav></header>
    ${reviewWrap(`<h1>Orphans</h1><p>${REVIEW}</p>`)}
    <aside>${related}</aside></body></html>`;
  const RELATED = "<article><h3>Another Show</h3><p>&#9733;&#9733;&#9733;&#9733;&#9734;</p><p>Read the review</p></article>";
  // The text a scraper extracts from the whole page, rail included.
  const PAGE_TEXT = `Things to do Orphans ${REVIEW} Another Show ★★★★☆ Read the review`;

  test('a related-show <article> card is not read as the review rating', () => {
    const html = page(inner => `<article>${inner}</article>`, RELATED);
    assert.strictEqual(extractScore(html, PAGE_TEXT, 'timeout', 'Orphans'), null);
    assert.strictEqual(extractScore(html, PAGE_TEXT, 'timeout'), null, 'no show title passed');
  });

  test('a related <article> that is not the review body is never the scan region', () => {
    // Review body is a plain <div>; the only <article> is the related card, so
    // the text path decides: "Another Show" is a known show title.
    const html = page(inner => `<div class="body">${inner}</div>`, RELATED);
    assert.strictEqual(extractScore(html, PAGE_TEXT, 'timeout', 'Orphans'), null);
  });

  test('stars inside the review article or articleBody are still read', () => {
    const html = page(inner => `<article><p>&#9733;&#9733;&#9734;&#9734;&#9734;</p>${inner}</article>`, RELATED);
    const text = `Things to do ★★☆☆☆ Orphans ${REVIEW} Another Show ★★★★☆ Read the review`;
    assert.strictEqual(extractScore(html, text, 'timeout', 'Orphans').originalScore, '2/5 stars');
    const html2 = page(inner => `<div itemprop="articleBody">${inner}<p>★★☆☆☆</p></div>`, RELATED);
    const text2 = `Things to do Orphans ${REVIEW} ★★☆☆☆ Another Show ★★★★☆ Read the review`;
    assert.strictEqual(extractScore(html2, text2, 'timeout', 'Orphans').originalScore, '2/5 stars');
  });

  test('a header rating outside the review element still counts', () => {
    // Stars sit in a header above the <article>, as icons the element text lacks.
    const html = `<html><body><header><span class="rating">★★★★☆</span></header><article><h1>Orphans</h1><p>${REVIEW}</p></article></body></html>`;
    const text = `★★★★☆ Orphans ${REVIEW}`;
    assert.strictEqual(extractScore(html, text, 'timeout', 'Orphans').originalScore, '4/5 stars');
  });
});

test('BRO-5223: lower-case prose that reads like a chrome heading does not hide the verdict', () => {
  const t = `${BODY} It may be the most popular revival of the year. ${BODY} ★★★★☆`;
  assert.strictEqual(extractScore('', t, 'guardian', 'Cats').originalScore, '4/5 stars');
});

test('BRO-5223: an out-of-range numeric entity in the review HTML does not throw', () => {
  const html = `<html><body><article><h1>Orphans</h1><p>&#99999999; &#x110000; ${BODY}</p></article></body></html>`;
  assert.doesNotThrow(() => extractScore(html, `Orphans ${BODY}`, 'timeout', 'Orphans'));
});
