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

test('The Times: listing footer + promo line are a trailer; a cut-off review is not (BRO-7171 Stage 4)', () => {
  // real endings (times-uk / sunday-times files, 2026-11-09)
  const endings = [
    ' ★★★★☆ Ambassadors Theatre, London, to Aug 1, theambassadorstheatre.co.uk 110min',
    '★★★★☆120minTo October 12, stratfordeast.com\n\nFollow @timesculture to read the latest reviews',
    'Box office: 020 7565 5000, royalcourttheatre.com, to November 16\n\nSave \n \n\n \n \n\n \n Promoted Content',
    ' ★★☆☆☆ London Coliseum, to Dec 11, eno.org\n\nLove classical music and opera? Get access to exclusive interviews and join the conversation in our Facebook group',
    ' 50min Southwark Playhouse Elephant, London, to Dec 5, southwarkplayhouse.co.uk\n\nWhat have you enjoyed at the theatre recently? Let us know in the comments below',
    ' To December 17, royalcourttheatre.com\n\nFollow @timesculture on Twitter to read the latest reviews\n\nSave\n \n\n \n \n\n \n Promoted Content',
  ];
  for (const e of endings.slice(0, 4).concat(endings[5])) {
    assert.equal(T.stripTimesFooter(BODY + e), BODY, JSON.stringify(e));
    assert.equal(tier(BODY + e, 'times-uk').contentTier, 'complete', JSON.stringify(e));
    assert.equal(tier(BODY + e, 'sunday-times').contentTier, 'complete');
  }
  // only for the Times outlets
  assert.notEqual(tier(BODY + endings[1], 'guardian').contentTier, 'complete');
  // a review cut off mid-sentence keeps its footer and stays truncated
  const cut = `${BODY.slice(0, -1)} and the lead brings a snarl${endings[0]}`;
  assert.equal(T.stripTimesFooter(cut), cut);
  // a cut-off review with only a promo line: promo goes, still not a sentence end
  const cutPromo = `${BODY.slice(0, -1)} who brings a snarl\n\nFollow @timesculture to read the latest reviews`;
  assert.notEqual(tier(cutPromo, 'times-uk').contentTier, 'complete');
  // prose after a star is not a footer
  const prose = `${BODY} ★ The cast is superb. Everyone should go and see this show tonight.`;
  assert.equal(T.stripTimesFooter(prose), prose);
  // ship-check: the save path keeps the star rating (the scorer's band anchor);
  // the footer is stripped only for the tier classifier.
  for (const id of ['times-uk', 'sunday-times']) {
    assert.match(stripTrailingJunk(BODY + endings[0], id), /★★★★☆/, id);
    assert.equal(T.stripKnownTrailers(BODY + endings[0], id), BODY);
  }
});

test('The Telegraph: listing line + box-office promo are a trailer; a cut-off review is not (BRO-7171 Telegraph run)', () => {
  // real endings (telegraph / sunday-telegraph files, 2026-11-11)
  const endings = [
    '\n\nLyric Hammersmith, London W6 ( lyric.co.uk ) until October 3',
    '\n\nHarold Pinter Theatre, London SW1 (haroldpintertheatre.co.uk) until Jun 20',
    '\n\nUntil Jun 6. Tickets: 020 3989 5455; nationaltheatre.org.uk',
    '\n\nAt Royal Lyceum until Oct 18, then touring until Nov 7; book tickets',
    '\n\nWyndham’s, to Apr 13; www.quartermainesterms.com\n\nTelegraph Boxoffice Popular Shows»',
    ' Until Nov 7. Tickets: rsc.org.uk Book tickets via Tickets | Telegraph Media Group provided by London Theatre Direct',
    '\n\nBooking to Feb 12; www.matildathemusical.com\n\nThis review also appears in Seven magazine, free with The Sunday Telegraph',
    ' Until Oct 20. Purchase Strictly Ballroom tickets or call 0844 871 2118',
    '\n\nBooking until Oct 18, call 020 3989 5455',
  ];
  for (const e of endings) {
    assert.equal(T.stripTelegraphFooter(BODY + e), BODY, JSON.stringify(e));
    assert.equal(tier(BODY + e, 'telegraph').contentTier, 'complete', JSON.stringify(e));
    assert.equal(tier(BODY + e, 'sunday-telegraph').contentTier, 'complete');
  }
  // only for the Telegraph outlets
  assert.notEqual(tier(BODY + endings[2], 'guardian').contentTier, 'complete');
  // a review cut off mid-sentence keeps its footer and stays truncated
  const cut = `${BODY.slice(0, -1)} and the lead brings a snarl${endings[2]}`;
  assert.equal(T.stripTelegraphFooter(cut), cut);
  assert.equal(tier(cut, 'telegraph').contentTier, 'truncated');
  // a cut-off review with only a promo line: still not complete
  const cutPromo = `${BODY.slice(0, -1)} who brings\n\nTelegraph Boxoffice Popular Shows»`;
  assert.notEqual(tier(cutPromo, 'telegraph').contentTier, 'complete');
  // review prose that opens "At ..." and names a month is not a listing
  const prose = `${BODY} At the end the cast, who are booked until June, take a bow and`;
  assert.equal(T.stripTelegraphFooter(prose), prose);
  // reviewer findings: a month prefix inside a word is not a listing end, "Then, to"
  // is not a listing opener, and a dateless venue line is not the last sentence
  for (const tail of [
    ' At Hampstead until Oct 3, it is a production of remark',
    ' Then, to be fair, the revival until Oct 3 drew a summary',
    ' At Chichester, to May 9 the cast play to mayhem',
  ]) assert.equal(T.stripTelegraphFooter(BODY + tail), BODY + tail, tail);
  // second review: a cut-off fragment that starts with an opener word is not a listing
  const L = '\n\nUntil Jun 6. Tickets: 020 3989 5455';
  for (const frag of [
    ' It works. Tickets were hard to get and the',
    ' It works. Until the final scene, the',
    ' It works.\n\nBook-ending the evening, the director',
    ' It works. Sondheim, London and the',
    ' It was a slow start. Then, to Oct 18',
  ]) {
    const cut = BODY + frag + L;
    assert.notEqual(tier(cut, 'telegraph').contentTier, 'complete', frag);
  }
  // third review: prose that ends on a date, with no domain/phone/postcode, is not a listing
  for (const frag of [
    ' In 1987, to Oct 18', ' When it played Stratford, until May 3', ' If the first half, to May 4',
    ' At Christmas the run was extended until Jan 5', ' Until Oct 18, when the cast leaves in 2027',
    ' Tickets: the show was sold out by 2019',
    // fourth review
    ' At 86, McKellen is still playing eight shows a week until Oct 18, and those who cannot book tickets',
    " At Wyndham's, where it runs until Oct 18, there is still just about time to book tickets",
    ' At the Old Vic, until 18 October, the queue at the box office in London SE1',
  ]) {
    assert.equal(T.stripTelegraphFooter(BODY + frag), BODY + frag, frag);
  }
  const cutVenue =`${BODY.slice(0, -1)} and the lead brings a snarl\n\nNational Theatre, London SE1. Until Jun 6; nationaltheatre.org.uk`;
  assert.equal(T.stripTelegraphFooter(cutVenue), cutVenue);
  // classify-only: the saved text keeps the listing
  assert.match(stripTrailingJunk(BODY + endings[2], 'telegraph'), /Tickets: 020 3989 5455/);
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
