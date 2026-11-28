// Known page trailers after a review's last paragraph (zero-gap plan 1C).
// Fixtures are real corpus endings (shortened lead-in). Requires the real
// functions: trailer-signatures, content-quality via classifyTierWriteBack,
// text-cleaning and text-quality.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { createRequire as _cr7569 } from 'node:module';
import _t7569 from 'node:test';
import _a7569 from 'node:assert/strict';

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

test('The Stage: subscription promo, newsletter line, run listing and bio peel off in any order; a cut-off review stays truncated (BRO-7569)', () => {
  const promo = 'Invest in The Stage today with a subscription starting at just £7.99';
  const news = 'For all the latest reviews from The Stage, sign up to our weekly reviews newsletter here';
  const bio = "Dave is a playwright and critic. He was the winner of The Stage's Critic Search 2015";
  // real endings (giant-west-end-2025, cyrano-de-bergerac-west-end-2026, arlington-tron-regional-2025, jeezus-off-west-end-2026)
  for (const tail of [`\n\n${news}`, `  ${bio} ${promo}`, `\n\nGlasgow, then at Traverse Theatre , Edinburgh, November 6-8`, `\n\nDundee, then touring until March 29, 2025`, ` ${promo}`, `\n\nFor all the latest from the Edinburgh Fringe, sign up to The Stage’s Edinburgh newsletter`, `\n\n${news}\n\n${bio}`]) {
    assert.equal(T.stripStagePageTail(BODY + tail), BODY, tail);
    assert.equal(tier(BODY + tail, 'thestage').contentTier, 'complete', tail);
  }
  // only for The Stage
  assert.notEqual(tier(`${BODY}\n\n${news}`, 'guardian').contentTier, 'complete');
  // cut off mid-sentence in front of the trailer: stays truncated
  const cut = `${BODY.slice(0, -1)} and the lead\n\n${news}`;
  assert.equal(T.stripStagePageTail(cut), cut);
  assert.notEqual(tier(cut, 'thestage').contentTier, 'complete');
  // prose that merely mentions a newsletter is not stripped
  const prose = `${BODY}  Hamlet is a production that couldn't be more timely and its themes of love`;
  assert.equal(T.stripStagePageTail(prose), prose);
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
    // second wave (batch 4: live page == saved text, still read truncated)
    '\n\nBuy tickets to\n\nBetty Blue Eyes\n\nwith\n\nTelegraph Box Office',
    '\n\nBuy\n\nFrankenstein Tickets\n\nfrom\n\nTelegraph Tickets',
    "\n\nBuy 'When We Are Married' tickets\n\nfrom\n\nTelegraph Box Office",
    '\n\nHarold Pinter Theatre, to Apr 14\n\nThis review also appears in SEVEN magazine, free with the Sunday Telegraph\n\nFollow SEVEN on Twitter @TelegraphSeven',
    '\n\nTo March 6; www.nationaltheatre.org.uk\n\nThis review also appears in SEVEN magazine, free with the Sunday Telegraph\n\nFollow SEVEN on Twitter @TelegraphSeven',
    ' Book your tickets now to avoid disappointment at tickets.telegraph.co.uk or by calling: 0844 871 2118​',
    ' Until Jan 19. Tickets: 0844 871 2118; Telegraph Tickets',
    ' Tickets: 212.719.1300; http://www.roundabouttheatre.org/Shows-Events/Love-Love-Love.aspx',
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
  // second wave: a teaser cut mid-sentence followed by the split box-office
  // link or the Seven promo is still not complete
  for (const promo of [
    '\n\nBuy tickets to\n\nBlithe Spirit\n\nwith\n\nTelegraph Box Office',
    '\n\nThis review also appears in SEVEN magazine, free with the Sunday Telegraph\n\nFollow SEVEN on Twitter @TelegraphSeven',
  ]) {
    assert.notEqual(tier(`${BODY.slice(0, -1)} and the lead brings a${promo}`, 'telegraph').contentTier, 'complete', promo);
    // a last line that is prose, not a one-line listing, is not stripped either
    assert.notEqual(tier(`${BODY.slice(0, -1)}\n\nIn 1987, to Oct 18, the lead${promo}`, 'telegraph').contentTier, 'complete', promo);
  }
  // prose that merely mentions buying tickets is not the box-office link
  const buyCut = `${BODY}\n\nBuy tickets while you can, for the`;
  assert.notEqual(tier(buyCut, 'telegraph').contentTier, 'complete');
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

test('The Stage page tail: prose that looks like a bio or a ", then" line is never peeled (BRO-7569 review)', () => {
  const cases = [
    `${BODY} Lucy Prebble is a playwright at the height of her powers.`,
    `${BODY} It is a writer’s triumph and a night to remember.`,
    `${BODY.slice(0, -1)} and Caryl Churchill is a playwright who has always pushed`,
    `${BODY}\n\nNothing here works, then the second act collapses into farce and it never`,
  ];
  for (const c of cases) assert.equal(T.stripStagePageTail(c), c, c.slice(-60));
  // saved text keeps the old bio-only strip: the newsletter / listing are classify-only
  const news = 'For all the latest reviews from The Stage, sign up to our weekly reviews newsletter here';
  assert.equal(T.stripOutletTrailer(`${BODY}\n\n${news}`, 'thestage'), `${BODY}\n\n${news}`);
  assert.equal(T.stripOutletTrailer(`${BODY}\n\n${news}`, 'thestage', { forClassify: true }), BODY);
});
{
  const { classifyTrailers, stripKnownTrailers } = _cr7569(import.meta.url)('./trailer-signatures.js');
  void classifyTrailers;
  _t7569('BRO-7569 review: cut-off Stage tails are not stripped into a "complete" review', () => {
    const body = 'A long review sentence that ends properly. '.repeat(40);
    for (const tail of [
      '\n\nWatching it, then reading the 1960 script, I was struck by how the',
      '\n\nShakespeare was a playwright who understood that the 1590s audience wanted',
      '  Stoppard is a writer at the height of his powers, and this',
    ]) {
      const out = stripKnownTrailers(body + tail, 'thestage');
      _a7569.ok(String(out && out.text !== undefined ? out.text : out).endsWith(tail.trim()), 'kept: ' + tail.trim());
    }
  });
}

test('run-info / photo-credit tail is a trailer on any outlet; a cut-off review is not (BRO-7171 2026-11-16)', () => {
  // real ending shapes (broadwayworld + 37 other outlets' open TRUNCATED_OTHER gaps)
  const endings = [
    ' Roleplay runs at Soho Theatre (Dean Street) until 21 November Photo Credits: Mihaela Bodlovic',
    ' Stereophonic plays at The Duke of York’s Theatre until 11 October Photography Credit: Marc Brenner',
    ' Slaughterhouse-Five runs at Southwark Playhouse (Borough) until 4 July. Photography by Henry Hu',
    ' Fire Fire at the Arcolas Theatre until 3 October and then on tour Photo images: Mark Senior',
    "\n\nMy Son's a Queer (But What Can You Do?) plays at the Garrick Theatre until November 6",
    ' All photos by Evan Zimmerman for MurphyMade',
    ' For more ticket and show information, please click the ticket link button below. All photos are by Matthew Murphy and Evan Zimmerman',
    " DISNEY'S BEAUTY AND THE BEAST Running Now - March 15th Whitney Hall at Kentucky Performing Arts",
    '\n\nRetrograde plays at the Apollo Theatre until 14 June\n\nGet InfoBuy TixCastPhotosVideos\n\n Get Show Info\nInfoGet TicketsCastPhotosVideosPowered by\nVideos',
    '\n\nArcadia is at the Old Vic, London, until 21 March 2026',
    ' Dog Mom is at the Southwark Playhouse Borough until 7th November. Tickets are on sale from: https://southwarkplayhouse.co.uk/productions/dog-mom/',
    '\n\nShucked plays at the Fabulous Fox through February 23, 2025.\n\nPhoto credit: Matthew Murphy and Evan Zimmerman',
  ];
  for (const e of endings) {
    assert.equal(T.stripRunInfoTrailer(BODY + e), BODY, JSON.stringify(e));
    for (const outlet of ['broadwayworld', 'theartsdispatch', 'guardian']) {
      assert.equal(tier(BODY + e, outlet).contentTier, 'complete', `${outlet} ${JSON.stringify(e)}`);
    }
    // classify-only: the saved text keeps the run line and credit
    assert.equal(stripTrailingJunk(BODY + e, 'broadwayworld').trim(), (BODY + e).trim().replace(/\s+$/, ''), JSON.stringify(e));
  }
  // cut off mid-sentence before the trailer: stays truncated
  const cutBody = `${BODY.slice(0, -1)} and the lead brings a snarl`;
  for (const e of [endings[0], endings[4], endings[10]]) {
    assert.equal(T.stripRunInfoTrailer(cutBody + e), cutBody + e, JSON.stringify(e));
    assert.equal(tier(cutBody + e, 'broadwayworld').contentTier, 'truncated', JSON.stringify(e));
  }
  // prose that names a month after "until" but no venue is not a run line
  const prose = `${BODY} The cast stays in character until 5 May and`;
  assert.equal(T.stripRunInfoTrailer(prose), prose);
  // a mid-sentence cut that merely mentions photos is kept
  const photos = `${BODY} The photos on the wall of the set and`;
  assert.equal(T.stripRunInfoTrailer(photos), photos);
  // too little prose left after the strip: unchanged
  const tiny = 'A short note. Roleplay runs at Soho Theatre until 21 November Photo Credits: X';
  assert.equal(T.stripRunInfoTrailer(tiny), tiny);
});

test('run-info stripper: ship-check cut-off tails stay unstripped (BRO-7171 review)', () => {
  const lead = BODY.slice(0, 1200).replace(/\s+\S*$/, '') + ' and it works.';
  for (const tail of [
    ' Tickets are going to be scarce once word gets out about what Ms. Hall does in the second act, when she',
    " Tickets available at the box office won't last, and the producers would be wise to extend before the",
    ' For information on the original 1957 production, the program offers a detailed timeline that traces how the',
    ' Photos by Weegee line the walls of the set, and the lighting design makes them seem to',
    ' Images: a burning house, a lonely child, a',
    ' Hamilton plays at the Victoria Palace Theatre until 6 June, and Lin-Manuel Miranda',
    ' Next Fall runs at the Helen Hayes Theater through March 3, when Patrick Breen',
    ' In Oklahoma! (Revival) Jones plays at the Circle in the Square until May 5 Fischer',
  ]) {
    assert.equal(T.stripRunInfoTrailer(lead + tail), lead + tail, JSON.stringify(tail));
  }
  // still stripped: real shapes with a link / price / call to action / names only
  for (const tail of [
    ' Tickets start at $64. Photo Credit: Justin Barbin',
    ' Runs until 4th July, then at Theatre Royal Bath from 14th - 25th July Photo credit Manuel Harlan',
    ' We Will Rock You runs at New Village Arts through September 20th. For ticket and showtime information, go to https://newvillagearts.org/ Photo Credit: JEDZANT Photography',
  ]) {
    assert.notEqual(T.stripRunInfoTrailer(lead + tail), lead + tail, JSON.stringify(tail));
  }
});

test('run-info stripper: second ship-check cut-off tails stay unstripped (BRO-7171)', () => {
  const lead = BODY.slice(0, 1200).replace(/\s+\S*$/, '') + ' and it works.';
  for (const tail of [
    ' Tickets: $59-$199 at Telecharge. But the real question is whether',
    ' For tickets and information, visit the theatre. Then, in the second act, the whole thing begins to',
    ' For more information, see the website. Odom is magnificent as the man who',
    ' Tickets are going to be scarce, so visit',
    ' Tickets are on sale now at the box office, and frankly you should call',
    ' For information on the run, here is what Sondheim',
    ' Tickets are scarce here, and anyone expecting a conventional musical will',
    ' Running at the Booth through May 3 then the cast',
    ' Hamilton runs at the Victoria Palace Theatre until 6 June, then with',
    ' Photography by Marc Brenner and Johan Persson and The',
    ' Photos by Joan Marcus, Sara Krulwich and',
    ' Photos by Matthew Murphy and Evan Zimmerman are the only',
    ' Get InfoBuy Tix and then the second act collapses into a muddle of',
  ]) {
    assert.equal(T.stripRunInfoTrailer(lead + tail), lead + tail, JSON.stringify(tail));
  }
  // venue line left as the last "sentence" (Telegraph guard, reused)
  const cutVenue = `${BODY.slice(0, -1)} and the lead brings\n\nNational Theatre, London SE1. Tickets: 020 3989 5455; nationaltheatre.org.uk`;
  assert.equal(T.stripRunInfoTrailer(cutVenue), cutVenue);
  // isolated kill switch
  const real = BODY + ' Bull runs at the Park Theatre until 24 October Photo Credits: Becky Bailey';
  process.env.RUN_INFO_TRAILER_DISABLED = 'true';
  try { assert.equal(T.stripRunInfoTrailer(real), real); } finally { delete process.env.RUN_INFO_TRAILER_DISABLED; }
  assert.equal(T.stripRunInfoTrailer(real), BODY);
});

test('run-info stripper: whitespace runs stay fast', () => {
  const t0 = Date.now();
  T.stripRunInfoTrailer(' '.repeat(50000) + 'x');
  T.stripRunInfoTrailer('\n'.repeat(50000) + 'x');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
});

test('run-info stripper: price/link mid-sentence is not a ticket line end (BRO-7171 round 3)', () => {
  const lead = BODY.slice(0, 1200).replace(/\s+\S*$/, '') + ' and it works.';
  for (const tail of [
    ' Steep, though. Tickets are $349 in the orchestra and $89 gets',
    ' Steep. Tickets are $349 at Telecharge.com, which seems',
    ' Steep. Tickets are available on TodayTix.com, where rush',
    ' Thrilling. Tickets: $59.50 at Ticketmaster.com, though most',
  ]) {
    assert.equal(T.stripRunInfoTrailer(lead + tail), lead + tail, JSON.stringify(tail));
  }
  for (const tail of [
    ' Tickets: 020 3989 5455; nationaltheatre.org.uk',
    ' Tickets are on sale from: https://southwarkplayhouse.co.uk/productions/dog-mom/',
    ' For tickets, call 212-239-6200',
  ]) {
    assert.equal(T.stripRunInfoTrailer(lead + tail), lead, JSON.stringify(tail));
  }
});

// ---------------------------------------------------------------------------
// BRO-7942: furniture tail. Fixtures are the real endings of corpus files
// (gap-recovery TRUNCATED_OTHER / SHORT_UNVERIFIED rows) behind enough prose.
// ---------------------------------------------------------------------------
const FT_PROSE = 'The staging is confident and the second act lands every beat it reaches for, with an ensemble that never lets the pace slip. '.repeat(8) + 'This is a revival worth seeing.';
const FT = require('./trailer-signatures.js');
const stripped = (tail, outlet = 'unknown-outlet') => FT.stripKnownTrailers(`${FT_PROSE} ${tail}`, outlet);

test('furniture tail: real corpus endings are removed, prose stays', () => {
  const cases = [
    'It runs until 25 January 2026. Tickets: here. Review: Oliver Popa Photos: Mark Senior',
    'Runs until 28th November Photo credit: Anthony Leary-White',
    'Runs until 8th NovemberPhoto credit: Alex Brenner',
    'Photo credit Johan Persson',
    'Photo Credit: Adrian O. Walker Review by Rachel Weinberg',
    'Running time: 1hr 25mins. No intermission. Through July 23.',
    'Running time:',
    'Until October 24 KilnTheatre.com',
    'Until January 13 nationaltheatre.org.uk',
    'To 7 Aug, nationaltheatre.org.uk',
    'Until March 5, Wyndham\'s Theatre (0844 482 5120)',
    'Keep up with the latest news and reviews on our Time Out Theater Facebook page Jonah | Photograph: Joan Marcus',
    'Follow Time Out Theater on X: @TimeOutTheaterFollow Time Out Theater on Facebook: Time Out Theater The Beacon | Photograph: Courtesy Carol Rosegg',
    'To learn more about Robert Tanitch and his reviews, click here to go to his website',
    'For further information or to book visit the theatre\'s website here . Related Items featured review',
    'For more shows visit Theatre in Chicago',
    'CLICK HERE TO READ MORE ARTICLES BY AMY MUNICE.',
    '• Did you catch this show – or any other recently? Tell us about it using #gdnreview',
    'Δ document.getElementById( "ak_js_1" ).setAttribute( "value", ( new Date() ).getTime() );',
    "window.dataLayer = window.dataLayer || []; gtag('js', new Date());</p> <p> gtag('config', 'G-J2EENS4G51');",
    '@page WordSection1 {size:8.5in 11.0in; margin:1.0in 1.25in 1.0in 1.25in;',
  ];
  for (const tail of cases) {
    const out = stripped(tail);
    assert.equal(out, FT_PROSE, `not stripped: ${tail}`);
  }
});

test('furniture tail: Guardian bullet listing that ends on a dated year is a trailer', () => {
  assert.equal(stripped('• At Shoreditch town hall, London, until 13 November, then touring until 7 March 2027', 'guardian'), FT_PROSE);
});

test('furniture tail: a review cut off mid-sentence stays truncated (no strip)', () => {
  const cut = `${FT_PROSE.slice(0, -1)} and the lead is at the Garrick until 7 June`;
  assert.equal(FT.stripFurnitureTail(cut), cut, 'run date inside a cut sentence');
  const cut2 = `${FT_PROSE} Photos by Weegee line the walls of the set, and the`;
  assert.equal(FT.stripKnownTrailers(cut2, 'x'), cut2, 'a dangling sentence is not a credit');
  const cut3 = `${FT_PROSE.slice(0, -1)}, but the second act`;
  assert.equal(FT.stripKnownTrailers(`${cut3} Tickets: here`, 'x'), `${cut3} Tickets: here`, 'prose before the trailer must end a sentence');
});

test('furniture tail: a short text is never reduced below the prose floor, and the kill switch restores old behaviour', () => {
  const short = 'A good night out. Runs until 28th November Photo credit: Anthony Leary-White';
  assert.equal(FT.stripKnownTrailers(short, 'x'), short);
  process.env.FURNITURE_TAIL_DISABLED = 'true';
  try { assert.equal(stripped('Runs until 28th November Photo credit: Anthony Leary-White'), `${FT_PROSE} Runs until 28th November Photo credit: Anthony Leary-White`); } finally { delete process.env.FURNITURE_TAIL_DISABLED; }
});

test('furniture tail is classify-only: the save-path stripper leaves saved text alone', () => {
  const TC = require('./text-cleaning.js');
  const text = `${FT_PROSE} Runs until 28th November Photo credit: Anthony Leary-White`;
  assert.equal(TC.stripTrailingJunk(text, 'jonathan-baz'), text);
});

test('furniture tail: ship-check cases, a cut sentence that starts with a date or follows a <p> tag is not stripped', () => {
  for (const tail of ['Through May 3, Hamlet broods in a way that feels', 'Until 7 June, Rhys Ifans and Ruth Wilson play', '</p><p>The second act falls apart and the', 'Until March 5 and the whole thing sags under']) {
    const t = `${FT_PROSE} ${tail}`;
    assert.equal(FT.stripKnownTrailers(t, 'x'), t, tail);
  }
});

test('Independent / Standard CMS widget footers are stripped for the tier check (BRO-7943)', () => {
  const indy = BODY + ' To 7 December (0207 400 1257) More about Musicals Regent\'s Park Join our commenting forum Join thought-provoking conversations, follow other Independent readers and see their replies Comments';
  assert.ok(!/commenting forum/.test(T.stripCmsWidgetFooters(indy)));
  assert.equal(tier(indy, 'independent').contentTier, 'complete');
  const std = BODY + ' To 29 Nov, donmarwarehouse.com . MORE ABOUT The Maids Donmar Warehouse Solange Murder sisters Shopping Best Buys What I\'m buying from the 2025 Marks & Spencer x Bella Freud drop Best toy advent calendars for Christmas 2025';
  assert.ok(!/Shopping Best Buys/.test(T.stripCmsWidgetFooters(std)));
  assert.equal(tier(std, 'standard').contentTier, 'complete');
  // a review cut mid-sentence before the widget stays truncated
  const cut = BODY.slice(0, -40) + ' MORE ABOUT The Maids Shopping Best Buys Best toy advent calendars';
  assert.equal(tier(cut, 'standard').contentTier, 'truncated');
  // no widget: unchanged
  assert.equal(T.stripCmsWidgetFooters(BODY), BODY);
  // review fixes: a cut sentence opening with the widget phrase is not a footer
  const fake = BODY + ' Join our commenting forum members were asked to rate the production and many of them said that';
  assert.equal(T.stripCmsWidgetFooters(fake), fake);
  // a short excerpt plus widget words is not stripped (word count would be manufactured)
  const shortStd = BODY.slice(0, 700) + ' MORE ABOUT The Maids Shopping Best Buys Best toy advent calendars for Christmas 2025';
  assert.equal(T.stripCmsWidgetFooters(shortStd), shortStd);
  // the Standard widget split across lines is still the widget
  const nl = BODY + ' To 29 Nov, donmarwarehouse.com .\nMORE ABOUT The Maids Donmar Warehouse\nShopping Best Buys\nBest toy advent calendars for Christmas 2025';
  assert.ok(!/Shopping/.test(T.stripCmsWidgetFooters(nl)));
  // review fixes: an earlier "More about ..." sentence in the review is kept
  const early = BODY + ' More about that later. The cast is superb throughout. To 7 December More about Musicals Join our commenting forum Join thought-provoking conversations, follow other Independent readers and see their replies Comments';
  assert.ok(T.stripCmsWidgetFooters(early).endsWith('To 7 December'));
  // a long whitespace run stays fast (was cubic)
  const ws = BODY + ' '.repeat(20000) + 'x';
  const t0 = Date.now(); T.stripCmsWidgetFooters(ws); assert.ok(Date.now() - t0 < 200, 'whitespace run must stay fast');
});

test('CMS footer review fix: a punctuated topic tag never makes a cut review complete (BRO-7943)', () => {
  const W = ' Join our commenting forum Join thought-provoking conversations, follow other Independent readers and see their replies Comments';
  for (const tag of ['Oklahoma!', 'Hello, Dolly!', 'Mamma Mia!', 'Mrs. Doubtfire', 'Musicals']) {
    assert.equal(tier(BODY.slice(0, -40) + ' More about ' + tag + W, 'independent').contentTier, 'truncated', tag);
    assert.equal(tier(BODY + ' More about ' + tag + W, 'independent').contentTier, 'complete', tag);
  }
  // a cut sentence that itself opens "More about" stays in and stays truncated
  const cutMore = BODY + ' More about the supporting cast, whose performances never quite More about Musicals' + W;
  assert.ok(T.stripCmsWidgetFooters(cutMore).endsWith('never quite'));
  assert.equal(tier(cutMore, 'independent').contentTier, 'truncated');
});

test('CMS footer: Standard widget with a gallery caption and no MORE ABOUT block (72 corpus files, BRO-7943)', () => {
  const W = " November's best theatre 1 / 10 Shopping Best Buys Best heat-protectant leave-ins for fine hair The nicest lunchboxes for your return to the office";
  assert.equal(tier(BODY + ' Until January 4 ( 08544 871 7623, thepiccadillytheatre.com )' + W, 'standard').contentTier, 'complete');
  assert.equal(tier(BODY.slice(0, -40) + W, 'standard').contentTier, 'truncated');
  for (const tag of ['Oklahoma!', 'Hello, Dolly!']) {
    assert.equal(tier(BODY.slice(0, -40) + ' MORE ABOUT ' + tag + ' Shopping Best Buys Best toy advent calendars', 'standard').contentTier, 'truncated', tag);
  }
});

test('CMS footer review fixes: the caption strip never eats a cut sentence; long whitespace before a widget stays fast (BRO-7943)', () => {
  const W = " November's best theatre 1 / 10 Shopping Best Buys Best heat-protectant leave-ins for fine hair";
  assert.equal(tier(BODY + ' But the lead never quite' + W, 'standard').contentTier, 'truncated');
  assert.equal(tier(BODY.slice(0, -40) + ' Hello, Dolly! 1 / 10 Shopping Best Buys offers', 'standard').contentTier, 'truncated');
  // a long tag block ending on a punctuated tag is still removed
  assert.equal(tier(BODY.slice(0, -40) + ' MORE ABOUT ' + 'Theatre '.repeat(60) + 'Hello, Dolly! Shopping Best Buys offers', 'standard').contentTier, 'truncated');
  for (const tail of [' '.repeat(10000) + 'x Shopping Best Buys suffix', ' '.repeat(10000) + 'x Join our commenting forum Join thought-provoking conversations, follow other Independent readers and see their replies']) {
    const t0 = Date.now(); T.stripCmsWidgetFooters(BODY + tail); assert.ok(Date.now() - t0 < 200, `slow: ${Date.now() - t0}ms`);
  }
});

test('CMS footer: Standard "in pictures" caption and GO London ticket line (real corpus tails, BRO-7943)', () => {
  const tails = [
    ' Until Jan 4 (020 7927 0900, whitechristmasthemusical.co.uk ) Best pantos to see this Christmas in London - in pictures 1 / 7 Shopping Best Buys Best mirrors to make a statement',
    ' Submit to it. Until September 8 Buy tickets for Joseph with GO London Latest theatre reviews 1 / 50 Shopping Best Buys Best mirrors to make a statement',
  ];
  for (const t of tails) assert.equal(tier(BODY + t, 'standard').contentTier, 'complete', t.slice(0, 40));
  assert.equal(tier(BODY.slice(0, -40) + ' Buy tickets for Joseph with GO London Latest theatre reviews 1 / 50 Shopping Best Buys x', 'standard').contentTier, 'truncated');
});

// BRO-8084: a review tiered "truncated" only because a page trailer has no full stop is read through
// trailerSafeBody(), never raw; the predicate is the single gate for it. (Pure: no review data needed.)
test('BRO-8084: isTrailerOnlyTruncation / trailerSafeBody contract', () => {
  const { TRAILER_ONLY_SIGNALS, isTrailerOnlyTruncation, trailerSafeBody } = T;
  assert.deepEqual([...TRAILER_ONLY_SIGNALS].sort(), ['has_footer_junk', 'no_ending_punctuation']);
  const base = { textStatus: 'truncated', truncationSignals: ['no_ending_punctuation'] };
  assert.equal(isTrailerOnlyTruncation(base), true);
  assert.equal(isTrailerOnlyTruncation(null), false);
  assert.equal(isTrailerOnlyTruncation({ ...base, textStatus: 'complete' }), false);
  assert.equal(isTrailerOnlyTruncation({ ...base, truncationSignals: [] }), false, 'no signal = unknown cause');
  assert.equal(isTrailerOnlyTruncation({ ...base, truncationSignals: ['no_ending_punctuation', 'paywall_or_login_prompt'] }), false);
  for (const contentTier of ['stub', 'excerpt', 'invalid']) assert.equal(isTrailerOnlyTruncation({ ...base, contentTier }), false, contentTier);
  assert.equal(isTrailerOnlyTruncation({ ...base, contentTier: 'truncated' }), true);
  assert.equal(isTrailerOnlyTruncation({ ...base, contentTierReason: 'Short text (120 words)' }), false);
  assert.equal(isTrailerOnlyTruncation({ ...base, contentTierReason: 'Paywall truncation: hard paywall' }), false);
  const prev = process.env.TRAILER_FIXES_DISABLED; process.env.TRAILER_FIXES_DISABLED = 'true';
  try { assert.equal(isTrailerOnlyTruncation(base), false, 'kill switch'); }
  finally { if (prev === undefined) delete process.env.TRAILER_FIXES_DISABLED; else process.env.TRAILER_FIXES_DISABLED = prev; }

  const run = '★★★★ 4 stars Some Show runz at The Theatre, 1 Main Street until 31 January 2027';
  const safe = trailerSafeBody(`${BODY} Delightfully deranged ${run}`, 'the-recs');
  assert.ok(safe.length > 200 && /[.!?]$/.test(safe), 'cuts back to a sentence end');
  assert.doesNotMatch(safe, /runz at|★|4 stars|until 31 January/);
  assert.equal(trailerSafeBody('short body.', 'the-recs'), '');
  // a known classify-only trailer longer than the 300-char window comes off before the window is applied
  const guardian = `${BODY} • At the Almeida, London, until 7 June • This article was amended on 22 December 2022 to correct the spelling of a name in the cast list that appeared in an earlier version of this review`;
  assert.doesNotMatch(trailerSafeBody(guardian, 'guardian'), /Almeida|amended/);
});

// BRO-8084 (Gemini): detectTruncationSignals scans paywall prompts only in the first 70% of a 1500+ char body, so a
// prompt that ends a long preview leaves trailer-only signals. isTrailerOnlyTruncation must still refuse it.
test('BRO-8084: isTrailerOnlyTruncation refuses a body that ends in a paywall prompt', () => {
  const body = 'The cast of six plays every role between them and the staging moves without a break from scene to scene. '.repeat(20);
  const base = { textStatus: 'truncated', contentTier: 'truncated', truncationSignals: ['no_ending_punctuation'] };
  assert.equal(T.isTrailerOnlyTruncation({ ...base, fullText: body + 'Delightfully deranged ★★★★ 4 stars Some Show runs until 31 January 2027' }), true);
  for (const tail of ['Subscribe to continue reading', 'Sign in to read the rest', 'Continue reading', 'for subscribers only. Log in to continue']) {
    assert.equal(T.isTrailerOnlyTruncation({ ...base, fullText: body + tail }), false, tail);
  }
});

// BRO-8092 cousins of BRO-7943 (real corpus tails, 15 stored-truncated files flip to complete, 0 lost):
// older Independent pages carry the comments widget without its "Join our commenting forum" heading,
// and 2015-16 Standard pages end on "Buy tickets ... with Going Out Tickets" + the Going Out social line.
test('CMS footer cousins: headless Independent widget, Standard Going Out lines (BRO-8092)', () => {
  const indy = ' It would be a shame if this fine production didn’t come home to London. Join thought-provoking conversations, follow other Independent readers and see their replies';
  assert.equal(tier(BODY + indy, 'independent').contentTier, 'complete');
  assert.equal(tier(BODY.slice(0, -40) + ' Join thought-provoking conversations, follow other Independent readers and see their replies', 'independent').contentTier, 'truncated');
  const std = [
    ' Until April 2, Arts Theatre (020 7836 8463, artstheatrewestend.co.uk ) What to see at the theatre – in pictures 1 / 10 Follow Going Out on Facebook and on Twitter @ESgoingout MORE ABOUT Theatre reviews Shopping Best Buys Best mirrors to make a statement',
    ' Until April 30, Dominion Theatre (0845 200 7982) Buy tickets for War of the Worlds with Going Out Tickets Follow Going Out on Facebook and on Twitter @ESgoingout Shopping Best Buys Best mirrors',
    ' Until March 12 (020 7452 3000) Buy tickets for People, Places and Things with Going Out Tickets Latest theatre reviews 1 / 50 Follow Going Out on Facebook and on Twitter @ESgoingout Shopping Best Buys Best mirrors',
  ];
  for (const t of std) assert.equal(tier(BODY + t, 'standard').contentTier, 'complete', t.slice(0, 60));
  // a review cut mid-sentence in front of the Going Out lines stays truncated
  assert.equal(tier(BODY.slice(0, -40) + ' Buy tickets for Painkiller with Going Out Tickets Follow Going Out on Facebook and on Twitter @ESgoingout Shopping Best Buys x', 'standard').contentTier, 'truncated');
});

// ---------------------------------------------------------------------------
// BRO-8012: literal pre-filter. Each pre-filtered furniture regex names the
// literals it cannot match without; furnitureMatch skips the regex (a full-text
// scan) when none is present. A wrong literal would silently stop a strip, so
// every entry is checked against a real ending that the regex matches.
// ---------------------------------------------------------------------------
const PF = T._furniture;
// one real ending per pre-filtered regex, in the order of PF.filtered
const PF_SAMPLES = [
  'Δ document.getElementById( "ak_js_1" ).setAttribute( "value", 1 );',
  "window.dataLayer = window.dataLayer || []; gtag('js', new Date());",
  '@page WordSection1 {size:8.5in 11.0in;',
  '/* Style */ mso-style-name:"Table Normal"; mso-padding-alt:0in;',
  'css: { color: red; }',
  'Keep up with the latest news and reviews on our Time Out Theater Facebook page',
  'Editor\'s Note: Click here to read more Picture this Post stories by Jane Doe.',
  'CLICK HERE TO READ MORE ARTICLES BY AMY MUNICE.',
  'For more shows visit Theatre in Chicago',
  '| Image: Joan Marcus',
  'To learn more about Robert Tanitch and his reviews, click here to go to his website',
  "For further information or to book visit the theatre's website here .",
  'Watch the trailer here:',
  'Tags: musical, revival',
  '• Did you catch this show – or any other recently? Tell us about it',
  'Running time:',
  'Tickets: here.',
  'Running time: 1hr 25mins. No intermission. Through July 23.',
  'Public Theater (Off Broadway). By Jane Doe. Directed by John Roe. Running time: 90mins.',
];
// break every occurrence of a literal (case-insensitively for ci) without touching the rest
const breakLiteral = (s, lit) => s.replace(new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => m[0] + '\u0000' + m.slice(1));

test('BRO-8012 prefilter: every entry is well formed for its regex flags', () => {
  assert.equal(PF.filtered.length, PF_SAMPLES.length, 'add a sample for each new pre-filtered regex');
  for (const e of PF.filtered) {
    const lits = e.cs || e.ci;
    assert.ok(Array.isArray(lits) && lits.length > 0, `no literals: ${e.re}`);
    assert.ok(!(e.cs && e.ci), `both cs and ci: ${e.re}`);
    if (e.ci) {
      assert.ok(e.re.flags.includes('i'), `ci literal on a case-sensitive regex: ${e.re}`);
      for (const l of e.ci) assert.equal(l, l.toLowerCase(), `ci literal not lower-case: ${l}`);
    } else {
      assert.ok(!e.re.flags.includes('i'), `cs literal on an /i regex: ${e.re}`);
    }
  }
});

test('BRO-8012 prefilter: each regex matches its sample, and stops matching once its literals are gone', () => {
  PF.filtered.forEach((e, i) => {
    const sample = `${FT_PROSE} ${PF_SAMPLES[i]}`;
    assert.ok(e.re.test(sample), `sample does not match ${e.re}: ${PF_SAMPLES[i]}`);
    let broken = sample;
    for (const l of e.cs || e.ci) broken = breakLiteral(broken, l);
    assert.ok(!e.re.test(broken), `regex still matches without its literals, so they are not required: ${e.re}`);
  });
});

// the other branch of each alternation, so a literal only one branch carries fails
const PF_BRANCH_SAMPLES = [
  'Follow Time Out Theater on X: @TimeOutTheater',
  '· What have you been to see lately? Tell us about it',
  'WATCH THE VIDEO HERE',
  'TICKETS: https://example.com/tix',
];

test('BRO-8012 prefilter: furnitureMatch still finds every sample (pre-filter lets every match through)', () => {
  for (const tail of [...PF_SAMPLES, ...PF_BRANCH_SAMPLES]) {
    assert.notEqual(PF.furnitureMatch(`${FT_PROSE} ${tail}`), null, `not matched: ${tail}`);
  }
  for (const tail of PF_SAMPLES.slice(0, 16)) {
    assert.notEqual(FT.stripKnownTrailers(`${FT_PROSE} ${tail}`, 'unknown-outlet').length, `${FT_PROSE} ${tail}`.length, `not stripped: ${tail}`);
  }
});

test('BRO-8012 prefilter: plain prose runs none of the pre-filtered regexes (rebuild hot path)', () => {
  const prose = FT_PROSE.repeat(40);
  const filtered = new Set(PF.filtered.map((e) => e.re));
  const origExec = RegExp.prototype.exec;
  let scans = 0;
  RegExp.prototype.exec = function (s) { if (filtered.has(this)) scans++; return origExec.call(this, s); };
  try {
    assert.equal(PF.furnitureMatch(prose), null);
  } finally {
    RegExp.prototype.exec = origExec;
  }
  assert.equal(scans, 0, `${scans} pre-filtered regexes scanned prose that holds none of their literals`);
});

test('BRO-8012 foldCase: folds the characters JS /i treats as ASCII letters', () => {
  assert.equal(PF.foldCase('Webſite HERE Kelvin dırect'), 'website here kelvin direct');
  assert.ok(/website here/i.test('WEBSITE HERE') && PF.foldCase('WEBSITE HERE').includes('website here'));
});

// BRO-8084: PAYWALL_PROMPT_TAIL_RE is a copy of content-quality's severe paywall list (a require would pull file-writing
// modules into read-only scripts). Every severe pattern must be matched by it, so the copy cannot drift.
test('BRO-8084: PAYWALL_PROMPT_TAIL_RE covers every TRUNCATION_SIGNALS.severe pattern', () => {
  const { TRUNCATION_SIGNALS } = require('./content-quality.js');
  const samples = ['subscribe to continue', 'subscribe to read', 'subscribe to access', 'sign in to continue', 'sign in to read', 'sign in to access',
    'log in to continue', 'log in to read', 'members only', 'member only', 'read more...', 'read more', 'continue reading', 'click here to read',
    'full article available', 'full story requires'];
  assert.equal(TRUNCATION_SIGNALS.severe.length, 8, 'a severe pattern was added or removed: update PAYWALL_PROMPT_TAIL_RE and these samples');
  for (const re of TRUNCATION_SIGNALS.severe) {
    const hit = samples.filter((x) => re.test(x));
    assert.ok(hit.length > 0, `no sample exercises ${re}`);
    for (const x of hit) assert.ok(T.PAYWALL_PROMPT_TAIL_RE.test(x), `PAYWALL_PROMPT_TAIL_RE misses "${x}" that ${re} matches`);
  }
});

test('Standard 2015-16 Going Out tail is stripped without a Shopping footer; ticket titles may hold a full stop (BRO-8092 review)', () => {
  const { stripCmsWidgetFooters } = createRequire(import.meta.url)('./trailer-signatures.js');
  const body = 'The production is handsome and the cast commit fully to every scene of this long evening. '.repeat(20).trim();
  // real shape: the-libertine-west-end-2016/standard--henry-hitchings.json
  const lib = `${body} Until Dec 3, Theatre Royal Haymarket Buy tickets for The Libertine with Evening Standard Tickets Follow Going Out on Facebook and on Twitter @ESgoingout MORE ABOUT Arts Dominic Cooper`;
  assert.equal(stripCmsWidgetFooters(lib), `${body} Until Dec 3, Theatre Royal Haymarket`);
  // real shape: _pending/peter-pan-off-west-end-2026/standard--fiona-mountford.json
  const pp = `${body} In rep until Feb 4, National Theatre Buy tickets for Peter Pan with Evening Standard Tickets Visit standard.co.uk/theatre for the latest news and reviews from London’s theatre scene. Follow Going Out on Facebook and on Twitter @ESgoingout`;
  assert.equal(stripCmsWidgetFooters(pp), `${body} In rep until Feb 4, National Theatre`);
  const wl = `${body} Until April 30 Buy tickets for wonder.land with Going Out Tickets Follow Going Out on Facebook and on Twitter @ESgoingout`;
  assert.equal(stripCmsWidgetFooters(wl), `${body} Until April 30`);
  // a short body never loses its tail (widget words near the top are not a footer)
  const short = 'A brief note. Follow Going Out on Facebook and on Twitter @ESgoingout';
  assert.equal(stripCmsWidgetFooters(short), short);
});

test('BRO-8098: UK date and venue listings only strip after complete substantial prose', () => {
  for (const tail of ['Until Dec 3, Theatre Royal Haymarket', 'In rep until Feb 4, National Theatre', 'Until September 17, Theatre Royal Haymarket']) {
    assert.equal(T.stripKnownTrailers(`${BODY} ${tail}`, 'standard'), BODY);
    assert.equal(tier(`${BODY} ${tail}`, 'standard').contentTier, 'complete');
    const cut = `${BODY} The production leaves us with ${tail}`;
    assert.equal(T.stripKnownTrailers(cut, 'standard'), cut);
    assert.equal(T.stripKnownTrailers(`A brief review. ${tail}`, 'standard'), `A brief review. ${tail}`);
  }
  for (const tail of ['Until Dec 3, the actors continue to', 'Until Dec 3, Theatre Royal and']) {
    assert.equal(T.stripKnownTrailers(`${BODY} ${tail}`, 'guardian'), `${BODY} ${tail}`);
  }
});

test('BRO-8098: Standard news ticker is classify-only and requires a completed body', () => {
  const ticker = 'Why Man City fans have brought inflatable bananas to Anfield for Liverpool clash Why Man City fans have brought inflatable bananas to Anfield London council unanimously votes for motion to block resources in immigration raids Liverpool vs Man City LIVE: Premier League latest score Angry Liverpool fans mock Man City over guilty verdict at hostile Anfield Liverpool fans mock Man City over guilty verdict at hostile Anfield';
  assert.equal(T.stripKnownTrailers(`${BODY} ${ticker}`, 'standard'), BODY);
  assert.equal(tier(`${BODY} ${ticker}`, 'standard').contentTier, 'complete');
  assert.equal(T.stripKnownTrailers(`${BODY} ${ticker}`, 'guardian'), `${BODY} ${ticker}`);
  const cut = `${BODY} The acting is ${ticker}`;
  assert.equal(T.stripKnownTrailers(cut, 'standard'), cut);
  assert.equal(T.stripKnownTrailers(`Short. ${ticker}`, 'standard'), `Short. ${ticker}`);
  assert.equal(stripTrailingJunk(`${BODY} ${ticker}`, 'standard'), `${BODY} ${ticker}`);
});
