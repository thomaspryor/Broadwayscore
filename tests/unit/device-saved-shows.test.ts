/**
 * Signed-out My Shows lists the shows saved on this device (BRO-4903 item b).
 * Requires the real selector (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDeviceSavedShows, isShowClosed } from '../../src/lib/device-saved-shows';

const TODAY = '2026-10-15';
const lookup = {
  hamilton: { id: 'hamilton', title: 'Hamilton', status: 'open', closingDate: null },
  wicked: { id: 'wicked', title: 'Wicked', status: 'open' },
  cats: { id: 'cats', title: 'Cats', status: 'closed', closingDate: '2000-09-10' },
  // status not yet flipped by the pipeline, but the run has ended
  ended: { id: 'ended', title: 'Ended', status: 'open', closingDate: '2026-10-01' },
  soon: { id: 'soon', title: 'Soon', status: 'upcoming', closingDate: '2027-01-01' },
};

const ids = (rows: { show: { id: string } }[]) => rows.map(r => r.show.id);

test('an empty device list gives nothing to show', () => {
  assert.deepEqual(selectDeviceSavedShows([], lookup, TODAY), []);
});

test('one saved show resolves to its lookup row', () => {
  const rows = selectDeviceSavedShows([{ showId: 'hamilton', savedAt: 5 }], lookup, TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].show, lookup.hamilton);
  assert.equal(rows[0].savedAt, 5);
  assert.equal(rows[0].closed, false);
});

test('ids the lookup does not know are skipped silently', () => {
  const rows = selectDeviceSavedShows(
    [{ showId: 'gone-show', savedAt: 9 }, { showId: 'wicked', savedAt: 3 }, { showId: 'toString', savedAt: 2 }],
    lookup,
    TODAY,
  );
  assert.deepEqual(ids(rows), ['wicked']);
  // only unknown ids: nothing, no throw
  assert.deepEqual(selectDeviceSavedShows([{ showId: 'nope', savedAt: 1 }], lookup, TODAY), []);
});

test('a duplicated id appears once, at its latest save time', () => {
  const rows = selectDeviceSavedShows(
    [{ showId: 'wicked', savedAt: 1 }, { showId: 'hamilton', savedAt: 5 }, { showId: 'wicked', savedAt: 10 }],
    lookup,
    TODAY,
  );
  assert.deepEqual(ids(rows), ['wicked', 'hamilton']);
  assert.equal(rows[0].savedAt, 10);
});

test('open shows come first (newest save first), closed shows after', () => {
  const rows = selectDeviceSavedShows(
    [
      { showId: 'cats', savedAt: 100 },
      { showId: 'hamilton', savedAt: 10 },
      { showId: 'ended', savedAt: 50 },
      { showId: 'soon', savedAt: 30 },
      { showId: 'wicked', savedAt: 20 },
    ],
    lookup,
    TODAY,
  );
  assert.deepEqual(ids(rows), ['soon', 'wicked', 'hamilton', 'cats', 'ended']);
  assert.deepEqual(rows.map(r => r.closed), [false, false, false, true, true]);
});

test('closed means closed status or a closing date before today', () => {
  assert.equal(isShowClosed({ id: 'a', status: 'closed' }, TODAY), true);
  assert.equal(isShowClosed({ id: 'a', status: 'open', closingDate: '2026-10-14' }, TODAY), true);
  assert.equal(isShowClosed({ id: 'a', status: 'open', closingDate: TODAY }, TODAY), false);
  assert.equal(isShowClosed({ id: 'a', status: 'open', closingDate: '2026-10-20T00:00:00Z' }, TODAY), false);
  assert.equal(isShowClosed({ id: 'a', status: 'previews', closingDate: null }, TODAY), false);
});
