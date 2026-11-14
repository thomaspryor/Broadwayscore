// BRO-5644: a Daily Mail column bundles several reviews, each under its own
// heading and rating block. With the show title, the extractor must read the
// block under this show's heading, and never another show's lone block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractScore, dailyMailRatingSections } = require('../../scripts/lib/score-extractors.js');

const css = (n) => `<p class="mol-ratings-solid"><span class="rating-label">Rating:</span><span class="rating-stars">${[1, 2, 3, 4, 5]
  .map((i) => `<span class="rating-star${i <= n ? ' selected' : ''}"></span>`).join('')}</span></p>`;
const gif = (n) => `<p class="mol-ratings"><strong>Rating: <strong><img class="rating" src="https://i.dailymail.co.uk/i/articles/ratingStars/rating_showbiz_${n}.gif" /></strong></strong></p>`;
const head = (title, verdict) => `<p class="mol-para-with-font"><span class="mol-style-bold">${title}</span></p>` +
  (verdict ? `<p class="mol-para-with-font"><span class="mol-style-bold">Verdict: ${verdict}</span></p>` : '');
const body = `<p class="mol-para-with-font">${'A long paragraph of review prose that runs well past the heading length limit. '.repeat(4)}</p>`;
const page = (...parts) => `<html><body><div itemprop="articleBody">${parts.join('')}</div></body></html>`;

test('lead review on a bundled page reads its own block, not the abstain-on-disagreement page rule', () => {
  const html = page(head('Constellations (Vaudeville Theatre, London)'), gif(4), body,
    head('Piaf (Playhouse, Nottingham)'), gif(3), body, head('The Invisible Hand (Kiln Theatre)'), gif(3), body);
  assert.equal(extractScore(html, '', 'daily-mail'), null, 'no title: disagreeing blocks stay ambiguous');
  const r = extractScore(html, '', 'daily-mail', 'Constellations');
  assert.equal(r?.originalScore, '4/5 stars');
  assert.equal(r.source, 'dailymail-rating-img');
});

test('secondary review in a CSS-star column reads the block under its heading', () => {
  const html = page(head('Backstairs Billy (Duke Of York\'s Theatre, London)', 'A royal bawdy house'), css(3), body,
    head('The Box Of Delights (Royal Shakespeare Theatre)', 'More Milk Tray than Black Magic'), css(4), body);
  const r = extractScore(html, '', 'daily-mail', 'The Box of Delights');
  assert.equal(r?.originalScore, '4/5 stars');
  assert.equal(r.source, 'dailymail-css-stars');
});

test("another show's lone block is not this show's rating (elektra-west-end-2025)", () => {
  const html = page(body, `<p>Elektra is at the Duke of York's until March 29</p>`,
    head('The Double Act (Arcola Theatre, London)', 'Salty satire'), css(3), body);
  assert.equal(extractScore(html, 'review text', 'daily-mail', 'Elektra'), null);
  assert.equal(extractScore(html, 'review text', 'daily-mail')?.originalScore, '3/5 stars', 'title-less callers keep the old rule');
});

test('a production title matches the show-name heading ("Cabaret at the Kit Kat Club")', () => {
  const html = page(head('Cabaret Playhouse Theatre Until October 1, 2hrs 45mins'), gif(3), body,
    head('Habeas Corpus Menier Chocolate Factory'), gif(2), body);
  assert.equal(extractScore(html, '', 'mail-on-sunday', 'Cabaret at the Kit Kat Club')?.originalScore, '3/5 stars');
});

test('a subtitle title matches its head ("Pretty Woman – The Musical")', () => {
  const html = page(head('Pretty Woman: The Musical Piccadilly Theatre, London'), gif(2), body,
    head('La Cage Aux Folles Park Theatre, London'), gif(3), body);
  assert.equal(extractScore(html, '', 'daily-mail', 'Pretty Woman – The Musical')?.originalScore, '2/5 stars');
});

test('Mail on Sunday layout: title line, then a venue/run-time line, then the block', () => {
  const html = page(`<p><span class="mol-style-bold">Under Milk Wood</span></p><p>Olivier Theatre, London 1hr 55mins, until July 24</p>`, gif(3), body,
    `<p><span class="mol-style-bold">Albion</span></p><p>Almeida Theatre, London Until February 29, 3hrs 5mins</p>`, gif(5), body);
  assert.equal(extractScore(html, '', 'mail-on-sunday', 'Under Milk Wood')?.originalScore, '3/5 stars');
  assert.equal(extractScore(html, '', 'mail-on-sunday', 'Albion')?.originalScore, '5/5 stars');
});

test('a heading title that is a prefix of ours matches; a different show never does', () => {
  const html = page(head('The Hunger Games (Troubadour Canary Wharf Theatre)'), css(3), body,
    head('Hamlet (Globe)', 'Fine'), css(4), body);
  assert.equal(extractScore(html, '', 'daily-mail', 'The Hunger Games On Stage')?.originalScore, '3/5 stars');
  assert.equal(extractScore(html, '', 'daily-mail', 'The Importance of Being Oscar'), null);
});

test('single-review page: venue-only heading, page title names the show', () => {
  const html = `<html><head><title>PATRICK MARMION reviews Aladdin | Daily Mail Online</title></head><body>${head('Prince Edward Theatre')}${gif(3)}${body}</body></html>`;
  assert.equal(extractScore(html, '', 'daily-mail', 'Aladdin')?.originalScore, '3/5 stars');
  assert.equal(extractScore(html, '', 'daily-mail', 'Kinky Boots'), null, 'a page about another show stays unread');
});

test('review findings: verdict prose, longer titles, captions and prose tails never name the show', () => {
  // "Wicked" in another show's verdict line.
  const verdictProse = page(head('Hamlet (Globe)', 'Fine'), css(4), body, head('Cats (Palladium)', 'Wicked fun'), css(2), body);
  assert.equal(extractScore(verdictProse, '', 'daily-mail', 'Wicked'), null);
  // "Peter Pan Goes Wrong (Apollo)" is not "Peter Pan", nor the reverse.
  const longer = page(head('Peter Pan Goes Wrong (Apollo)'), css(4), body, head('Hamlet (Globe)'), css(2), body);
  assert.equal(extractScore(longer, '', 'daily-mail', 'Peter Pan'), null);
  const shorter = page(head('Peter Pan (Barbican)'), css(4), body, head('Hamlet (Globe)'), css(2), body);
  assert.equal(extractScore(shorter, '', 'daily-mail', 'Peter Pan Goes Wrong'), null);
  // A caption between the title and the block is skipped.
  const caption = `<html><head><title>PATRICK MARMION reviews Aladdin</title></head><body>${head('Aladdin (Prince Edward Theatre)')}<p class="imageCaption">Trevor Dion Nicholas (pictured) as the Genie</p>${gif(3)}${body}</body></html>`;
  assert.equal(extractScore(caption, '', 'daily-mail', 'Aladdin')?.originalScore, '3/5 stars');
  // A plain prose tail with "until" above a venue line is not a title.
  const tail = page(body, `<p>Elektra is at the Duke of York's until March 29</p><p>Arcola Theatre, London 2hrs, until April 5</p>`, gif(3), body);
  assert.equal(extractScore(tail, '', 'daily-mail', 'Elektra'), null);
});

test("a critics' round-up reads the Mail's own block", () => {
  const html = `<html><head><title>Paddington The Musical gets rave reviews</title></head><body>${['The Daily Mail', 'The Telegraph', 'The Stage'].map((o, i) => head(o) + css([5, 4, 4][i]) + body).join('')}</body></html>`;
  assert.equal(extractScore(html, '', 'daily-mail', 'Paddington The Musical')?.originalScore, '5/5 stars');
});

test('blocks with no heading keep the page-level rules', () => {
  const html = page(css(3));
  assert.equal(dailyMailRatingSections(html)[0].heading, '');
  assert.equal(extractScore(html, 'review text', 'daily-mail', 'Elektra')?.originalScore, '3/5 stars');
});

test('the heading walk stops at a long body paragraph', () => {
  const html = page(`<p>Elektra (Duke of York's)</p>`, body, head('The Double Act (Arcola Theatre)', 'Salty satire'), css(3));
  assert.deepEqual(dailyMailRatingSections(html).map((s) => [s.title, s.heading]), [['The Double Act (Arcola Theatre)', 'The Double Act (Arcola Theatre) Verdict: Salty satire']]);
});
