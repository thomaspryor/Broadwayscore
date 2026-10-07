import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planSharedIbdbUrlFixes, productionEpoch } = require('../../scripts/lib/fix-shared-ibdb-urls.js');

const URL_SOM = 'https://www.ibdb.com/broadway-production/the-sound-of-music-4849';
const URL_FGM = 'https://www.ibdb.com/broadway-production/a-few-good-men-4255';

test('nulls the revival copy, keeps the original production (2026-07-03 incident shape)', () => {
  const shows = [
    { id: 'the-sound-of-music-1998', openingDate: '1998-03-12', ibdbUrl: URL_SOM },
    { id: 'the-sound-of-music-2026', openingDate: '2026-11-09', ibdbUrl: URL_SOM },
    { id: 'a-few-good-men-1989', openingDate: '1989-11-15', ibdbUrl: URL_FGM },
    { id: 'a-few-good-men-2026', openingDate: '2026-10-01', ibdbUrl: URL_FGM },
    { id: 'wicked-2003', openingDate: '2003-10-30', ibdbUrl: 'https://www.ibdb.com/broadway-production/wicked-13485' },
  ];
  const fixes = planSharedIbdbUrlFixes(shows);
  assert.deepEqual(
    fixes.map(f => `${f.id}<-${f.keptOn}`).sort(),
    ['a-few-good-men-2026<-a-few-good-men-1989', 'the-sound-of-music-2026<-the-sound-of-music-1998']
  );
});

test('no shared urls -> no fixes; null/missing ibdbUrl never groups', () => {
  const shows = [
    { id: 'a-2020', openingDate: '2020-01-01', ibdbUrl: 'https://www.ibdb.com/broadway-production/a-1' },
    { id: 'b-2021', openingDate: '2021-01-01', ibdbUrl: null },
    { id: 'c-2022', openingDate: '2022-01-01' },
    { id: 'd-2023', openingDate: '2023-01-01', ibdbUrl: null },
  ];
  assert.deepEqual(planSharedIbdbUrlFixes(shows), []);
});

test('missing openingDate falls back to previewDate then id year', () => {
  const url = 'https://www.ibdb.com/broadway-production/x-99';
  const shows = [
    { id: 'x-2026', ibdbUrl: url },                       // id year 2026
    { id: 'x-revival-1995', ibdbUrl: url },               // id year 1995 — keeper
    { id: 'x-previews-2010', previewDate: '2010-05-01', ibdbUrl: url },
  ];
  const fixes = planSharedIbdbUrlFixes(shows);
  assert.equal(fixes.length, 2);
  assert.ok(fixes.every(f => f.keptOn === 'x-revival-1995'));
  assert.deepEqual(fixes.map(f => f.id).sort(), ['x-2026', 'x-previews-2010']);
});

test('three-way share clears all but the earliest', () => {
  const url = 'https://www.ibdb.com/broadway-production/y-7';
  const shows = [
    { id: 'y-2000', openingDate: '2000-01-01', ibdbUrl: url },
    { id: 'y-2010', openingDate: '2010-01-01', ibdbUrl: url },
    { id: 'y-2020', openingDate: '2020-01-01', ibdbUrl: url },
  ];
  const fixes = planSharedIbdbUrlFixes(shows);
  assert.deepEqual(fixes.map(f => f.id).sort(), ['y-2010', 'y-2020']);
});

test('productionEpoch: undated shows sort last (never become keeper over a dated one)', () => {
  assert.equal(productionEpoch({ id: 'no-year-at-all' }), Infinity);
  const url = 'https://www.ibdb.com/broadway-production/z-3';
  const shows = [
    { id: 'z-undated', ibdbUrl: url },
    { id: 'z-1990', openingDate: '1990-06-01', ibdbUrl: url },
  ];
  const fixes = planSharedIbdbUrlFixes(shows);
  assert.deepEqual(fixes, [{ id: 'z-undated', ibdbUrl: url, keptOn: 'z-1990' }]);
});
