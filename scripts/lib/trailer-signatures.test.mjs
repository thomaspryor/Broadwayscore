// Known page trailers after a review's last paragraph (zero-gap plan 1C).
// Fixtures are real corpus endings (shortened lead-in). Requires the real
// functions: trailer-signatures, content-quality via classifyTierWriteBack,
// text-cleaning and text-quality.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./trailer-signatures.js');
const { classifyTierWriteBack } = require('./content-tier-reason-sync.js');
const { stripTrailingJunk } = require('./text-cleaning.js');
const { checkTruncation } = require('./text-quality.js');

const BODY = 'The company sings well and the second act moves quickly, though the book sags in places and the staging never quite earns its final image. '.repeat(14).trim();

function tier(fullText, outletId) {
  const r = classifyTierWriteBack({
    showId: 'x-2026', outletId, criticName: 'A Critic', url: 'https://example.com/a',
    fullText, contentTier: 'truncated', wordCount: fullText.split(/\s+/).length,
  });
  return r.tierResult;
}

test('UK bullet listing is stripped; review before it kept', () => {
  assert.equal(T.stripUkListingBullets(BODY + ' • At the Almeida, London, until 7 June'), BODY);
  assert.equal(T.stripUkListingBullets(BODY + ' • Until 12 October'), BODY);
});

test('two-sentence listing ("Then touring") is stripped, bulleted and bare', () => {
  assert.equal(T.stripUkListingBullets(BODY + ' • At Òran Mór, Glasgow, until 10 October. Then touring until 23 October'), BODY);
  assert.equal(T.stripUkListingBullets(BODY + ' At Crucible, Sheffield, until 7 February. Then touring'), BODY);
});

test('bare listing needs a date and an opener; ordinary last sentence is kept', () => {
  assert.equal(T.stripUkListingBullets(BODY + ' At Theatre Royal Haymarket, London, until 3 August'), BODY);
  const prose = BODY + ' At the end of the night the cast takes a bow and the crowd is on its feet';
  assert.equal(T.stripUkListingBullets(prose), prose);
});

test('bare listing: a review cut off mid-sentence on a date is NOT stripped (reviewer blocker 1)', () => {
  const cut = BODY + ' A fine evening. At the interval the cast, who play on until 7 June with';
  assert.equal(T.stripUkListingBullets(cut), cut);
  assert.equal(tier(cut, 'guardian').contentTier, 'truncated');
});

test('bulleted listing: a review cut off inside a bullet is NOT stripped (ship-check finding)', () => {
  for (const tail of [' • At the interval the cast continues to sing and', ' • Until the moment when she']) {
    const cut = BODY + ' Lovely show indeed.' + tail;
    assert.equal(T.stripUkListingBullets(cut), cut);
  }
  assert.equal(T.stripUkListingBullets(BODY + ' • Until 12 October'), BODY);
});

test('listing opener: review prose containing "until 7 June" is not a listing (codex finding)', () => {
  const prose = BODY + ' At the interval the actor, whose contract runs until 7 June';
  assert.equal(T.stripUkListingBullets(prose), prose);
  const bulletProse = BODY + ' • At the climax, the actor falters and';
  assert.equal(T.stripUkListingBullets(bulletProse), bulletProse);
  assert.equal(T.stripUkListingBullets(BODY + ' • At Òran Mór, Glasgow, until 10 October'), BODY);
  assert.equal(T.stripUkListingBullets(BODY + " • 1984 continues at Her Majesty's Theatre until 27 May"), BODY);
});

test('The Stage: a closing critic bio is a trailer; a cut-off review or a prose "X is a ..." line is not (BRO-7171 Stage 4)', () => {
  // real ending: memoriam-off-west-end-2026/thestage--dave-fargnoli.json
  const bio = "Dave is a playwright and critic. He was the winner of The Stage's Critic Search 2015";
  assert.equal(T.stripStageCriticBio(`${BODY}  ${bio}`), BODY);
  assert.equal(tier(`${BODY}  ${bio}`, 'thestage').contentTier, 'complete');
  // only for The Stage
  assert.notEqual(tier(`${BODY}  ${bio}`, 'guardian').contentTier, 'complete');
  // review prose that opens "X is a ..." without a writing job stays
  const prose = `${BODY}  Hamlet is a production that couldn't be more timely and its themes of love`;
  assert.equal(T.stripStageCriticBio(prose), prose);
  // body cut off mid-sentence before the bio: not stripped
  const cut = `${BODY.slice(0, -1)} and the lead  ${bio}`;
  assert.equal(T.stripStageCriticBio(cut), cut);
});

test('one-minute-critic: a cut-off final paragraph is not a headline (codex finding)', () => {
  const cut = BODY + '\n\nThe final act\n\nThe lead actor finally begins to';
  assert.equal(T.stripRelatedPostHeadlines(cut), cut);
  const real = BODY + "\n\nBooks - In 'X,' falling apart is just the beginning\n\nTheater: 'Y' gives three chances to win";
  assert.equal(T.stripRelatedPostHeadlines(real), BODY);
});

test('text-quality checkTruncation judges what precedes a trailer and honours the kill switch (codex findings)', () => {
  const withTrailer = BODY + ' • At the Almeida, London, until 7 June';
  assert.equal(checkTruncation(withTrailer).isTruncated, false);
  const curly = BODY + ' “It works.”';
  assert.equal(checkTruncation(curly).isTruncated, false);
  process.env.TRAILER_FIXES_DISABLED = 'true';
  try {
    assert.equal(checkTruncation(curly).isTruncated, true);
  } finally {
    delete process.env.TRAILER_FIXES_DISABLED;
  }
});

test('kill switch TRAILER_FIXES_DISABLED also covers stripTrailingJunk, whose output is saved (reviewer blocker 2)', () => {
  const footer = BODY + ' Running Time: 2 hours At Theater Wit Performances are: Fridays at 8pm For more information or tickets For more Chicago theatre information and reviews, please visit Theatre in Chicago Facebook --> Share on:';
  assert.ok(!stripTrailingJunk(footer).includes('For more Chicago'));
  process.env.TRAILER_FIXES_DISABLED = 'true';
  try {
    assert.ok(stripTrailingJunk(footer).includes('For more Chicago'));
  } finally {
    delete process.env.TRAILER_FIXES_DISABLED;
  }
});

test('a review cut off mid-sentence before a listing stays truncated', () => {
  const cut = BODY.slice(0, -40) + ' • At the Almeida, London, until 7 June';
  assert.equal(tier(cut, 'guardian').contentTier, 'truncated');
});

test('Guardian "Explore more on these topics" footer is stripped', () => {
  const f = BODY + ' Explore more on these topics Theatre Musicals reviews Share Reuse this content';
  assert.equal(T.stripGuardianTopicsFooter(f), BODY);
  assert.equal(tier(f, 'guardian').contentTier, 'complete');
});

test('tier: Guardian listing now complete (was truncated before the fix)', () => {
  const r = tier(BODY + ' • At the Almeida, London, until 7 June', 'guardian');
  assert.equal(r.contentTier, 'complete');
});

test('curly closing quote after the full stop counts as a sentence end (Kylie Jenner case)', () => {
  const t = BODY + ' “Nobody gets to say it again without saying anything.” • At the Royal Court, London, until 27 July.';
  assert.equal(tier(t, 'guardian').contentTier, 'complete');
  assert.equal(tier(BODY + ' “It works.”', 'guardian').contentTier, 'complete');
});

const FW_BLOCK = ' Running Time: 2 hours, with one intermission At Theater Wit, 1229 W. Belmont Performances are: Fridays and Saturdays at 8pm, Sundays at 2pm Thru March 31st For more information or tickets Production photos by Brett Beiner For more Chicago theatre information and reviews, please visit Theatre in Chicago Facebook --> Share on:';

test('thefourthwalsh production block + footer stripped; short text left alone', () => {
  assert.equal(T.stripFourthWalshInfoBlock(BODY + FW_BLOCK), BODY);
  const short = 'A short note.' + FW_BLOCK;
  assert.equal(T.stripFourthWalshInfoBlock(short), short);
  assert.equal(tier(BODY + FW_BLOCK, 'thefourthwalsh').contentTier, 'complete');
});

const RELATED = '\n\nBooks - In "A Novel," falling apart is just the beginning\n\nFilm - A director returns home with a new picture';

test('one-minute-critic related-post headlines stripped only with 2+ headline paragraphs', () => {
  const para = BODY;
  assert.equal(T.stripRelatedPostHeadlines(para + RELATED), para);
  const one = para + '\n\nBooks - In "A Novel," falling apart is just the beginning';
  assert.equal(T.stripRelatedPostHeadlines(one), one);
  assert.equal(tier(para + RELATED, 'one-minute-critic').contentTier, 'complete');
});

test('outlet scoping: related headlines only go for one-minute-critic', () => {
  const t = BODY + RELATED;
  assert.equal(T.stripKnownTrailers(t, 'one-minute-critic'), BODY);
  assert.equal(T.stripKnownTrailers(t, 'nytimes'), t);
  assert.equal(T.stripKnownTrailers(t, undefined), t);
});

test('stripTrailingJunk: fourthwalsh footer any outlet, headlines by outletId', () => {
  assert.equal(stripTrailingJunk(BODY + FW_BLOCK), BODY);
  assert.equal(stripTrailingJunk(BODY + RELATED, 'one-minute-critic'), BODY);
  assert.equal(stripTrailingJunk(BODY + RELATED), BODY + RELATED);
});

test('text-quality checkTruncation ignores the UK listing trailer', () => {
  assert.ok(!checkTruncation(BODY + ' • At the Almeida, London, until 7 June').signals.includes('no-final-punctuation'));
  assert.ok(checkTruncation(BODY.slice(0, -40)).signals.includes('no-final-punctuation'));
});
