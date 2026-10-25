// BRO-5599: closed Broadway runs the scrapers never tracked have no grosses.json
// entry, so the all-time total stayed blank on /biz although the weekly rows
// covered the whole run. The attribution step now fills them, and the audit
// flags any that are still missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyAllTimeAttribution, closedRunsMissingAllTime } = require('../../scripts/lib/alltime-attribution.js');

const NOW = new Date('2026-10-01T00:00:00Z');
const show = (slug, previews, closing) => ({
  id: slug, slug, category: 'broadway', previewsStartDate: previews, openingDate: previews, closingDate: closing,
});
const ROW = { gross: 1_000_000, performances: 8, attendance: 8000 };
// Sunday week-endings from `from` to `to`; `skip` weeks are left out (a scrape gap).
function hist(slug, from, to, skip = []) {
  const weeks = {};
  for (let t = Date.parse(from); t <= Date.parse(to); t += 7 * 86400000) {
    const w = new Date(t).toISOString().slice(0, 10);
    if (!skip.includes(w)) weeks[w] = { [slug]: { ...ROW } };
  }
  // The real history starts in December 2001; another show's week stands in for it.
  weeks['2001-12-02'] = { other: { ...ROW } };
  return { weeks };
}

test('a closed run with no grosses entry and complete weekly rows gets its own total', () => {
  const s = show('revival-2022', '2022-03-13', '2022-06-05');
  const history = hist('revival-2022', '2022-03-13', '2022-06-05');
  const g = {};
  const { fills } = applyAllTimeAttribution(g, [s], { now: NOW, history });
  assert.equal(fills.length, 1);
  assert.equal(g['revival-2022'].allTime.gross, 13_000_000);
  assert.equal(g['revival-2022'].allTimeSource, 'history');
  assert.deepEqual(closedRunsMissingAllTime(g, [s], history, { now: NOW }), []);
});

test('rows with a missing week are not summed (a short total would be wrong), and the audit does not list them', () => {
  const s = show('gappy-2022', '2022-03-13', '2022-06-05');
  const history = hist('gappy-2022', '2022-03-13', '2022-06-05', ['2022-04-17']);
  const g = {};
  applyAllTimeAttribution(g, [s], { now: NOW, history });
  assert.equal(g['gappy-2022'], undefined);
  assert.deepEqual(closedRunsMissingAllTime(g, [s], history, { now: NOW }), []);
});

test('audit lists a complete closed run that still has no all-time gross', () => {
  const s = show('revival-2022', '2022-03-13', '2022-06-05');
  const history = hist('revival-2022', '2022-03-13', '2022-06-05');
  const missing = closedRunsMissingAllTime({}, [s], history, { now: NOW });
  assert.deepEqual(missing.map((m) => m.slug), ['revival-2022']);
  assert.deepEqual(closedRunsMissingAllTime({ 'revival-2022': { allTime: { gross: 5 } } }, [s], history, { now: NOW }), []);
});

test('open runs and non-Broadway shows never get a history total from the no-entry path', () => {
  const open = show('running-2026', '2026-01-04', null);
  const ob = { ...show('ob-2022', '2022-03-13', '2022-06-05'), category: 'off-broadway' };
  const history = { weeks: { ...hist('running-2026', '2026-01-04', '2026-09-27').weeks } };
  Object.assign(history.weeks, hist('ob-2022', '2022-03-13', '2022-06-05').weeks);
  const g = {};
  applyAllTimeAttribution(g, [open, ob], { now: NOW, history });
  assert.deepEqual(g, {});
});

test('a run that could predate the history (first rows at the history start) is left blank', () => {
  const s = show('early-2001', '2001-11-01', '2002-03-03');
  const history = hist('early-2001', '2001-12-09', '2002-03-03');
  const g = {};
  applyAllTimeAttribution(g, [s], { now: NOW, history });
  assert.equal(g['early-2001'], undefined);
});

test('an existing entry (real BWW row) is left alone by the no-entry path', () => {
  const s = show('revival-2022', '2022-03-13', '2022-06-05');
  const history = hist('revival-2022', '2022-03-13', '2022-06-05');
  const g = { 'revival-2022': { allTime: { gross: 99, performances: 9, attendance: 9 } } };
  applyAllTimeAttribution(g, [s], { now: NOW, history });
  assert.equal(g['revival-2022'].allTime.gross, 99);
});

test('the audit applies the same history-start guard as the fill (no permanent false flag)', () => {
  const s = show('early-2001', '2001-11-01', '2002-03-03');
  const history = hist('early-2001', '2001-12-09', '2002-03-03');
  assert.deepEqual(closedRunsMissingAllTime({}, [s], history, { now: NOW }), []);
});
