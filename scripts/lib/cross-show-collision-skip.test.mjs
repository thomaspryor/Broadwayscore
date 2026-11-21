import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wrongShowSkipDecision } = require('./cross-show-collision-skip.js');

const WE_SHOW = { id: 'fixture-play-west-end-2025', title: 'Fixture Play', venue: 'Harold Pinter Theatre', previewsStartDate: '2025-03-01', openingDate: '2025-03-10' };
const OLD_VIC = { id: 'fixture-play-off-west-end-2019', venue: 'Old Vic Theatre' };
const base = { cleared: false, londonUk: true, urlMarketMatch: false, sameTitleShows: [WE_SHOW, OLD_VIC] };
const body = (s) => s + ' The production is handsome and the cast is uniformly strong in every scene.'.repeat(4);

test('null publishDate still skips for an ordinary file', () => {
  const d = wrongShowSkipDecision({ ...base, show: WE_SHOW, londonUk: false, data: { publishDate: null } });
  assert.equal(d.skip, true);
});

test('BRO-2261 class 1: null publishDate with a junk body does not skip', () => {
  for (const r of ['scraper_garbage', 'url_content_mismatch', 'wrong_content']) {
    const d = wrongShowSkipDecision({ ...base, show: WE_SHOW, londonUk: false, data: { publishDate: null, incompleteReason: r } });
    assert.equal(d.skip, false, r);
  }
});

test('London + UK skip holds for a review of this run', () => {
  const d = wrongShowSkipDecision({ ...base, show: WE_SHOW,
    data: { publishDate: '2025-03-11', fullText: body('Fixture Play at the Harold Pinter is a triumph.') } });
  assert.equal(d.skip, true);
});

test('BRO-2261 class 2: earlier same-title London run (published years before) is not skipped', () => {
  const d = wrongShowSkipDecision({ ...base, show: WE_SHOW,
    data: { publishDate: '2019-06-01', fullText: body('Fixture Play at the Old Vic is a triumph.') } });
  assert.equal(d.skip, false);
  assert.match(d.reason, /before this run/);
});

test('BRO-2261 class 2: text names the other production\'s venue only', () => {
  const d = wrongShowSkipDecision({ ...base, show: WE_SHOW,
    data: { publishDate: '2025-03-11', fullText: body('Fixture Play at the Old Vic is a triumph.') } });
  assert.equal(d.skip, false);
  assert.match(d.reason, /Old Vic/);
});

test('London + UK skip stands down when the text never names the show', () => {
  const d = wrongShowSkipDecision({ ...base, show: WE_SHOW,
    data: { publishDate: '2025-03-11', fullText: body('Another Musical entirely, reviewed here.') } });
  assert.equal(d.skip, false);
});

test('manual clear always skips', () => {
  const d = wrongShowSkipDecision({ ...base, cleared: true, show: WE_SHOW, data: { publishDate: '2019-01-01' } });
  assert.equal(d.skip, true);
});
