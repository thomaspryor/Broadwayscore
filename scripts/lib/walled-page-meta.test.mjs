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

test('only applies to The Stage URLs', () => {
  const other = { url: 'https://www.whatsonstage.com/news/darkling-review_1/', criticName: 'Unknown' };
  assert.deepEqual(applyWalledPageMeta(other, WALLED), []);
  assert.equal(other.criticName, 'Unknown');
});
