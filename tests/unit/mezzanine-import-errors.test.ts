/**
 * Mezzanine import file handling (src/lib/show-import.ts acquireFromMezzanine).
 *
 * The thrown message is shown on screen and sent as import_failed's
 * error_message, so a bad file must produce the fixed plain-English copy and
 * never JSON.parse's own message, which quotes part of the file (BRO-4525).
 *
 * Run: npx tsx --test tests/unit/mezzanine-import-errors.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireFromMezzanine, MEZZANINE_FILE_ERROR } from '../../src/lib/show-import';

const fileOf = (text: string) => ({ text: async () => text }) as unknown as File;

test('a file that is not JSON gets the fixed copy, with none of its content', async () => {
  const secret = 'my private diary note about Hamilton';
  await assert.rejects(acquireFromMezzanine(fileOf(`${secret} {`)), (err: Error) => {
    assert.equal(err.message, MEZZANINE_FILE_ERROR);
    assert.ok(!err.message.includes('Hamilton'));
    return true;
  });
});

test('JSON without diary entries gets the same copy', async () => {
  await assert.rejects(acquireFromMezzanine(fileOf('{"data":{}}')), { message: MEZZANINE_FILE_ERROR });
  await assert.rejects(acquireFromMezzanine(fileOf('null')), { message: MEZZANINE_FILE_ERROR });
  await assert.rejects(acquireFromMezzanine(fileOf('{"data":{"diaryEntries":"x"}}')), { message: MEZZANINE_FILE_ERROR });
});

test('malformed rows are skipped and the good ones still import', async () => {
  const exportJson = JSON.stringify({
    data: {
      diaryEntries: [
        { show: { name: 'Hadestown', id: 'm1' }, rating: 4.5, date: '2024-05-01T00:00:00Z', review: null },
        { rating: 3, date: '2024-05-02' },
        { show: { name: 'Oh, Mary!' }, rating: null, date: 12345, review: null },
      ],
      lists: [{ name: 'Want', shows: [{ name: 'Maybe Happy Ending' }, {}] }, { name: 'Broken' }],
    },
  });
  const { entries, notices } = await acquireFromMezzanine(fileOf(exportJson));
  assert.deepEqual(entries.map((e) => e.title), ['Hadestown', 'Oh, Mary!', 'Maybe Happy Ending']);
  // The showless diary row and the empty list show are told to the user.
  assert.deepEqual(notices, ['2 entries in the file had no readable show name and were skipped.']);
  assert.equal(entries[0].date, '2024-05-01');
  assert.equal(entries[0].rating, 4.5);
  assert.equal(entries[1].date, null);
});

// A non-string title used to reach normTitle in ImportShows and throw
// "t.toLowerCase is not a function" into the UI and analytics.
test('rows with non-string fields are skipped or blanked, never passed through', async () => {
  const exportJson = JSON.stringify({
    data: {
      diaryEntries: [
        { show: { name: 42, id: 'm2' }, rating: 4, date: '2024-05-01' },
        { show: { name: 'Cabaret', id: 7 }, rating: '5', date: '2024-05-03', review: { text: 'x' }, production: { theater: { name: ['x'] } } },
      ],
      lists: [{ name: 9, shows: [{ name: { en: 'Wicked' } }, { name: 'Wicked' }] }],
    },
  });
  const { entries, notices } = await acquireFromMezzanine(fileOf(exportJson));
  assert.deepEqual(entries.map((e) => e.title), ['Cabaret', 'Wicked']);
  assert.deepEqual(notices, ['2 entries in the file had no readable show name and were skipped.']);
  const cabaret = entries[0];
  assert.equal(cabaret.rating, null, 'a string rating is not a rating');
  assert.equal(cabaret.reviewText, null);
  assert.equal(cabaret.venue, null);
  assert.equal(cabaret.mezzShowId, undefined);
  assert.equal(entries[1].listName, undefined);
});

test('a clean export carries no skip notice, and one bad row reads in the singular', async () => {
  const clean = JSON.stringify({ data: { diaryEntries: [{ show: { name: 'Hadestown' }, rating: 4, date: '2024-05-01' }] } });
  assert.deepEqual((await acquireFromMezzanine(fileOf(clean))).notices, []);
  const oneBad = JSON.stringify({ data: { diaryEntries: [{ show: { name: 'Hadestown' } }, { show: {} }] } });
  assert.deepEqual((await acquireFromMezzanine(fileOf(oneBad))).notices, ['1 entry in the file had no readable show name and was skipped.']);
});
