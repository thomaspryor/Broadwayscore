/**
 * theartsdesk.com extraction, BRO-7061.
 *
 * After the autumn 2026 rebuild the generic fallback saved the "Help keep arts journalism alive" support banner as the
 * first paragraph and stopped at the first inline image's visually-hidden "Image" label, so London reviews landed as
 * ~290-word "truncated" files ending in "Image". Markup below mirrors the live page (Drupal: banner body field, then the
 * article-body block with #unsubscribed_summary + #pico and <article class="media"> figures). Text is synthetic: real
 * review text never goes in this public repo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText, extractArtsDeskBody, isExclusiveExtractorHost, isDedicatedExtractorHost } from '../../scripts/lib/article-extractor.js';

const P = (n) => `<p>Paragraph ${n} of the review. The company stages the second act with a clarity the first lacked, and the lead holds the room. </p>`;
const FIGURE = '<article class="media media--type-image media--view-mode-image-column-width"><div class="field field--name-field-media-image">' +
  '<div class="field__label visually-hidden">Image</div><div class="field__item"><img src="/sites/default/files/a.jpg" alt="Show"></div></div></article>';
const BANNER = '<div class="block block-block-content"><div class="clearfix text-formatted field field--name-body"><div style="background-color:#b4442f">' +
  '<h2><strong>Help keep arts journalism alive.</strong></h2><p>We’re rebuilding theartsdesk to secure it as a bastion of real culture writing. ' +
  'Your participation is absolutely vital to this - <strong>subscribe today</strong> and be part of this movement.</p>' +
  '<p><a href="/subscriptions-help"><strong>SUBSCRIBE TODAY</strong></a></p></div></div></div>';

function page({ banner = BANNER, body } = {}) {
  return '<html><body>' + banner +
    '<h1 class="articleTitle">Show, Venue review</h1>' +
    '<div class="block block-layout-builder block-field-blocknodearticlebody">' +
    '<div id="unsubscribed_summary"><div class="field field--name-body">' + P(1) + P(2) + '</div></div>' +
    '<div id="transparent_div" class="PicoSignal"></div>' +
    '<div id="pico"><div class="field field--name-body">' + body + '</div></div></div>' +
    '<div class="block block-layout-builder block-field-blocknodearticlefield-related-content"><div class="field__item"><a href="/theatre/other">Another Show, Other Theatre review - unrelated headline</a></div></div>' +
    '</body></html>';
}

const FULL = page({ body: P(3) + FIGURE + P(4) + P(5) + P(6) + FIGURE + P(7) + P(8) +
  '<ul><li><a href="https://venue.example/show">Show at Venue until 17 January</a></li><li><a href="/theatre">More theatre reviews on theartsdesk</a></li></ul>' });

describe('theartsdesk.com extractor', () => {
  test('drops the support banner and keeps paragraphs on both sides of inline images', () => {
    const t = extractArticleText(FULL, 'theartsdesk.com');
    assert.ok(t, 'expected text');
    assert.doesNotMatch(t, /Help keep arts journalism alive|rebuilding theartsdesk|SUBSCRIBE/i);
    assert.ok(t.startsWith('Show, Venue review\n\nParagraph 1 of the review'), 'headline leads, then body');
    for (let n = 1; n <= 8; n++) assert.ok(t.includes(`Paragraph ${n} of the review`), `missing paragraph ${n}`);
    assert.ok(t.split('\n\n').length === 9);
  });

  test('does not end at the visually-hidden "Image" label or keep link/sidebar chrome', () => {
    const t = extractArticleText(FULL, 'www.theartsdesk.com');
    assert.doesNotMatch(t, /\bImage\s*$/);
    assert.doesNotMatch(t, /until 17 January|More theatre reviews|unrelated headline/);
  });

  test('strips a banner paragraph that sits inside the body block (older captures)', () => {
    const t = extractArtsDeskBody(page({ banner: '', body: '<p>Help keep arts journalism alive. We’re rebuilding theartsdesk to secure it.</p>' + P(3) + FIGURE + P(4) }));
    assert.doesNotMatch(t, /Help keep arts journalism alive/);
    assert.ok(t.includes('Paragraph 4 of the review'));
  });

  test('keeps a review paragraph that merely mentions the banner wording', () => {
    const t = extractArtsDeskBody(page({ body: '<p>The programme urges you to subscribe today, which the critic found rich given the ticket prices on offer here.</p>' + P(3) }));
    assert.ok(t.includes('subscribe today'));
  });

  test('fails loud (null) when the article-body block is missing, never the banner', () => {
    const html = '<html><body>' + BANNER + '<main><p>' + 'Some other chrome text. '.repeat(40) + '</p></main></body></html>';
    assert.equal(extractArticleText(html, 'theartsdesk.com'), null);
    assert.equal(extractArtsDeskBody(html), null);
  });

  test('host helpers: dedicated and exclusive match theartsdesk URLs only', () => {
    assert.ok(isDedicatedExtractorHost('https://theartsdesk.com/theatre/x'));
    assert.ok(isExclusiveExtractorHost('https://theartsdesk.com/theatre/x'));
    assert.ok(isExclusiveExtractorHost('www.theartsdesk.com'));
    assert.ok(!isExclusiveExtractorHost('https://nottheartsdesk.com/x'));
    assert.ok(!isExclusiveExtractorHost('https://variety.com/x'));
  });

  test('the headline keeps a title-less review past the URL-to-content check (BRO-7061)', async () => {
    const { createRequire } = await import('node:module');
    const { validateContentMentionsShow } = createRequire(import.meta.url)('../../scripts/lib/content-quality.js');
    const html = FULL.replace('<html>', '<html><head><title>Speculations, Marylebone Theatre review - the real mystery</title></head>')
      .replace('Show, Venue review', 'Speculations, Marylebone Theatre review - the real mystery');
    const t = extractArtsDeskBody(html);
    const body = t.split('\n\n').slice(1).join('\n\n');
    assert.equal(validateContentMentionsShow(body, html, 'Speculations', 'speculations-off-west-end-2026').valid, false);
    assert.equal(validateContentMentionsShow(t, html, 'Speculations', 'speculations-off-west-end-2026').valid, true);
  });
});
