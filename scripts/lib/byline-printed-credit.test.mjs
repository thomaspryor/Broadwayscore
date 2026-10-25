// Printed-credit bylines and emoji star ratings that the page metadata hides. Fixtures are real
// excerpts from the Martin Guerre (Old Vic, 2026) review pages and stored review texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const text = require('./byline-from-text');
const html = require('./byline-extraction');
const { extractLeadEmojiStars } = require('./score-extractors');
const { findPublishedStarInText } = require('./published-star-capture');

test('South London: the standfirst "writes <critic>" beats the CMS staff account', () => {
  const t = 'To the Old Vic for ninety minutes of quality theatre, with fantastic sets, special effects and powerful voices. Well, all I can say is, poor Bertrande! The Old Vic never disappoints, writes Lizzie Paul. I knew this would be something special.';
  assert.deepEqual(text.extractSouthLondonByline(t), { name: 'Lizzie Paul', known: true });
  assert.equal(text.printedBylineOverride('south-london', t, 'https://southlondon.co.uk/area/southwark/review-martin-guerre-old-vic/'), 'Lizzie Paul');
  // no credit, or a lowercase fragment, is not a byline
  assert.equal(text.extractSouthLondonByline('A great night out, he writes about the show in detail.'), null);
  assert.equal(text.extractSouthLondonByline('Nothing printed here at all.'), null);
  assert.equal(text.printedBylineOverride('vulture', t, 'https://example.com/x'), null);
});

test('All That Dazzles: "Review by <critic>" before the emoji stars', () => {
  const t = 'Review: Cats (Regent&#x27;s Park Open Air Theatre) All That Dazzles 9 hours ago 7 min read Review by Daz Gale ⭐️⭐️⭐️⭐️⭐️ When it comes to Andrew Lloyd Webber musicals';
  assert.deepEqual(text.extractAllThatDazzlesByline(t), { name: 'Daz Gale', known: true });
  assert.equal(text.printedBylineOverride('all-that-dazzles-uk', t, ''), 'Daz Gale');
});

test("Talkin' Broadway, NYTG and Time Out credits (fill only, never an override)", () => {
  assert.equal(text.extractTalkinBroadwayByline("Talkin' Broadway Review: Chita Rivera\n\nTheatre Review by Matthew Murray \n - December 11, 2005\n\nWritten by Terrence McNally").name, 'Matthew Murray');
  assert.equal(text.extractNewYorkTheatreGuideByline('Review by Kathleen Campion 7 June 2016 Sean Hayes walks onto the stage').name, 'Kathleen Campion');
  assert.equal(text.extractTimeOutByline('Bug Review 4 out of 5 starsBuy ticketWritten by Adam FeldmanTheater and Dance Editor, Time Out USA').name, 'Adam Feldman');
  // the scraped role is glued to the surname
  assert.equal(text.extractTimeOutByline('ShareWritten by Andrzej LukowskiTheatre Editor').name, 'Andrzej Lukowski');
  // a show's "Written by" credit is not a Time Out byline
  assert.equal(text.extractTimeOutByline('Hamilton. Written by Lin-Manuel Miranda. Directed by Thomas Kail.'), null);
  for (const id of ['talkinbroadway', 'nytg', 'timeout', 'timeout-london']) {
    assert.equal(text.printedBylineOverride(id, 'Theatre Review by Matthew Murray \n', ''), null, id);
  }
});

test('extractBylineFromText fills an Unknown South London / Spy-style text credit', () => {
  const r = text.extractBylineFromText('south-london', 'The Old Vic never disappoints, writes Lizzie Paul. More text.');
  assert.equal(r.name, 'Lizzie Paul');
});

const SPY_HTML = '<h2 style="text-align: center;"><em><span>MARTIN GUERRE</span></em></h2>\n<h3><span>The Old Vic</span></h3>\n'
  + '<h4 style="text-align: center;"><span style="color: #000000;">Reviewed on 20th October 2026</span></h4>\n'
  + '<h4 style="text-align: center;"><span style="color: #000000;">by Jonathan Evans</span></h4>\n'
  + '<h5 style="text-align: center;"><span style="color: #000000;">Photography by Helen Maybanks</span></h5>';

test('Reviewed on <date> / by <critic> heading pair (The Spy in the Stalls)', () => {
  const page = `<meta name="author" content="thespyinthestalls" />${SPY_HTML}`;
  assert.equal(html.extractReviewedByLine(page), 'Jonathan Evans');
  assert.equal(html.extractByline(page), 'Jonathan Evans');
  // one element, with a photo credit running on
  assert.equal(html.extractReviewedByLine('<h4>Reviewed on 3 May 2026 by Jane Q Smith Photography by Helen Maybanks</h4>'), 'Jane Q Smith');
  assert.equal(html.extractReviewedByLine('<h4>Reviewed by The Reviews Hub</h4>'), null);
  assert.equal(html.extractReviewedByLine('<p>I reviewed on the train.</p>'), null);
});

test('bold-italic sign-off before the share widget (Musical Theatre Review)', () => {
  const page = '<span class="author vcard"><a href="/author/lisa/" rel="author">Admin</a></span>'
    + '<p>But this version has grown up, matured and deserves to be welcomed.</p>\n'
    + '<p style="text-align: right;"><strong><em>Scott Matthewman</em></strong></p>\nSHARE THIS POST:<div class="synved-social-container">';
  assert.equal(html.extractSignOffBeforeShare(page), 'Scott Matthewman');
  assert.equal(html.extractByline(page), 'Scott Matthewman');
  assert.equal(html.extractSignOffBeforeShare('<p><strong><em>Admin</em></strong></p>\nSHARE THIS POST:'), null);
  assert.equal(html.extractSignOffBeforeShare('<p>No sign off.</p>\nSHARE THIS POST:'), null);
});

test('star emoji verdict under the headline is captured at any outlet', () => {
  const t = "A Beautifully Performed Production but Less Is Not Always More ⭐⭐⭐⭐ What's it about? Thirty years after its original West End premiere, Martin Guerre returns to London in a radically reimagined production at The Old Vic.";
  assert.deepEqual(extractLeadEmojiStars(t), { originalScore: '4/5 stars', normalizedScore: 80, source: 'unicode-stars' });
  assert.deepEqual(extractLeadEmojiStars('Review by Daz Gale ⭐️⭐️⭐️⭐️⭐️ When it comes to'), { originalScore: '5/5 stars', normalizedScore: 100, source: 'unicode-stars' });
  assert.equal(extractLeadEmojiStars('No rating here at all.'), null);
  // "⭐️ 3 Stars" (Pink Prince Theatre): the number after a lone star is the rating
  assert.deepEqual(extractLeadEmojiStars('REVIEW: DARKLING @ BUSH THEATRE 🗓 Tuesday 15 September 2026 ⭐️ 3 Stars A DAZZLING DESIGN'), { originalScore: '3/5 stars', normalizedScore: 60, source: 'unicode-stars' });
  // a lone star icon in scraped page chrome is not a one-star review
  assert.equal(extractLeadEmojiStars("'Dead Outlaw' review: best of the decade TV you need 2026 reads Celeb news ⭐ U.S. Politics Sports"), null);
  // two separate runs in the lead is a quoted rating, not this critic's verdict
  assert.equal(extractLeadEmojiStars('⭐⭐⭐ Our verdict. Elsewhere critics gave it ⭐⭐⭐⭐⭐ and more.'), null);
  // a run far down the page is page chrome
  assert.equal(extractLeadEmojiStars(`${'word '.repeat(80)}⭐⭐⭐⭐`), null);
});

test('capture stamps originalScore on an emoji-rated file from an outlet with no extractor', () => {
  const data = {
    outletId: 'stagedtheatre', criticName: 'Karen Jemison', contentTier: 'complete', showTitle: 'Martin Guerre',
    url: 'https://stagedtheatre.co.uk/blogs/theatre-reviews/martin-guerre-the-old-vic',
    fullText: "A Beautifully Performed Production but Less Is Not Always More ⭐⭐⭐⭐ What's it about? Thirty years after its original West End premiere, Martin Guerre returns to London in a radically reimagined production at The Old Vic. " + 'The staging is busy and the score keeps arriving. '.repeat(10),
  };
  assert.deepEqual(findPublishedStarInText(data, { show: { title: 'Martin Guerre' } }), {
    originalScore: '4/5 stars', originalScoreSource: 'unicode-stars', originalScoreNormalized: 80,
  });
  // an explicit rating already stored is left alone
  assert.equal(findPublishedStarInText({ ...data, originalScore: '3/5 stars' }, { show: { title: 'Martin Guerre' } }), null);
});

test('Theatre and Tonic: "Written by <first name> for Theatre and Tonic" beats the CMS account holder', () => {
  const t1 = 'It is an extraordinarily moving evening. Written by Annie for Theatre and Tonic, October 2026.';
  assert.deepEqual(text.extractTheatreAndTonicByline(t1), { name: 'Annie', known: true });
  assert.equal(text.printedBylineOverride('theatreandtonic', t1, '', 'Emmie Newitt'), 'Annie');
  // the credit names the stored person by first name: not an override
  assert.equal(text.printedBylineOverride('theatreandtonic', 'Written by Penny for Theatre and Tonic', '', 'Penny Walshe'), null);
  assert.equal(text.printedBylineOverride('theatreandtonic', 'Written by Emmie for Theatre & Tonic', '', 'Emmie Newitt'), null);
  assert.equal(text.extractTheatreAndTonicByline('Nothing credited here.'), null);
});

test('sameCriticName: one person under a first name, initial or diacritics; never two people', () => {
  assert.equal(text.sameCriticName('Penny Walshe', 'Penny'), true);
  assert.equal(text.sameCriticName('Kimberly Ramírez', 'Kimberly Ramirez'), true);
  assert.equal(text.sameCriticName('Becky K', 'Becky Kennedy'), true);
  assert.equal(text.sameCriticName('Michael Holland', 'Lizzie Paul'), false);
  assert.equal(text.sameCriticName('Emmie Newitt', 'Annie'), false);
  assert.equal(text.sameCriticName('', 'Annie'), false);
});
