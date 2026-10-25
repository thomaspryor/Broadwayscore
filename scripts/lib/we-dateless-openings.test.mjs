import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { judgeLookup, planFromLookups } = require('./we-dateless-openings.js');

const tr = { link: 'https://www.theatrerecord.com/archive/2024/10/x' };
const show = { id: 'a-west-end-2024', previewsStartDate: '2024-09-20', closingDate: '2024-12-21' };
const hdr = d => `TITLE\nPreviews 20 Sep 2024\nPress night ${d}\nCloses 21 Dec 2024`;

test('accepts a press night inside the run', () => {
  assert.deepEqual(judgeLookup({ tr, header: hdr('01 Oct 2024') }, show), { accept: '2024-10-01' });
});
test('rejects a press night from another production (outside the run)', () => {
  // The header parser already drops a press night outside the printed run.
  assert.ok(judgeLookup({ tr, header: hdr('07 Sep 2017') }, show).reject);
  assert.ok(judgeLookup({ tr, header: hdr('30 Jan 2025') }, show).reject);
  // A header with no previews of its own is checked against the row's run.
  const bare = d => `TITLE\nPress night ${d}`;
  assert.match(judgeLookup({ tr, header: bare('07 Sep 2024') }, show).reject, /before previews/);
  assert.match(judgeLookup({ tr, header: bare('30 Jan 2025') }, show).reject, /after closing|more than/);
});
test('rejects when TR matched nothing, has no header or no press night', () => {
  assert.match(judgeLookup({ tr: null }, show).reject, /no TR production/);
  assert.match(judgeLookup({ tr, header: null }, show).reject, /no dated header/);
  assert.match(judgeLookup({ tr, header: 'TITLE\nPreviews 20 Sep 2024' }, show).reject, /no press night/);
});
test('rejects a row with no previews start, and a press night before previews', () => {
  const bare = d => `TITLE\nPress night ${d}`;
  const noPrev = { id: 'x', closingDate: '2026-05-16' };
  assert.match(judgeLookup({ tr, header: bare('10 Jan 2026') }, noPrev).reject, /no previews start/);
  assert.match(judgeLookup({ tr, header: bare('19 Sep 2024') }, show).reject, /before previews/);
});
test('rejects a row that already has an openingDate', () => {
  assert.match(judgeLookup({ tr, header: hdr('01 Oct 2024') }, { ...show, openingDate: '2024-10-01' }).reject, /already/);
});
test('planFromLookups splits accepted and rejected', () => {
  const file = { lookups: [{ review: { showId: show.id }, tr, header: hdr('01 Oct 2024') }, { review: { showId: 'nope' } }] };
  const p = planFromLookups(file, [show]);
  assert.equal(p.edits.length, 1);
  assert.equal(p.rejected.length, 1);
});

test('rejects unparseable dates, a header run that disagrees with the row, and shared TR pages', () => {
  const bad = { id: 'x', previewsStartDate: 'garbage', closingDate: '2026-05-16' };
  const hdrOk = 'TITLE\nPress night 10 Jan 2025';
  assert.match(judgeLookup({ tr, header: hdrOk }, bad).reject, /unparseable/);
  const rows = ['a', 'b'].map(id => ({ review: { showId: id }, tr: { link: 'https://tr/one' }, header: hdrOk }));
  const shows = ['a', 'b'].map(id => ({ id, previewsStartDate: '2025-01-03', closingDate: '2025-03-01' }));
  const plan = planFromLookups({ lookups: rows }, shows);
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.rejected.length, 2);
});
