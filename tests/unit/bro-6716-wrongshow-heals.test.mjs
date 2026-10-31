// BRO-6716: legacy wrongShow flags that dropped real reviews, and the cookie
// banner that hid one. Requires the real guards (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isMisFamilyCvPromotedWrongShow, isStaleGenericHomepageWrongShow } = require('../../scripts/lib/review-guards.js');
const { isGarbageContent, stripLeadingCookieConsentBlock } = require('../../scripts/lib/content-quality.js');

const cvPreview = { isValid: false, wrongArticle: true, wrongProduction: false, isFilmTv: false, confidence: 'high', verifiedAt: '2026-04-15T00:00:00Z' };
const classB = (over = {}) => ({ wrongShow: true, wrongShowReason: 'CV-promoted: The scraped content is a preview/feature article', contentVerification: { ...cvPreview }, ...over });

test('B: CV not-a-review verdict filed as wrongShow is healed', () => {
  assert.equal(isMisFamilyCvPromotedWrongShow(classB()), true);
  // a person's production clear agrees with the heal (titanique-2026 shape)
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ humanReviewedWrongProduction: false })), true);
});

test('B: real wrong-show signals keep the flag', () => {
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ contentVerification: { ...cvPreview, wrongProduction: true } })), false, 'wrongShow family');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB(), { cvIsStale: true }), false, 'stale CV');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB(), { urlFiledUnderOtherShow: true }), false, 'URL under another show');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ wrongShowNote: 'checked by hand' })), false, 'human note');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ humanReviewedWrongShow: true })), false, 'human reviewed');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ wrongShowReason: 'CV-promoted (film/TV): movie' })), false, 'film/TV');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ wrongShowReason: 'LLM classifier: different show' })), false, 'other writer');
  assert.equal(isMisFamilyCvPromotedWrongShow(classB({ wrongShow: false })), false);
});

const show = { id: 'charlie-and-the-chocolate-factory-2017', title: 'Charlie and the Chocolate Factory' };
const reviewText = 'Charlie and the Chocolate Factory arrives on Broadway at the Lunt-Fontanne. '.repeat(10);
const classC = (url, over = {}) => ({ wrongShow: true, wrongShowReason: 'Generic homepage URL, not a review-specific link', url, ...over });

test('C: article URL with text naming the show is healed', () => {
  assert.equal(isStaleGenericHomepageWrongShow(classC('http://www.lightingandsoundamerica.com/news/story.asp?ID=R239KN', { fullText: reviewText }), show), true);
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://www.wolfentertainmentguide.com/viewpage.aspx?cat=theater&record=6671', { showScoreExcerpt: 'A sweet confection that never quite rises, with a second act that finally delivers the goods.' }), show), true);
});

test('C: homepage, search, preview and unproven files keep the flag', () => {
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://www.royberko.info/', { fullText: reviewText }), show), false, 'root homepage');
  assert.equal(isStaleGenericHomepageWrongShow(classC('http://thebroadwayblog.com/?s=charlie+and+the', { fullText: reviewText }), show), false, 'search page');
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://thebroadwayblog.com/x/?p=19049&preview=true', { fullText: reviewText }), show), false, 'draft preview');
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://example.com/2017/04/some-review', { fullText: 'A different musical entirely. '.repeat(30) }), show), false, 'text never names the show');
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://example.com/2017/04/some-review'), show), false, 'no text, no excerpt');
  assert.equal(isStaleGenericHomepageWrongShow(classC('https://example.com/2017/04/some-review', { fullText: reviewText }), show, { urlFiledUnderOtherShow: true }), false, 'URL under another show');
});

const banner = [
  'We use cookies to enhance your browsing experience, serve personalized ads or content, and analyze our traffic. By clicking "Accept All", you consent to our use of cookies.',
  'Necessary cookies are required to enable the basic features of this site.',
  'Advertisement cookies are used to provide visitors with customized advertisements.',
].join('\n\n');
const article = 'The musical opens at the St. James Theatre with a cast and a director who know exactly what this show is. The performance, the score and the staging all land. '.repeat(12);

test('cookie banner ahead of a real review is stripped, not garbage', () => {
  assert.equal(stripLeadingCookieConsentBlock(`${banner}\n\n${article}`).startsWith('The musical opens'), true);
  assert.equal(isGarbageContent(`${banner}\n\n${article}`).isGarbage, false);
});

test('a cookie banner with nothing real behind it stays garbage', () => {
  assert.equal(isGarbageContent(`${banner}\n\nShare this page.`).isGarbage, true);
  assert.equal(stripLeadingCookieConsentBlock(article), article);
});

const { isServerErrorPageHtml } = require('../../scripts/lib/gap-reference-sources.js');

test('a server error page served as a round-up is recognised (class A)', () => {
  const phusion = `<html><head><title>We're sorry, but something went wrong (500)</title></head><body>
    <h1>Web application could not be started by the Phusion Passenger(R) application server.</h1>
    <a href="https://www.phusionpassenger.com/library/admin/log_file/">log file</a></body></html>`;
  assert.equal(isServerErrorPageHtml(phusion), true);
  assert.equal(isServerErrorPageHtml('<title>502 Bad Gateway</title><center>nginx</center>'), true);
  const roundup = '<title>Teeth n Smiles reviews round-up</title><p>The critics on Teeth n Smiles at the Duke of York\'s.</p><a href="https://www.theguardian.com/stage/2026/mar/26/teeth-n-smiles-review">Guardian</a>';
  assert.equal(isServerErrorPageHtml(roundup), false);
  assert.equal(isServerErrorPageHtml(''), false);
});

// Class H: a copy of a live review is not a gap (BRO-6716).
const fmb = require('../../scripts/lib/flagged-miss-basis.js');
test('class H: syndicated reprint whose primary is live is not re-verified', () => {
  const live = fmb.liveKeysFromReviews([{ outletId: 'chicagotribune', criticName: 'Chris Jones' }]);
  const reprint = { outletId: 'nydailynews', criticName: 'Chris Jones', isSyndicatedDuplicate: true };
  const orig = () => [{ outletId: 'chicagotribune', criticName: 'Chris Jones' }];
  assert.equal(fmb.isCopyOfLiveReview([reprint], ['knownSyndicationSecondary'], live, orig), true);
  assert.equal(fmb.isCopyOfLiveReview([reprint], ['isSyndicatedDuplicate'], live, orig), true);
  const m = { exclusion: 'automatedExcluded', copyOfLiveReview: true, url: 'https://x.test/a' };
  assert.equal(fmb.shouldReverify(m), false);
});
test('class H: duplicateOf copy counts live via its own slot or its target', () => {
  const live = fmb.liveKeysFromReviews([{ outletId: 'independent', criticName: 'Alice Saville' }, { outletId: 'daily-mail', criticName: 'Patrick Marmion' }]);
  assert.equal(fmb.isCopyOfLiveReview([{ outletId: 'independent', criticName: 'Alice Saville', duplicateOf: 'x.json' }], ['duplicateOf'], live), true);
  assert.equal(fmb.isCopyOfLiveReview([{ outletId: 'daily-mail', criticName: 'Unknown' }], ['duplicateOf'], live,
    () => [{ outletId: 'daily-mail', criticName: 'Patrick Marmion' }]), true);
});
test('class H: not a copy, or original not live, stays a miss', () => {
  const live = fmb.liveKeysFromReviews([{ outletId: 'independent', criticName: 'Alice Saville' }]);
  // wrongShow is not a copy basis: never hidden even when the critic slot is live
  assert.equal(fmb.isCopyOfLiveReview([{ outletId: 'independent', criticName: 'Alice Saville' }], ['wrongShow'], live), false);
  // copy basis but nothing live for it
  assert.equal(fmb.isCopyOfLiveReview([{ outletId: 'standard', criticName: 'Nick Curtis' }], ['duplicateOf'], live), false);
  // unknown critic never matches
  assert.equal(fmb.isCopyOfLiveReview([{ outletId: 'independent', criticName: 'Unknown' }], ['duplicateOf'], fmb.liveKeysFromReviews([{ outletId: 'independent', criticName: 'Unknown' }])), false);
  assert.equal(fmb.shouldReverify({ exclusion: 'automatedExcluded', url: 'https://x.test/a' }), true);
});

// Class D: dates the ingest could not read (BRO-6716).
const { extractPublishDate } = require('../../scripts/lib/article-extractor.js');
const { resolveIngestPublishDate, listingOpeningDate } = require('../../scripts/lib/ingest-publish-date.js');
test('class D: WordPress single post reads its own article <time>, not a sidebar card', () => {
  const html = `<html><body class="post-template single postid-28150"><div class="side"><time class="entry-date published" datetime="2026-10-29T09:00:00-07:00">x</time></div>
<article id="post-28150" class="post-28150 post"><time class="entry-date published" datetime="2025-12-04T11:00:00-08:00">12/04/2025</time><p>body</p></article>
<article id="post-30049"><time class="entry-date published" datetime="2026-10-27T09:00:00-07:00">x</time></article></body></html>`;
  assert.equal(extractPublishDate(html, 'https://crookedmarquee.com/x/'), '2025-12-04');
  // no postid on <body>: no guess from the many sidebar <time>s
  assert.equal(extractPublishDate(html.replace('postid-28150', ''), 'https://crookedmarquee.com/x/'), null);
});
test('class D: Blogger date-header is read only when the page has exactly one', () => {
  const one = `<div><h2 class='date-header'><span>Wednesday, April 22, 2026</span></h2><div class="post">x</div></div>`;
  assert.equal(extractPublishDate(one, 'https://www.interestedbystander.com/2026/04/x.html'), '2026-04-22');
  const two = one + `<h2 class='date-header'><span>Monday, April 20, 2026</span></h2>`;
  assert.equal(extractPublishDate(two, 'https://www.interestedbystander.com/2026/04/'), null);
});
test('class D: listing run block dates the review only when it names THIS opening', () => {
  const html = 'Cititour.com Review ... <b>Open/Close Dates</b><br>Opening 4/12/2026<br>Closing 9/20/2026';
  assert.equal(listingOpeningDate(html), '2026-04-12');
  const text = 'x'.repeat(50);
  const ok = resolveIngestPublishDate({ html, url: 'https://cititour.com/NYC_Broadway/Titanique/1369', text, showOpeningDate: '2026-04-12' });
  assert.equal(ok.publishDate, '2026-04-12');
  assert.equal(ok.dateSource, 'listing-opening-date');
  // prior production's page: different opening, stays unresolved
  const prior = resolveIngestPublishDate({ html, url: 'https://cititour.com/x', text, showOpeningDate: '2024-03-11' });
  assert.equal(prior.publishDate, null);
  // a real page date always wins over the listing
  const meta = '<meta property="article:published_time" content="2026-04-13T10:00:00-04:00">' + html;
  assert.equal(resolveIngestPublishDate({ html: meta, url: 'https://cititour.com/x', showOpeningDate: '2026-04-12' }).publishDate, '2026-04-13');
});

// Class F: multi-show blog posts the section finder could not split (BRO-6716).
const ms = require('../../scripts/lib/multi-show-section-extract.js');
test('class F: "Theater Review:" headings and Encores! titles isolate one section', () => {
  const post = 'Intro words here. Heated Rivalry (c) Matthew Murphy Theater: Heated Rivalry At Culture Club When it was announced, a parody arrived. '
    + 'Romeo & Juliet (c) Joan Marcus Theater Review: Romeo & Juliet At the Delacorte Theater At intermission it was clear. '
    + 'La Cage aux Folles (c) Joan Marcus Theater Review: La Cage aux Folles At Encores! New York City Center There was a lot of excitement.';
  const url = 'https://www.interestedbystander.com/2026/06/off-broadway-reviews-some-pride-month.html';
  const r = ms.isolateMultiShowSection(url, post, 'Encores! La Cage Aux Folles');
  assert.equal(r.action, 'isolated');
  assert.match(r.text, /^La Cage aux Folles \(c\)/);
  assert.doesNotMatch(r.text, /Delacorte/);
  const rj = ms.isolateMultiShowSection(url, post, 'Romeo & Juliet');
  assert.equal(rj.action, 'isolated');
  assert.doesNotMatch(rj.text, /Encores/);
  // a show not in the post is still refused, never given another show's text
  assert.equal(ms.isolateMultiShowSection(url, post, 'Encores! The Wild Party').action, 'refuse');
});

// Class G (BRO-6716): old verifier prompts assumed Broadway, so correct Off-Broadway
// reviews were marked wrongProduction with "Off-Broadway, not Broadway".
test('class G: Off-Broadway category quibble is not wrong production', async (t) => {
  const G = require('../../scripts/lib/review-guards.js');
  const offShow = { id: 'spare-parts-off-broadway-2026', category: 'off-broadway', venue: 'Theatre Row - Theatre Three', openingDate: '2026-03-08', previewsStartDate: '2026-02-20' };
  const bwShow = { ...offShow, id: 'x-2026', category: 'broadway', venue: 'Ambassador Theatre' };
  const cvSpare = { wrongProduction: true, confidence: 'high', isValid: false,
    issues: ['Wrong production: The review is for an Off-Broadway production at Theatre Row, not a Broadway production.', 'Truncated: The scraped content is truncated.'],
    reasoning: 'The review explicitly states that the production is at Theatre Row, which is an Off-Broadway venue. The content is also truncated.' };
  const cvBlackout = { wrongProduction: true, confidence: 'high', isValid: false, issues: ['Wrong Production'],
    reasoning: "The review explicitly states that the production is 'Off-Broadway', not Broadway. The review is also truncated." };

  await t.test('clears the category quibble on an Off-Broadway show, keeps isValid', () => {
    const r = G.applyVenueClassificationCarveout(cvSpare, offShow);
    assert.equal(r.clearedWrongProduction, true);
    assert.equal(r.isValid, false);
    assert.equal(G.applyVenueClassificationCarveout(cvBlackout, offShow).clearedWrongProduction, true);
  });
  await t.test('does not fire on a Broadway show (there it means a different production)', () => {
    assert.equal(G.applyVenueClassificationCarveout(cvSpare, bwShow).clearedWrongProduction, false);
  });
  await t.test('vetoes: Broadway house named, different production, other year', () => {
    const pen = { ...cvSpare, issues: [], reasoning: 'The venue is the Daryl Roth Theatre, which is a Broadway theater, not the DR2 Theatre, which is an Off-Broadway theater.' };
    const titus = { ...cvSpare, issues: ['Red Bull Theater is an Off-Broadway venue, but this is a different Off-Broadway production of the same play'], reasoning: 'x' };
    const hamlet = { ...cvSpare, issues: ['The review is for an Off-Broadway production of Hamlet at The Greenwich House Theatre, but the opening date is February 11, 2024, not April 19, 2026 as expected.'],
      reasoning: 'The review is about a production of Hamlet at The Greenwich House Theatre, which is an Off-Broadway venue.' };
    for (const cv of [pen, titus, hamlet]) assert.equal(G.applyVenueClassificationCarveout(cv, offShow).clearedWrongProduction, false);
  });
  await t.test('"not Off-Broadway" (Broadway transfer) does not match', () => {
    const cv = { ...cvSpare, issues: [], reasoning: 'This review is of the Broadway transfer, not the Off-Broadway run.' };
    assert.equal(G.applyVenueClassificationCarveout(cv, offShow).clearedWrongProduction, false);
  });
  await t.test('rebuild decision needs the own-run window', () => {
    assert.equal(G.cvWrongProductionIsVenueCarveout(cvSpare, offShow, '2026-03-09'), true);
    assert.equal(G.cvWrongProductionIsVenueCarveout(cvSpare, offShow, '2017-10-13'), false);
    assert.equal(G.cvWrongProductionIsVenueCarveout(cvSpare, offShow, '2026-03-09', true), false);
  });
  await t.test('persisted-flag heal: provenance gates', () => {
    const base = { wrongProduction: true, publishDate: '2026-03-09', contentVerification: cvSpare };
    assert.equal(G.isVenueCarveoutPersistedWrongProduction(base, offShow), true);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, wrongProductionReason: 'CV-promoted: x' }, offShow), true);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, wrongProductionReason: 'Auto-flagged: URL date' }, offShow), false);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, wrongProductionNote: 'URL contains year 2019' }, offShow), false);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, humanReviewedWrongProduction: true }, offShow), false);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, wrongShow: true }, offShow), false);
    assert.equal(G.isVenueCarveoutPersistedWrongProduction({ ...base, rejectionReason: 'not_a_review' }, offShow), false);
  });
});

// Class G2 (BRO-6716): the ensemble scoreability check made the same Broadway-assumed call.
test('class G2: ensemble category-quibble rejection heals, real ones stay', async (t) => {
  const G = require('../../scripts/lib/review-guards.js');
  const show = { id: 'blackout-songs-off-broadway-2026', category: 'off-broadway', venue: 'MCC Theater', openingDate: '2026-01-15' };
  const base = { rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', publishDate: 'January 29, 2026',
    rejectionReasoning: "claude: This review is of an off-Broadway production at MCC Theater Space, not a Broadway or West End show; openai: The review is about an off-Broadway production of 'Blackout Songs' at the Robert W. Wilson MCC Theater Space, not a Broadway or West End show." };
  await t.test('heals the quibble (initials like "W." do not break the match)', () => {
    assert.equal(G.isEnsembleCategoryQuibbleRejection(base, show), true);
    const tfana = { ...base, rejectionReasoning: 'openai: The review is about an Off-Broadway production at Theatre for a New Audience, not the current Broadway run.; kimi: This review explicitly covers an Off-Broadway production at Theatre for a New Audience in Brooklyn, not a Broadway production.' };
    assert.equal(G.isEnsembleCategoryQuibbleRejection(tfana, show), true);
  });
  await t.test('one model naming a different production blocks the heal', () => {
    const mixed = { ...base, rejectionReasoning: base.rejectionReasoning + '; kimi: The review is for the Pasadena Playhouse production, not the Off-Broadway one.' };
    assert.equal(G.isEnsembleCategoryQuibbleRejection(mixed, show), false);
  });
  await t.test('film, Broadway show, out of window, human-reviewed: no heal', () => {
    const film = { ...base, rejectionReasoning: 'claude: This is a film review of an off-Broadway adaptation, not a Broadway show.' };
    assert.equal(G.isEnsembleCategoryQuibbleRejection(film, show), false);
    assert.equal(G.isEnsembleCategoryQuibbleRejection(base, { ...show, category: 'broadway' }), false);
    assert.equal(G.isEnsembleCategoryQuibbleRejection({ ...base, publishDate: '2019-01-01' }, show), false);
    assert.equal(G.isEnsembleCategoryQuibbleRejection({ ...base, humanReviewedWrongProduction: true }, show), false);
    assert.equal(G.isEnsembleCategoryQuibbleRejection({ ...base, rejectedBy: 'manual' }, show), false);
  });
});

// Class I (BRO-6716): "remember only" tripped the members-only paywall pattern.
test('class I: "remember only" is prose, "members only" is still a wall', () => {
  const cq = require('../../scripts/lib/content-quality.js');
  const prose = 'Mitchell Fenton\'s lighting morphs atmospherically. '.repeat(40) + 'adapted from the score for Saturday Night Fever (in case you remember only the Bee Gees). ' + 'The players switch their dressily casual outfits. '.repeat(40);
  assert.equal(cq.isGarbageContent(prose).isGarbage, false);
  assert.equal(cq.isGarbageContent('This article is for members only. Log in.').isGarbage, true);
});

test('class G2: rejectedAt-only ensemble row with "St." and "context specifies a Broadway" heals', () => {
  const G = require('../../scripts/lib/review-guards.js');
  const show = { id: 'the-adding-machine-off-broadway-2026', category: 'off-broadway', venue: "The Theater at St. Clement's", openingDate: '2026-04-13' };
  const d = { rejectedAt: '2026-04-19T13:00:53.735Z', rejectedBy: 'ensemble-scoreability-check', rejectionReason: null, publishDate: '2026-04-14',
    rejectionReasoning: "claude: This review is for an Off-Broadway production at The Theater at St. Clement's, but the context specifies a Broadway production of The Adding Machine.; openai: The review discusses a production of 'The Adding Machine' at The Theater at St. Clement's, Off Broadway, not the Broadway production specified in the context." };
  assert.equal(G.isEnsembleCategoryQuibbleRejection(d, show), true);
  assert.equal(G.isEnsembleCategoryQuibbleRejection({ ...d, rejectedAt: null }, show), false);
});

test('BRO-6716 class I follow-up: the rebuild tier safety net re-tiers a stale members-only garbage verdict', () => {
  const { classifyTierWriteBack } = require('../../scripts/lib/content-tier-reason-sync.js');
  const body = 'The production at the Public Theater is a sharp, funny evening. '.repeat(20)
    + 'I would remember only the second act, where the cast finds a deeper register. ';
  const r = classifyTierWriteBack({ contentTier: 'invalid', contentTierReason: 'Garbage content: Paywall/subscription prompt: "member only"', fullText: body });
  assert.notEqual(r.tierResult.contentTier, 'invalid');
  assert.equal(r.tierChanged, true);
  const g = classifyTierWriteBack({ contentTier: 'invalid', contentTierReason: 'Garbage content: paywall',
    fullText: 'This content is for members only. Subscribe now to continue reading. '.repeat(10) });
  assert.equal(g.tierResult.contentTier, 'invalid');
});

test('BRO-6716: a self-heal marker counts as clear evidence for the stale wrong-content retier', () => {
  const { retierStaleWrongContentTier } = require('../../scripts/lib/stale-wrong-content-tier.js');
  const fullText = 'The revival at MCC Theater is tender and precise, and the two leads are superb. '.repeat(15);
  const rec = { contentTier: 'invalid', contentTierReason: 'Wrong production', incompleteReason: 'wrong_content',
    wrongProduction: false, wrongProductionSelfHealed: true, fullText };
  assert.ok(retierStaleWrongContentTier(rec).includes('contentTier'));
  assert.notEqual(rec.contentTier, 'invalid');
  // Still flagged, or no clear evidence at all: untouched.
  const still = { contentTier: 'invalid', contentTierReason: 'Wrong production', wrongProduction: true, wrongProductionSelfHealed: true, fullText };
  assert.deepEqual(retierStaleWrongContentTier(still), []);
  const bare = { contentTier: 'invalid', contentTierReason: 'Wrong production', fullText };
  assert.deepEqual(retierStaleWrongContentTier(bare), []);
});

// ship-check P0: the Off-Broadway category carve-out must not clear a verdict
// that places the article at another staging (tour, London, regional).
test('BRO-6716 ship-check: Off-Broadway carve-out keeps tour / London / regional verdicts', () => {
  const { applyVenueClassificationCarveout } = require('../../scripts/lib/review-guards.js');
  const show = { category: 'off-broadway', venue: 'Westside Theatre', openingDate: '2026-03-01' };
  const cleared = (reasoning) => applyVenueClassificationCarveout({ wrongProduction: true, reasoning, issues: [] }, show).clearedWrongProduction;
  assert.equal(cleared('The review covers the touring production in Chicago at the Cadillac Palace; the expected show is an Off-Broadway production.'), false, 'tour');
  assert.equal(cleared('This review is of a London production; the expected show is an off-Broadway production at Westside.'), false, 'London');
  assert.equal(cleared('The article reviews a regional staging at Goodman Theatre, while this is an Off-Broadway production.'), false, 'regional');
  // the real quibble still clears, including a negated Broadway house and the "Broadway or West End" pairing
  assert.equal(cleared('The review is of the production at the Westside Theatre, which is an Off-Broadway venue.'), true, 'own house');
  assert.equal(cleared('The review is for an Off-Broadway production at Westside, not the Broadway production at the St. James Theatre.'), true, 'negated Broadway house');
  assert.equal(cleared('This review is of an Off-Broadway show at Westside Theatre, not a Broadway or West End production.'), true, 'category pairing');
});

test('BRO-6716 ship-check: festival-venue carve-out keeps a London-staging verdict', () => {
  const { applyVenueClassificationCarveout, showHasFestivalVenue } = require('../../scripts/lib/review-guards.js');
  const show = { category: 'off-broadway', venue: 'Public Theater/Delacorte Theater', openingDate: '2026-06-01' };
  assert.equal(showHasFestivalVenue(show), true);
  const cv = { wrongProduction: true, issues: [], reasoning: "The review discusses a production of 'Romeo and Juliet' directed by Robert Icke at the Harold Pinter Theatre in London, which indicates it is not reviewing the Off-Broadway production." };
  assert.equal(applyVenueClassificationCarveout(cv, show).clearedWrongProduction, false);
});

test('BRO-6716 ship-check: ensemble heal keeps a rejection that places the article on tour', () => {
  const { isEnsembleCategoryQuibbleRejection } = require('../../scripts/lib/review-guards.js');
  const show = { category: 'off-broadway', venue: 'Westside Theatre', openingDate: '2026-03-01', closingDate: '2026-12-31' };
  const row = (r) => ({ rejectionReason: 'wrong_production', rejectedAt: '2026-04-01', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: r, publishDate: '2026-03-02' });
  assert.equal(isEnsembleCategoryQuibbleRejection(row('claude: This review is of an Off-Broadway show at Westside Theatre, not a Broadway or West End production.'), show), true);
  // Blackout Songs: the show's venue is a sub-stage of the house the verdict names
  assert.equal(isEnsembleCategoryQuibbleRejection(row("claude: This review is of an off-Broadway production at MCC Theater Space, not a Broadway or West End show; openai: The review is about an off-Broadway production of 'Blackout Songs' at the Robert W. Wilson MCC Theater Space, not a Broadway or West End show."), show), true);
  assert.equal(isEnsembleCategoryQuibbleRejection(row('claude: The review covers the national tour stop in Boston, which is an Off-Broadway production, not a Broadway show.'), show), false);
});

test('BRO-6716 ship-check: a re-flag retracts the self-heal marker so it stops counting as clear evidence', () => {
  const { invalidateWrongProductionAutoClear, invalidateWrongShowAutoClear } = require('../../scripts/lib/review-write-guard.js');
  const p = { wrongProduction: true, wrongProductionSelfHealed: true, wrongProductionSelfHealReason: 'x' };
  invalidateWrongProductionAutoClear(p);
  assert.equal(p.wrongProductionSelfHealed, null);
  const s = { wrongShow: true, wrongShowSelfHealed: true, wrongShowSelfHealReason: 'x' };
  invalidateWrongShowAutoClear(s);
  assert.equal(s.wrongShowSelfHealed, null);
});

test('BRO-6716 ship-check: the rejection-delete breadcrumb only covers the exact rejection that was healed', () => {
  const { CLEAR_BREADCRUMBS } = require('../../scripts/lib/review-write-guard.js');
  const pred = CLEAR_BREADCRUMBS.rejectionReason;
  const healed = { rejectionReason: 'wrong_production', rejectedAt: null, rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: 'claude: Off-Broadway, not Broadway.' };
  const d = { rejectionSelfHealed: { ...healed } };
  assert.equal(Boolean(pred(d, { ...healed })), true, 'same rejection on disk: delete allowed');
  assert.equal(Boolean(pred(d, { ...healed, rejectionReasoning: 'claude: a London production.' })), false, 'newer rejection, same reason, both rejectedAt null: kept');
  assert.equal(Boolean(pred({}, { ...healed })), false, 'no heal record: kept');
});
