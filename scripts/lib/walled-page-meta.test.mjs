/**
 * Regression test: a registration-walled The Stage page still yields the
 * article's date, byline and standfirst (reader report 2026-09-26: Man to Man,
 * Darkling and Deep Heat Rivalry showed no date or quote). The fixture mirrors
 * The Stage's markup; the related-article cards after the article reuse the
 * same classes, so the FIRST occurrence must win. Per CLAUDE.md rule 15 this
 * require()s the real functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractTheStageArticleMeta, applyWalledPageMeta, headlineMatchesShow } = require('./walled-page-meta.js');

const WALLED = `
<div><a href="/reviews/reviews" class="aos-SectionTitle">Reviews</a><span class="aos-ArticleDate aos-MR10px aos-MBS3 aos-NM aos-FL">Sep 16, 2026</span></div>
<h1 class="aos-ArticleTitle aos-DS32-H1 aos-FL100 aos-M0 aos-MB10px">Darkling review</h1>
<div class="aos-StarRating aos-FL100"><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageNoStar.svg" /></div>
<a class="aos-ArticleAuthor aos-NM aos-FL aos-MR10px aos-MBS3 aos-DF" title="Holly O&#39;Mahony" href="/hollyom">by&nbsp;Holly O&#39;Mahony</a>
<div class="aos-DS32-Teaser aos-FL100">Evocative coming-of-age monologue set against the Bhopal disaster</div>
<div id="ao-MeteringDNAllow"><h2>Register to read</h2></div>
<div class="related"><span class="aos-ArticleDate aos-MR10px">Sep 12, 2026</span>
<a class="aos-ArticleAuthor aos-NM aos-FL aos-MR10px aos-DF" title="Neil Norman" href="/neilno">by&nbsp;Neil Norman</a></div>`;

const DARKLING_RUN = { previewsStartDate: '2026-09-10', openingDate: '2026-09-15', closingDate: '2026-10-11' };

test('extracts the article\'s own date, byline, standfirst (not a related card\'s)', () => {
  const meta = extractTheStageArticleMeta(WALLED);
  assert.deepEqual(meta, {
    headline: 'Darkling review',
    criticName: "Holly O'Mahony",
    publishDate: '2026-09-16',
    standfirst: 'Evocative coming-of-age monologue set against the Bhopal disaster',
    stars: 4,
  });
});

test('IntroText template standfirst is read too', () => {
  const html = `<span class="aos-ArticleDate aos-MR10px">Sep 14, 2026</span>
<h1 class="aos-ArticleTitle aos-DS32-H1">Man to Man review</h1>
<a class="aos-ArticleAuthor aos-NM" title="Sam Marlowe" href="/sammarlowe">by&nbsp;Sam Marlowe</a>
<div class="aos-Article-IntroText aos-DS32-Intro aos-MB15px aos-FL100"><span><p>Tilda Swinton is mesmeric in this landmark revival of the confrontational German monodrama</p></span></div>`;
  const meta = extractTheStageArticleMeta(html);
  assert.equal(meta.standfirst, 'Tilda Swinton is mesmeric in this landmark revival of the confrontational German monodrama');
  assert.equal(meta.publishDate, '2026-09-14');
  assert.equal(meta.criticName, 'Sam Marlowe');
});

test('non-article HTML yields null', () => {
  assert.equal(extractTheStageArticleMeta('<html><body>Just a login page</body></html>'), null);
  assert.equal(extractTheStageArticleMeta(''), null);
});

test('applyWalledPageMeta fills gaps only', () => {
  const stub = {
    url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london',
    criticName: 'Unknown', publishDate: null,
  };
  const set = applyWalledPageMeta(stub, WALLED, { show: DARKLING_RUN });
  assert.deepEqual(set.sort(), ['criticName', 'originalScore', 'outletHeadline', 'outletStandfirst', 'publishDate']);
  assert.equal(stub.originalScore, '4/5 stars');
  assert.equal(stub.originalScoreNormalized, 80);
  assert.equal(stub.originalScoreSource, 'stage-star-svg');
  assert.equal(stub.publishDate, '2026-09-16');
  assert.equal(stub.criticName, "Holly O'Mahony");

  const named = {
    url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london',
    criticName: 'Someone Else', publishDate: '2026-09-15', outletStandfirst: 'Existing standfirst line here',
  };
  applyWalledPageMeta(named, WALLED);
  assert.equal(named.criticName, 'Someone Else');
  assert.equal(named.publishDate, '2026-09-15');
  assert.equal(named.outletStandfirst, 'Existing standfirst line here');

  const manual = { url: stub.url, criticName: 'Unknown', criticNameManual: true };
  applyWalledPageMeta(manual, WALLED);
  assert.equal(manual.criticName, 'Unknown');
});

test('refuses to dress up another show\'s review (headline mismatch)', () => {
  const stub = { url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london', criticName: 'Unknown' };
  assert.deepEqual(applyWalledPageMeta(stub, WALLED, { showTitle: 'Man to Man' }), ['wrongShowSuspect']);
  assert.equal(stub.criticName, 'Unknown');
  assert.equal(stub.publishDate, undefined);
  assert.ok(applyWalledPageMeta({ ...stub }, WALLED, { showTitle: 'Darkling' }).includes('publishDate'));
});

test('round-ups and non-review articles are refused', () => {
  const { classifyStageHeadline } = require('./walled-page-meta.js');
  assert.equal(classifyStageHeadline('Trainspotting the Musical at the Theatre Royal Haymarket – review round-up', 'Trainspotting the Musical'), 'roundup');
  assert.equal(classifyStageHeadline('People-powered creativity will outlive AI, and this theatre design is proof', 'Proof'), 'not-review');
  assert.equal(classifyStageHeadline("Sharon D Clarke to appear in UK premiere of Cy Coleman's musical The Life", 'The Life'), 'not-review');
  assert.equal(classifyStageHeadline('Darkling review', 'Darkling'), 'review');
  assert.equal(classifyStageHeadline('The Scottsboro Boys', 'The Scottsboro Boys'), 'review'); // pre-2015 template
  const roundup = WALLED.replace('Darkling review', 'Darkling at the Bush Theatre – review round-up');
  const stub = { url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london', criticName: 'Unknown' };
  assert.deepEqual(applyWalledPageMeta(stub, roundup, { showTitle: 'Darkling' }), ['roundupSuspect']);
  assert.equal(stub.criticName, 'Unknown');
});

test('does not name the critic when a sibling already owns that slot (rename would merge)', () => {
  const stub = { url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london', criticName: 'Unknown' };
  const set = applyWalledPageMeta(stub, WALLED, { showTitle: 'Darkling', criticSlotTaken: () => true });
  assert.equal(stub.criticName, 'Unknown');
  assert.ok(!set.includes('criticName'));
  assert.ok(set.includes('publishDate'));
});

test('salvageWalledPageMetaToFile writes gaps and respects an occupied critic slot', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { salvageWalledPageMetaToFile } = require('./walled-page-meta.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpm-'));
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  const fp = path.join(dir, 'thestage--unknown.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'x', outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown', url }));
  fs.writeFileSync(path.join(dir, 'thestage--holly-omahony.json'), '{}');
  const set = salvageWalledPageMetaToFile(fp, WALLED, { showTitle: 'Darkling', expectedUrl: url });
  const written = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.ok(set.includes('publishDate'));
  assert.equal(written.publishDate, '2026-09-16');
  assert.equal(written.criticName, 'Unknown'); // slot owned by a sibling
  // url moved on since the fetch → no-op
  assert.deepEqual(salvageWalledPageMetaToFile(fp, WALLED, { showTitle: 'Darkling', expectedUrl: 'https://www.thestage.co.uk/reviews/other-review' }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only applies to The Stage URLs', () => {
  const other = { url: 'https://www.whatsonstage.com/news/darkling-review_1/', criticName: 'Unknown' };
  assert.deepEqual(applyWalledPageMeta(other, WALLED), []);
  assert.equal(other.criticName, 'Unknown');
});

test('headlineMatchesShow compares the whole name before "review" (ship-check on #940)', () => {
  const cases = [
    ['Romeo and Juliet review', '& Juliet', false],
    ['Christmas Carol Goes Wrong review', 'The Play That Goes Wrong', false],
    ['The Importance of Being Earnest review', 'The Importance of Being Oscar', false],
    ['& Juliet review', '& Juliet', true],
    ['Come Alive! The Greatest Showman review', 'Come Alive! The Greatest Showman Circus Spectacular', true],
    ['Jane Eyre: A Musical review', 'Jane Eyre', true],
    ['Matthew Bourne’s New Adventures – The Car Man review', 'The Car Man', true],
    ['Orlando review', 'Orlando: A Pornobiography', true],
    ['The Mousetrap', 'The Mousetrap', true],
  ];
  for (const [h, t, want] of cases) assert.equal(headlineMatchesShow(h, t), want, `${t} <- ${h}`);
});

// BRO-4428: a walled stub with no score never reaches the site, so the star
// rating above the wall must be salvaged too, and only the article's own.
test('star rating: article block only, never a related card\'s', () => {
  const noArticleStars = `<h1 class="aos-ArticleTitle">Choir Boy review</h1>
<a class="aos-ArticleAuthor aos-NM" title="Sam Marlowe" href="/s">by&nbsp;Sam Marlowe</a>
<div class="related"><div class="aos-StarRating aos-FL"><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /></div></div>`;
  assert.equal(extractTheStageArticleMeta(noArticleStars).stars, null);

  const noByline = `<h1 class="aos-ArticleTitle">Choir Boy review</h1>
<div class="aos-StarRating aos-FL"><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /></div>`;
  assert.equal(extractTheStageArticleMeta(noByline).stars, null);

  const partial = WALLED.replace('<img src="/19stageNoStar.svg" />', '');
  assert.equal(extractTheStageArticleMeta(partial).stars, null);
});

test('star rating never overwrites an existing or manual score', () => {
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  const scored = { url, criticName: 'Holly O\'Mahony', originalScore: '3/5 stars', originalScoreNormalized: 60 };
  applyWalledPageMeta(scored, WALLED, { show: DARKLING_RUN });
  assert.equal(scored.originalScore, '3/5 stars');
  assert.equal(scored.originalScoreNormalized, 60);

  const manual = { url, criticName: 'Unknown', originalScoreManual: true };
  assert.ok(!applyWalledPageMeta(manual, WALLED, { show: DARKLING_RUN }).includes('originalScore'));
  assert.equal(manual.originalScore, undefined);
});

test('star rating needs the review to date from this production\'s run', () => {
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  // Page date Sep 16, 2026; a 2027 run of the same title must not get it.
  const later = { url, criticName: 'Unknown' };
  const set = applyWalledPageMeta(later, WALLED, { show: { previewsStartDate: '2027-01-15', closingDate: '2027-04-10' } });
  assert.ok(!set.includes('originalScore'));
  assert.equal(later.originalScore, undefined);
  assert.equal(later.publishDate, '2026-09-16');

  // No show passed: fail closed on the score, still fill date/critic.
  const noShow = { url, criticName: 'Unknown' };
  assert.ok(!applyWalledPageMeta(noShow, WALLED).includes('originalScore'));
  assert.equal(noShow.criticName, "Holly O'Mahony");
});

test('bracketed subtitle in the headline still matches the show', () => {
  assert.equal(headlineMatchesShow('Slaughterhouse-Five (or the Children’s Crusade) review', 'Slaughterhouse-Five'), true);
  // Brackets do not launder a different show's name.
  assert.equal(headlineMatchesShow('Romeo and Juliet (Globe) review', '& Juliet'), false);
});

test('window uses the page date first, and parses ordinal stored dates', () => {
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  // Stored date is out of window but the page says Sep 16, 2026: page wins.
  const stale = { url, criticName: 'Unknown', publishDate: '2019-01-01' };
  assert.ok(applyWalledPageMeta(stale, WALLED, { show: DARKLING_RUN }).includes('originalScore'));
  // No page date: an ordinal stored date inside the run still scores.
  const noDate = WALLED.replace(/<span class="aos-ArticleDate[^<]*<\/span>/g, '');
  assert.equal(extractTheStageArticleMeta(noDate).publishDate, null);
  const ordinal = { url, criticName: 'Unknown', publishDate: 'September 16th, 2026' };
  assert.ok(applyWalledPageMeta(ordinal, noDate, { show: DARKLING_RUN }).includes('originalScore'));
  // Raw new Date() can't parse this; an out-of-run ordinal date still refuses.
  const oldOrdinal = { url, criticName: 'Unknown', publishDate: 'January 26th, 2023' };
  assert.ok(!applyWalledPageMeta(oldOrdinal, noDate, { show: DARKLING_RUN }).includes('originalScore'));
});

test('no article byline: a related card\'s byline and stars are never used', () => {
  const html = `<h1 class="aos-ArticleTitle">Darkling review</h1>
<div class="aos-DS32-Teaser aos-FL100">Evocative coming-of-age monologue set against the Bhopal disaster</div>
<div id="ao-MeteringDNAllow"><h2>Register to read</h2></div>
<div class="related"><div class="aos-StarRating aos-FL"><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /><img src="/19stageNoStar.svg" /></div>
<a class="aos-ArticleAuthor aos-NM" title="Neil Norman" href="/n">by&nbsp;Neil Norman</a></div>`;
  assert.equal(extractTheStageArticleMeta(html).stars, null);
});

test('a full-text review gets its missing date but keeps its text-based score', () => {
  const d = { url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london', criticName: "Holly O'Mahony", fullText: 'x'.repeat(2000) };
  const set = applyWalledPageMeta(d, WALLED, { show: DARKLING_RUN });
  assert.ok(set.includes('publishDate'));
  assert.equal(d.publishDate, '2026-09-16');
  assert.ok(!set.includes('originalScore'));
  assert.equal(d.originalScore, undefined);
});

test('flagged files never get a salvaged score', () => {
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  for (const flag of [{ wrongShow: true }, { wrongProduction: true }, { duplicateOf: 'thestage--x.json' }]) {
    const d = { url, criticName: 'Unknown', ...flag };
    assert.ok(!applyWalledPageMeta(d, WALLED, { show: DARKLING_RUN }).includes('originalScore'), JSON.stringify(flag));
  }
});

test('salvageWalledPageMetaToFile writes the salvaged score through to the file', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { salvageWalledPageMetaToFile } = require('./walled-page-meta.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walled-'));
  const fp = path.join(dir, 'thestage--unknown.json');
  fs.writeFileSync(fp, JSON.stringify({
    showId: 'darkling-off-west-end-2026', outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london',
  }));
  const set = salvageWalledPageMetaToFile(fp, WALLED, { showTitle: 'Darkling', show: DARKLING_RUN });
  assert.ok(set.includes('originalScore'));
  // Naming the critic renames the file (safeWriteReview), so read whatever is there now.
  const written = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  assert.equal(written.originalScore, '4/5 stars');
  assert.equal(written.originalScoreSource, 'stage-star-svg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deliberately cleared score stays cleared (originalScoreCleared is sticky)', () => {
  const url = 'https://www.thestage.co.uk/reviews/darkling-review-bush-theatre-london';
  const cleared = { url, criticName: 'Unknown', originalScoreCleared: true };
  assert.ok(!applyWalledPageMeta(cleared, WALLED, { show: DARKLING_RUN }).includes('originalScore'));
  assert.equal(cleared.originalScore, undefined);
});
