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
  const { entries } = await acquireFromMezzanine(fileOf(exportJson));
  assert.deepEqual(entries.map((e) => e.title), ['Hadestown', 'Oh, Mary!', 'Maybe Happy Ending']);
  assert.equal(entries[0].date, '2024-05-01');
  assert.equal(entries[0].rating, 4.5);
  assert.equal(entries[1].date, null);
});
