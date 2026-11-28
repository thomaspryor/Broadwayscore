import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findSiblingSameUrlPairs, haveDistinctTexts } = require('./sibling-same-url.js');
const { buildSiblingIndex } = require('./market-routing.js');

const shows = [
  { id: 'the-comedy-about-spies-west-end-2025', title: 'The Comedy About Spies', category: 'west-end', openingDate: '2025-05-06' },
  { id: 'the-comedy-about-spies-west-end-2026', title: 'The Comedy About Spies', category: 'west-end', openingDate: '2026-08-06' },
  { id: 'unrelated-2026', title: 'Something Else', category: 'west-end', openingDate: '2026-01-01' },
];
const TIMES = 'https://www.thetimes.com/culture/theatre-dance/article/the-comedy-about-spies-review-inventive-humour-we-need-cd2nx6qlc';

function run(folders, skipPair) {
  const idx = buildSiblingIndex(shows);
  const load = (id) => Object.entries(folders[id] || {}).map(([file, data]) => ({ file, data }));
  const counted = (d) => d.wrongProduction !== true;
  return findSiblingSameUrlPairs(idx, load, counted, skipPair);
}

test('BRO-4674: one url counted on two same-title productions is reported once', () => {
  const pairs = run({
    'the-comedy-about-spies-west-end-2025': { 'times-uk--clive-davis.json': { url: TIMES } },
    'the-comedy-about-spies-west-end-2026': { 'sunday-times--unknown.json': { url: TIMES } },
  });
  assert.equal(pairs.length, 1);
  assert.deepEqual(
    { showId: pairs[0].showId, file: pairs[0].file, targetShowId: pairs[0].targetShowId, targetFile: pairs[0].targetFile },
    {
      showId: 'the-comedy-about-spies-west-end-2025', file: 'times-uk--clive-davis.json',
      targetShowId: 'the-comedy-about-spies-west-end-2026', targetFile: 'sunday-times--unknown.json',
    },
  );
});

test('BRO-4674: a copy already flagged off the score is not a double count', () => {
  const pairs = run({
    'the-comedy-about-spies-west-end-2025': { 'times-uk--clive-davis.json': { url: TIMES } },
    'the-comedy-about-spies-west-end-2026': { 'sunday-times--unknown.json': { url: TIMES, wrongProduction: true } },
  });
  assert.equal(pairs.length, 0);
});

test('BRO-4674: skipPair lets a pair a person cleared on both sides stand', () => {
  const folders = {
    'the-comedy-about-spies-west-end-2025': { 'a.json': { url: TIMES, wrongProductionManualClear: true } },
    'the-comedy-about-spies-west-end-2026': { 'b.json': { url: TIMES, wrongProductionManualClear: true } },
  };
  const bothCleared = (l, r) => l.wrongProductionManualClear === true && r.wrongProductionManualClear === true;
  assert.equal(run(folders, bothCleared).length, 0);
  folders['the-comedy-about-spies-west-end-2026']['b.json'] = { url: TIMES };
  assert.equal(run(folders, bothCleared).length, 1);
});

test('BRO-4674: the same url under a show with a different title is not this audit\'s pair', () => {
  const pairs = run({
    'the-comedy-about-spies-west-end-2025': { 'a.json': { url: TIMES } },
    'unrelated-2026': { 'b.json': { url: TIMES } },
  });
  assert.equal(pairs.length, 0);
});

test('BRO-6113: haveDistinctTexts separates a recycled url slug from a double count', () => {
  const para = (w) => Array.from({ length: 80 }, (_, i) => `${w}${i}`).join(' ');
  const a = { fullText: para('alpha') };
  assert.equal(haveDistinctTexts(a, { fullText: para('beta') }), true);
  assert.equal(haveDistinctTexts(a, { fullText: a.fullText }), false, 'identical text is one article');
  assert.equal(haveDistinctTexts(a, { fullText: 'x' }), false, 'no real text stays reported');
  assert.equal(haveDistinctTexts(a, {}), false);
  const folders = {
    'the-comedy-about-spies-west-end-2025': { 'a.json': { url: TIMES, fullText: para('alpha') } },
    'the-comedy-about-spies-west-end-2026': { 'b.json': { url: TIMES, fullText: para('beta') } },
  };
  assert.equal(run(folders, haveDistinctTexts).length, 0);
  assert.equal(run(folders).length, 1);
  // same article behind different headers / markup / truncation is still one article
  const article = Array.from({ length: 120 }, (_, i) => `sentence${i}`).join(' ');
  const header = 'The best of London straight to your inbox By entering your email address you agree to our Terms of Use and Privacy Policy and consent to receive emails from Time Out about news events offers and partner promotions';
  assert.equal(haveDistinctTexts({ fullText: header + ' ' + article }, { fullText: article.split(' ').slice(0, 70).join(' ') }), false, 'header on one copy');
  assert.equal(haveDistinctTexts({ fullText: `<p>${article}</p>` }, { fullText: 'Photograph: Courtesy of X ' + article }), false, 'markup vs plain');
  assert.equal(haveDistinctTexts({ fullText: header + ' ' + para('alpha').repeat(1) + ' ' + Array.from({ length: 400 }, (_, i) => `a${i}`).join(' ') }, { fullText: header + ' ' + para('beta') + ' ' + Array.from({ length: 400 }, (_, i) => `b${i}`).join(' ') }), true, 'shared header, different articles');
});
