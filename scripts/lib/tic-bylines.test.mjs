// BRO-6518: theatreinchicago.com's critic fills a missing or site-wide byline, never a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planTicBylineFixes, lastSegment } = require('./tic-bylines.js');
const { normalizeCritic, normalizeUrl } = require('./review-normalization.js');
const { isSiteWideAuthorSource, isSiteWideAuthorAccount } = require('./content-quality.js');
const deps = { normalizeCritic, normalizeUrl, isSiteWideAuthorSource, isSiteWideAuthorAccount };
const plan = (files, src) => planTicBylineFixes(files, src, deps);

test('site-wide account is replaced (Around the Town: Jacob Davis -> Julia W. Rath)', () => {
  const u = 'https://aroundthetownchicago.com/theatre-reviews/a-lie-of-the-mind/';
  const { fixes } = plan([{ basename: 'around-the-town-chicago--jacob-davis.json', data: { url: u, outletId: 'around-the-town-chicago', criticName: 'Jacob Davis', fullText: 'Posted by Jacob Davis' } }], [{ critic: 'Julia W. Rath', url: u }]);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].dstBasename, 'around-the-town-chicago--julia-w-rath.json');
});

test('unknown critic is filled in', () => {
  const { fixes } = plan([{ basename: 'chicago-reader--unknown.json', data: { url: 'https://chicagoreader.com/performing-arts/theater/theater-review/hayward-gift-theatre/', criticName: 'Unknown' } }],
    [{ critic: 'Kerry Reid', url: 'https://chicagoreader.com/performing-arts/theater/theater-review/hayward-gift-theatre' }]);
  assert.equal(fixes[0].dstBasename, 'chicago-reader--kerry-reid.json');
});

test("a real page byline beats TIC's typo or truncation", () => {
  const u = 'https://chicago.suntimes.com/theater/2024/08/29/1776-marriott-review';
  for (const [stored, listed] of [['Catey Sullivan', 'Carey Sullivan'], ['Allie Bugajski', 'Allie Bugajsk'], ['Hugh Iglarsh', 'High Iglarsh']]) {
    assert.equal(plan([{ basename: `x--${normalizeCritic(stored)}.json`, data: { url: u, criticName: stored, fullText: `By ${stored}. A fine show.` } }], [{ critic: listed, url: u }]).fixes.length, 0, listed);
  }
});

test('a real byline is replaced only when the article names the listed critic instead', () => {
  const u = 'https://chicagostageandscreen.com/post/a-specific-review-slug';
  const files = [{ basename: 'chicagostageandscreen--anne-smith.json', data: { url: u, criticName: 'Anne Smith', fullText: 'Review by Reno Lovison of the new show.' } }];
  assert.equal(plan(files, [{ critic: 'Reno Lovison', url: u }]).fixes.length, 1);
  files[0].data.fullText = 'Review by Anne Smith and Reno Lovison.';
  assert.equal(plan(files, [{ critic: 'Reno Lovison', url: u }]).fixes.length, 0);
});

test('no match across sites, even with the same last segment', () => {
  const files = [{ basename: 'timeout--adam-feldman.json', data: { url: 'https://www.timeout.com/chicago/theater/vape-the-grease-parody-review', criticName: 'Unknown' } }];
  assert.equal(plan(files, [{ critic: 'Alan Bresloff', url: 'https://aroundthetownchicago.com/theatre-reviews/vape-the-grease-parody-review' }]).fixes.length, 0);
});

test('a redirected URL matches on its last segment on the same site (Third Coast /stages move)', () => {
  const files = [{ basename: 'third-coast-review--unknown.json', data: { url: 'https://thirdcoastreview.com/stages/2024/05/11/stages-review-steppenwolf-theatre-the-thanksgiving-play', criticName: null } }];
  assert.equal(plan(files, [{ critic: 'Nancy S. Bishop', url: 'https://thirdcoastreview.com/2024/05/11/stages-review-steppenwolf-theatre-the-thanksgiving-play' }]).fixes[0].critic, 'Nancy S. Bishop');
});

test('generic or ambiguous segments never match; joint and hand-set names are left alone', () => {
  assert.equal(lastSegment('https://a.com/2026/10/01/review/'), null);
  assert.equal(lastSegment('https://a.com/x/review-hamilton-at-the-cadillac?amp=1'), 'review-hamilton-at-the-cadillac');
  const u = 'https://chicagoreader.com/theater/some-specific-review-slug/';
  assert.equal(plan([{ basename: 'chicago-reader--unknown.json', data: { url: u, criticName: 'Unknown' } }], [{ critic: 'Kerry Reid and Dan Jakes', url: u }]).fixes.length, 0);
  assert.equal(plan([{ basename: 'chicago-reader--unknown.json', data: { url: u, criticName: 'Unknown', criticNameManual: true } }], [{ critic: 'Kerry Reid', url: u }]).fixes.length, 0);
});

test('a scraped label is not a name: "Written by" takes the listed critic', () => {
  const u = 'https://www.chi-mt.com/reviews/marriott-1776-aug-2024';
  assert.equal(plan([{ basename: 'chi-mt--written-by.json', data: { url: u, criticName: 'Written by', fullText: 'x' } }], [{ critic: "Patrick O'Brien", url: u }]).fixes.length, 1);
});

test('PicksInSix on its real domain: the Ed Tracy account is replaced, a real critic is not', () => {
  const u = 'https://www.conversationswithedtracy.com/a-specific-picks-review';
  const f = (name) => [{ basename: `picksinsix--${normalizeCritic(name)}.json`, data: { url: u, outletId: 'picksinsix', criticName: name, fullText: 'x' } }];
  assert.equal(plan(f('Ed Tracy'), [{ critic: 'Ronald Keaton', url: u }]).fixes.length, 1);
  assert.equal(plan(f('Ronald Keaton'), [{ critic: 'Ronald Keton', url: u }]).fixes.length, 0);
});

test('two TIC rows naming different critics for one URL never match', () => {
  const u = 'https://chicagoreader.com/theater/some-specific-review-slug/';
  assert.equal(plan([{ basename: 'chicago-reader--unknown.json', data: { url: u, criticName: 'Unknown' } }], [{ critic: 'A Person', url: u }, { critic: 'B Person', url: u }]).fixes.length, 0);
});
