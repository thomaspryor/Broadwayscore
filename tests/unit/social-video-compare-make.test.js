// BRO-7418: the compare plan the video lane builds. Requires the real functions (CLAUDE.md §15).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sidesOf, tagsOf } = require('../../scripts/video-proto/compare-make');
const { composeCompare } = require('../../scripts/video-proto/compare-script');

const ny = { id: 'twin-2026', title: 'The Twin Show', category: 'broadway', openingDate: '2026-10-01' };
const off = { id: 'twin-off-2026', title: 'The Twin Show', category: 'off-broadway', openingDate: '2026-10-01' };
const lon = { id: 'twin-west-end-2025', title: 'The Twin Show', category: 'west-end', openingDate: '2025-06-01' };

test('sidesOf puts London first (the template says "also reviewed in London") and labels each side with its year', () => {
  const [a, b] = sidesOf(ny, lon);
  assert.deepEqual([a.id, a.place, a.label], ['twin-west-end-2025', 'London', 'London 2025']);
  assert.deepEqual([b.id, b.place, b.city, b.label], ['twin-2026', 'Broadway', 'New York', 'Broadway 2026']);
  assert.equal(sidesOf(off, lon)[1].place, 'Off-Broadway');
});

test('tagsOf: market tag, London tag, the show tag, and the fixed ones', () => {
  assert.equal(tagsOf(ny, lon), '#Broadway #WestEnd #TwinShow #Theater #London #NYC');
  assert.equal(tagsOf(off, { ...lon, category: 'off-west-end' }), '#OffBroadway #OffWestEnd #TwinShow #Theater #London #NYC');
});

test('the template says a tie, a one-point gap and a same-year pair without a number it cannot cue', () => {
  const side = (place, score, year) => ({ title: 'T', place, city: place, label: `${place} ${year}`, score, count: 20, year });
  const tie = composeCompare([side('London', 80, 2025), side('Broadway', 80, 2026)]);
  assert.equal(tie.tie, true); assert.equal(tie.screenHook.gap, 0);
  assert.match(tie.caveat, /^One year apart/);
  const same = composeCompare([side('London', 70, 2026), side('Broadway', 81, 2026)]);
  assert.match(same.caveat, /^Same year/);
  assert.equal(same.screenHook.gap, 11);
});

test('composeCompare accepts titles that differ only in case or punctuation (real London pairs)', () => {
  const { composeCompare } = require('../../scripts/video-proto/compare-script');
  const side = (title, place, label, score) => ({ title, place, city: place, label, score, count: 12, year: 2025 });
  for (const [a, b] of [['The Shark Is Broken', 'The Shark is Broken'], ['Ghost The Musical', 'Ghost – The Musical'], ['Grenfell: In the Words of Survivors', 'Grenfell: in the words of survivors']]) {
    assert.doesNotThrow(() => composeCompare([side(a, 'London', 'London 2025', 70), side(b, 'Broadway', 'Broadway 2025', 80)]));
  }
  assert.throws(() => composeCompare([side('Hamilton', 'London', 'L', 70), side('Wicked', 'Broadway', 'B', 80)]), /not the same show/);
});
