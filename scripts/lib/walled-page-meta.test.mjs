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
const { extractTheStageArticleMeta, applyWalledPageMeta } = require('./walled-page-meta.js');

const WALLED = `
<div><a href="/reviews/reviews" class="aos-SectionTitle">Reviews</a><span class="aos-ArticleDate aos-MR10px aos-MBS3 aos-NM aos-FL">Sep 16, 2026</span></div>
<h1 class="aos-ArticleTitle aos-DS32-H1 aos-FL100 aos-M0 aos-MB10px">Darkling review</h1>
<div class="aos-StarRating aos-FL100"><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageStar.svg" /><img src="/19stageNoStar.svg" /></div>
<a class="aos-ArticleAuthor aos-NM aos-FL aos-MR10px aos-MBS3 aos-DF" title="Holly O&#39;Mahony" href="/hollyom">by&nbsp;Holly O&#39;Mahony</a>
<div class="aos-DS32-Teaser aos-FL100">Evocative coming-of-age monologue set against the Bhopal disaster</div>
<div id="ao-MeteringDNAllow"><h2>Register to read</h2></div>
<div class="related"><span class="aos-ArticleDate aos-MR10px">Sep 12, 2026</span>
<a class="aos-ArticleAuthor aos-NM aos-FL aos-MR10px aos-DF" title="Neil Norman" href="/neilno">by&nbsp;Neil Norman</a></div>`;

test('extracts the article\'s own date, byline, standfirst (not a related card\'s)', () => {
  const meta = extractTheStageArticleMeta(WALLED);
  assert.deepEqual(meta, {
    headline: 'Darkling review',
    criticName: "Holly O'Mahony",
    publishDate: '2026-09-16',
    standfirst: 'Evocative coming-of-age monologue set against the Bhopal disaster',
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
  const set = applyWalledPageMeta(stub, WALLED);
  assert.deepEqual(set.sort(), ['criticName', 'outletHeadline', 'outletStandfirst', 'publishDate']);
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
