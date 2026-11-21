// BRO-6487: 2016-era The Stage review pages have no aos-Article-IntroText block; the review is plain <p>
// after the <h1>, then author bio, subscribe line and copyright (shape seen on the Cleansed review, 7 body paragraphs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleText } = require('./article-extractor.js');

const BODY = [
  'It is hard to watch. Yet here we are, watching a production that is simultaneously repellent and compelling in its staging.',
  'Her production is simultaneously repelling and compelling, with a cold precision that the text itself demands from every performer.',
  'Mitchell’s production is strikingly precise about the violence it shows, and the design leaves nothing comfortable to look at.',
  'Some of the choreography, the criss-crossing of bodies across the stage, is oddly beautiful and the more disturbing for it.',
  'Like Blasted, it was written while the first wave of reviews was still in the writer’s mind, and it shows in every scene.',
  'For all the appalling things we witness, the evening is held together by performances of real tenderness from the whole cast.',
  'Though there are flowers, and even birds, the final image leaves the audience in no doubt about what has been done.',
];
const page = (inner, head = '<h1>Cleansed review, Dorfman, National Theatre, London, 2016</h1>') =>
  `<html><body><nav><p>Menu</p></nav>${head}${inner}</body></html>`;
const ps = (arr) => arr.map((t) => `<p>${t}</p>`).join('');
const TRAIL = '<p>Natasha is international editor for The Stage and a theatre critic.</p><p>Invest in The Stage today with a subscription starting at £1.</p><p>© Copyright Playbook Media Trading Company Limited</p>';

test('plain-paragraph Stage review is extracted, trailing bio/subscribe/copyright dropped', () => {
  const t = extractArticleText(page(ps(BODY) + TRAIL), 'thestage.co.uk');
  assert.ok(t && t.includes('simultaneously repellent') && t.includes('criss-crossing'), String(t).slice(0, 80));
  assert.ok(!/international editor|Invest in The Stage|Copyright/.test(t));
});

test('registration-gate page stays null (dead session must not look like a recovery)', () => {
  const gated = page(ps(BODY) + '<p>Create a free account to read 5 free articles. utm_source=Reggate</p>');
  assert.equal(extractArticleText(gated, 'thestage.co.uk'), null);
});

test('short chrome-only page stays null', () => {
  assert.equal(extractArticleText(page('<p>Sign in to see more of the best theatre writing today and every day.</p>'), 'thestage.co.uk'), null);
});

test('page without an h1 stays null', () => {
  assert.equal(extractArticleText(page(ps(BODY), ''), 'thestage.co.uk'), null);
});

test('listing/404-style page with teaser paragraphs but no author bio, subscribe or copyright trailer stays null', () => {
  const teasers = Array.from({ length: 6 }, (_, i) => `Teaser ${i}: a short blurb about another production currently playing somewhere in London tonight.`);
  assert.equal(extractArticleText(page(ps(teasers)), 'thestage.co.uk'), null);
});

test('sidebar paragraphs after the trailer are not part of the body', () => {
  const t = extractArticleText(page(ps(BODY) + TRAIL + '<p>Another headline paragraph from a sidebar teaser about something else entirely.</p>'), 'thestage.co.uk');
  assert.ok(t && !t.includes('sidebar'));
});

test('"THIS IS NOT A PAYWALL" gate page stays null', () => {
  assert.equal(extractArticleText(page(ps(BODY) + TRAIL + '<p>THIS IS NOT A PAYWALL</p>'), 'thestage.co.uk'), null);
});

test('modern IntroText layout is unchanged and still drops the bio', () => {
  const html = `<html><body><h1>T</h1><div class="aos-Article-IntroText">Standfirst.</div>${ps(BODY)}<p>Sam Marlowe is reviews editor for The Stage and writes about theatre.</p></body></html>`;
  const t = extractArticleText(html, 'thestage.co.uk');
  assert.ok(t && t.includes('criss-crossing'));
});

test('heading after the review paragraphs (real 2016 layout) still extracts', () => {
  const html = `<html><body><div>chrome</div>${ps(BODY)}${TRAIL}<footer><h1>Cleansed review</h1></footer></body></html>`;
  const t = extractArticleText(html, 'thestage.co.uk');
  assert.ok(t && t.includes('criss-crossing') && !/international editor/.test(t));
});

test('a long chrome paragraph far before the review is not pulled into the body', () => {
  const far = '<p>This is a long unrelated promotional paragraph about booking tickets that sits well away from the review text.</p>' + '<div>' + 'x'.repeat(8000) + '</div>';
  const t = extractArticleText(page(far + ps(BODY) + TRAIL), 'thestage.co.uk');
  assert.ok(t && t.includes('criss-crossing') && !t.includes('promotional'));
});

test('header chrome paragraph with "Login Register" above the review does not anchor or break extraction', () => {
  const html = `<html><body><header><p>Login Register to see more of the best theatre writing on The Stage today.</p></header><h1>Cleansed review</h1>${ps(BODY)}${TRAIL}</body></html>`;
  const t = extractArticleText(html, 'thestage.co.uk');
  assert.ok(t && t.includes('criss-crossing') && !t.includes('Login Register'));
});

test('teaser listing ending in a "Related Articles" paragraph (no bio/subscribe/copyright) stays null', () => {
  const teasers = Array.from({ length: 6 }, (_, i) => `Teaser ${i}: a short blurb about another production currently playing somewhere in London tonight.`);
  assert.equal(extractArticleText(page(ps(teasers) + '<p>Related Articles and more from this author for you to read next.</p>'), 'thestage.co.uk'), null);
});

test('live layout: review paragraphs tight together, then ~30k chars of author-card markup, then bio/subscribe/copyright', () => {
  const card = '<div>' + '<span>card</span>'.repeat(2000) + '</div>';
  const html = `<html><body><h1>Cleansed review</h1>${ps(BODY)}${card}<p>Natasha is international editor for The Stage and writes about theatre.</p>${card}<p>Invest in The Stage today with a subscription starting at £1.</p><p>© Copyright Playbook Media Trading Company Limited</p></body></html>`;
  const tx = extractArticleText(html, 'thestage.co.uk');
  assert.ok(tx && tx.includes('criss-crossing') && !/international editor|Invest in The Stage/.test(tx));
});
