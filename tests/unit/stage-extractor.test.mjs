/**
 * Article extractor — The Stage (thestage.co.uk) subscriber-only body.
 *
 * Background (2026-05-31): The Stage is a hard subscription paywall. Until the
 * cookie auth was restored, every fetch returned a registration wall with 0
 * body — so there was no extractor and Stage reviews lived as star-only stubs
 * scored via aggregatorStars-fallback (correct, but no body/excerpt).
 *
 * With valid USERSECURE cookies the full review body comes through as <p>
 * tags across multiple `aos-DS32-WYSEdit` (CMS rich-text) blocks. Two
 * gotchas make this trickier than a single regex:
 *   1. An inline `aos-Article-RelatedContent` widget injects mid-article, so a
 *      tight end-marker truncates the body in half (only ~half the <p>s).
 *   2. After the body come <p> tags for the author bio ("X is a freelance
 *      journalist…"), the subscribe pitch, and a copyright line. These need
 *      content-based filtering since they're regular <p>s.
 *
 * The extractor collects all substantial <p> from the IntroText onward and
 * drops the known trailing-noise shapes. Verified end-to-end on the
 * a-dolls-house live review (2962 chars, 10 paragraphs, no bleed).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: The Stage subscriber-only body', () => {
  test('captures standfirst + full review prose', () => {
    const html =
      '<html><body><article>' +
      '<div class="aos-Article-IntroText aos-DS32-Intro aos-MB15px aos-FL100">' +
        '<p>A devastating new production that earns every minute of its runtime.</p>' +
      '</div>' +
      '<div class="aos-DS32-WYSEdit">' +
        '<p>' + 'The first scene establishes the central conflict with quiet, devastating clarity. '.repeat(4) + '</p>' +
      '</div>' +
      // Mid-article related-content widget — its inner <p> must NOT leak
      '<div class="aos-Article-RelatedContent">' +
        '<p><a href="/reviews/other">Another show you might like</a></p>' +
      '</div>' +
      '<div class="aos-DS32-WYSEdit">' +
        '<p>' + 'The second half deepens the production with searing emotional truth. '.repeat(4) + '</p>' +
      '</div>' +
      // Trailing author bio, subscribe pitch, copyright — content-filtered
      '<p>Jane Doe is a freelance journalist and theatre critic based in London.</p>' +
      '<p>Invest in The Stage today with a subscription starting at just £7.99.</p>' +
      '<p>© Copyright The Stage Media Company Limited 2026</p>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'thestage.co.uk');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('devastating new production'), 'standfirst captured');
    assert.ok(text.includes('central conflict'), 'first body paragraph captured');
    assert.ok(text.includes('searing emotional truth'), 'second body paragraph captured (past mid-article widget)');
    assert.ok(!text.includes('Another show you might like'), 'related widget link leaked');
    assert.ok(!text.includes('Jane Doe is a freelance journalist'), 'author bio leaked');
    assert.ok(!text.includes('Invest in The Stage'), 'subscribe pitch leaked');
    assert.ok(!text.includes('© Copyright'), 'copyright line leaked');
  });

  test('drops single-first-name author bio (Holly is a culture journalist)', () => {
    // Regression (2026-05-31): the multi-word-name pattern required at least
    // one Lastname token, so bylines using just a first name in the bio
    // ("Holly is a culture journalist…") slipped through. Confirmed leaked on
    // 3 of 16 Stage re-ingests. The bio filter now allows zero additional
    // name parts but requires "is a/an/the (culture|theatre|freelance)? X".
    const html =
      '<html><body><article>' +
      '<div class="aos-Article-IntroText"><p>A blistering revival of an old favourite.</p></div>' +
      '<div class="aos-DS32-WYSEdit">' +
        '<p>' + 'The opening builds tension with patient, precise direction throughout the first act. '.repeat(4) + '</p>' +
      '</div>' +
      '<p>Holly is a culture journalist and theatre critic. She is an editor for Backstage Magazine.</p>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'thestage.co.uk');
    assert.ok(text.includes('blistering revival'), 'standfirst captured');
    assert.ok(!text.includes('Holly is a culture journalist'),
      `single-first-name bio leaked: …${text.slice(-200)}`);
  });

  test('returns null on logged-out HTML (no IntroText present)', () => {
    // When the session is dead the registration wall returns no IntroText
    // wrapper. Extractor returns null so the verifier still flags logout.
    const html =
      '<html><body><div class="paywall-wrapper">' +
      '<p>THIS IS NOT A PAYWALL. Sign in below or create a free account to read 5 free articles.</p>' +
      '</div></body></html>';
    const text = extractArticleText(html, 'thestage.co.uk');
    assert.ok(!text, `should return null for logged-out HTML; got: ${(text || '').slice(0, 100)}`);
  });
});
