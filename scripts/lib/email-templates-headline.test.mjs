import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildBroadcastOpeningNightHtml, buildBroadcastSubjectLine, getScoreColor } = require('./email-templates.js');

test('getScoreColor ROUNDS before tiering — matches the displayed score + the site', () => {
  // 64.69 displays as 65, so it must read "Worth Seeing", not "Mixed" (the 2026-06-30 bug).
  assert.equal(getScoreColor(64.69, 'west-end').label, 'Worth Seeing');
  assert.equal(getScoreColor(64.4, 'west-end').label, 'Mixed');        // displays 64
  assert.equal(getScoreColor(64.5, 'west-end').label, 'Worth Seeing'); // displays 65
  assert.equal(getScoreColor(60.03, 'west-end').label, 'Mixed');       // displays 60
});

test('getScoreColor Critical Gold threshold is market-aware (WE 85, Broadway 83)', () => {
  assert.equal(getScoreColor(83.4, 'west-end').label, 'Recommended');   // 83 < 85 WE gold
  assert.equal(getScoreColor(84.6, 'west-end').label, 'Critical Gold'); // rounds to 85
  assert.equal(getScoreColor(83, 'broadway').label, 'Critical Gold');   // 83 = BW gold
});

const mk = n => Array.from({ length: n }, (_, i) => ({
  showTitle: `Show ${i + 1}`, score: 70, reviewCount: 20, rave: 5, positive: 8, mixed: 5, negative: 2,
  showUrl: 'https://broadwayscorecard.com/show/x',
}));
const h1 = html => (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1];

test('multi-show headline never claims "Tonight" (roundup may span days)', () => {
  for (const market of ['west-end', 'broadway']) {
    const html = buildBroadcastOpeningNightHtml(mk(6), null, market);
    assert.ok(!html.includes('Tonight'), `"${market}" email must not say Tonight`);
  }
});

test('multi-show headline is market-aware and mirrors the subject location', () => {
  assert.match(h1(buildBroadcastOpeningNightHtml(mk(6), null, 'west-end')), /^6 Shows Opened in the West End/);
  assert.match(h1(buildBroadcastOpeningNightHtml(mk(3), null, 'broadway')), /^3 Shows Opened on Broadway/);
});

test('single-show headline unchanged (title + score)', () => {
  const html = buildBroadcastOpeningNightHtml([{ showTitle: 'Sinatra', score: 64, reviewCount: 30, showUrl: 'https://x' }], null, 'west-end');
  assert.match(h1(html), /^Sinatra Critic Reviews Are In/);
});

test('subject line stays accurate and market-aware (no Tonight)', () => {
  assert.equal(buildBroadcastSubjectLine(mk(6), 'west-end'), '6 shows opened in the West End — the reviews are in');
  assert.ok(!buildBroadcastSubjectLine(mk(6), 'west-end').includes('Tonight'));
});
