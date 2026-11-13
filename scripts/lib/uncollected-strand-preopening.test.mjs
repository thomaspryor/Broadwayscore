// BRO-7450: a preview-period blog post must not read as press night (The Fantasticks 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assessShow } = createRequire(import.meta.url)('./uncollected-strand.js');

const nowMs = Date.parse('2026-11-13T15:00:00Z');
const stub = (url, publishDate) => ({ url, fullText: '', contentTier: 'stub', publishDate });
const files = (...rs) => rs.map((review, i) => ({ file: `f${i}.json`, review }));
const early = [stub('https://a.test/3', '2026-11-13'), stub('https://a.test/4', '2026-11-13')];
const rs = [stub('https://a.test/1', '2026-11-11'), stub('https://a.test/2', '2026-10-30')];
const show = (openingDate) => ({ id: 's', status: 'previews', previewsStartDate: '2026-10-22', openingDate, market: 'broadway', category: 'musical' });

test('previews, opening 3 days away: dated preview posts are not a blackout', () => {
  assert.equal(assessShow(show('2026-11-16'), files(...rs), { nowMs }).totalBlackout, false);
});
test('previews, opening tomorrow, review dated the day before: licenses the alarm', () => {
  assert.equal(assessShow(show('2026-11-14'), files(...early), { nowMs }).totalBlackout, true);
});
test('previews, day before opening: preview-dated posts still do not alarm', () => {
  assert.equal(assessShow(show('2026-11-14'), files(...rs), { nowMs }).totalBlackout, false);
});
test('open status with a stale future openingDate: dated reviews still alarm', () => {
  const o = { ...show('2026-11-20'), status: 'open' };
  assert.equal(assessShow(o, files(...rs), { nowMs }).totalBlackout, true);
});
test('previews, opening date passed: blackout stands', () => {
  assert.equal(assessShow(show('2026-11-12'), files(...rs), { nowMs }).totalBlackout, true);
});
