import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('./we-historical-dates.js');
const { isUnconfirmedDateSource } = require('./date-source-confidence.js');

test('a WOS listing with no preview date is a first performance, never a press night', () => {
  // Betrayal 2019: WOS opening_date 2019-03-05 with no preview_date; press night was 13 March.
  const r = d.wosStartDates({ previewsStartDate: null, openingDate: '2019-03-05' });
  assert.equal(r.previewsStartDate, '2019-03-05');
  assert.equal(r.openingDateSource, d.WOS_FIRST_PERFORMANCE_SOURCE);
  // The collapsed shape is what the daily --fix-unconfirmed pass corrects, so the source must read as unconfirmed.
  assert.equal(isUnconfirmedDateSource({ openingDateSource: r.openingDateSource, category: 'west-end' }), true);
});

test('a WOS listing with both dates keeps a plausible press night', () => {
  assert.deepEqual(d.wosStartDates({ previewsStartDate: '2024-10-04', openingDate: '2024-10-15' }),
    { previewsStartDate: '2024-10-04', openingDate: '2024-10-15', openingDateSource: 'whatsonstage' });
  // Equal dates, or an "opening" 6+ weeks after the first preview, are placeholders.
  assert.equal(d.wosStartDates({ previewsStartDate: '2024-10-04', openingDate: '2024-10-04' }).openingDate, null);
  assert.equal(d.wosStartDates({ previewsStartDate: '2024-10-04', openingDate: '2024-12-08' }).openingDate, null);
});

const rv = (...dates) => dates.map((publishDate) => ({ publishDate }));

test('press night = most common review date minus one day', () => {
  // Dear Evan Hansen West End: first preview 2019-10-29, reviews mostly dated 11-20, press night 11-19.
  assert.equal(d.pressNightFromReviewMode('2019-10-29', rv('2019-11-20', '2019-11-20', '2019-11-20', '2019-11-21', '2019-11-24')), '2019-11-19');
});

test('no inference from a thin, tied or out-of-window set', () => {
  assert.equal(d.pressNightFromReviewMode('2019-10-29', rv('2019-11-20', '2019-11-20')), null);
  assert.equal(d.pressNightFromReviewMode('2019-10-29', rv('2019-11-20', '2019-11-20', '2019-11-20', '2019-11-21', '2019-11-21', '2019-11-21')), null);
  assert.equal(d.pressNightFromReviewMode('2019-10-29', rv('2018-11-20', '2018-11-20', '2018-11-20')), null);
  assert.equal(d.pressNightFromReviewMode('2019-10-29', rv('2019-11', '2019-11', '2019-11')), null);
});

test('repairWosOpening moves the first performance to previews and dates the press night', () => {
  const show = { id: 'x', discoverySource: 'we-historical:wos', previewsStartDate: null, openingDate: '2019-10-29', openingDateSource: 'whatsonstage' };
  assert.deepEqual(d.repairWosOpening(show, rv('2019-11-20', '2019-11-20', '2019-11-20')), [
    { field: 'previewsStartDate', oldValue: null, newValue: '2019-10-29' },
    { field: 'openingDate', oldValue: '2019-10-29', newValue: '2019-11-19' },
    { field: 'openingDateSource', oldValue: 'whatsonstage', newValue: d.MODE_INFERENCE_SOURCE },
  ]);
  // No cluster: collapse and mark unconfirmed so the daily pass can still correct it.
  assert.deepEqual(d.repairWosOpening(show, []), [
    { field: 'previewsStartDate', oldValue: null, newValue: '2019-10-29' },
    { field: 'openingDateSource', oldValue: 'whatsonstage', newValue: d.WOS_FIRST_PERFORMANCE_SOURCE },
  ]);
});

test('repairWosOpening leaves rows outside the class alone', () => {
  const base = { discoverySource: 'we-historical:wos', previewsStartDate: null, openingDate: '2019-10-29', openingDateSource: 'whatsonstage' };
  assert.deepEqual(d.repairWosOpening({ ...base, previewsStartDate: '2019-10-20' }, []), []);
  assert.deepEqual(d.repairWosOpening({ ...base, discoverySource: 'we-historical:tr' }, []), []);
  assert.deepEqual(d.repairWosOpening({ ...base, openingDateSource: 'theatremonkey' }, []), []);
});

test('pressNightFromReviewMode never returns a Sunday (BRO-6453)', () => {
  const rv = (...d) => d.map((publishDate) => ({ publishDate }));
  assert.equal(d.pressNightFromReviewMode('2016-11-01', rv('2016-11-14', '2016-11-14', '2016-11-14')), null);
  assert.equal(d.pressNightFromReviewMode('2016-11-01', rv('2016-11-15', '2016-11-15', '2016-11-15')), '2016-11-14');
});
