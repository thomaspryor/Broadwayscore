import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDuplicateUrls } = require('./show-score-url-map.js');

test('findDuplicateUrls: no duplicates when every url is unique', () => {
  const result = findDuplicateUrls({
    'show-a': 'https://www.show-score.com/broadway-shows/a',
    'show-b': 'https://www.show-score.com/broadway-shows/b',
  });
  assert.deepEqual(result, []);
});

test('findDuplicateUrls: flags two showIds sharing the same url', () => {
  const result = findDuplicateUrls({
    'wicked-west-end-2021': 'https://www.show-score.com/uk/london/west-end-shows/wicked-london',
    'wicked-west-end-2024': 'https://www.show-score.com/uk/london/west-end-shows/wicked-london',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://www.show-score.com/uk/london/west-end-shows/wicked-london');
  assert.deepEqual(result[0].showIds.sort(), ['wicked-west-end-2021', 'wicked-west-end-2024']);
});

test('findDuplicateUrls: casing/trailing-slash drift still collides (same Show Score page)', () => {
  const result = findDuplicateUrls({
    'show-a': 'https://www.Show-Score.com/broadway-shows/Foo/',
    'show-b': 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].showIds.sort(), ['show-a', 'show-b']);
});

test('findDuplicateUrls: a genuine 3-way collision is one group, not three pairs', () => {
  const result = findDuplicateUrls({
    a: 'https://www.show-score.com/broadway-shows/foo',
    b: 'https://www.show-score.com/broadway-shows/foo',
    c: 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].showIds.length, 3);
});

test('findDuplicateUrls: null/empty url entries are ignored, not treated as a shared "" key', () => {
  const result = findDuplicateUrls({
    a: null,
    b: '',
    c: undefined,
  });
  assert.deepEqual(result, []);
});

test('findDuplicateUrls: tolerates a missing/empty map', () => {
  assert.deepEqual(findDuplicateUrls({}), []);
  assert.deepEqual(findDuplicateUrls(undefined), []);
});

test('findDuplicateUrls: raw (non-normalized) url is preserved in the report', () => {
  const result = findDuplicateUrls({
    a: 'https://www.Show-Score.com/Broadway-Shows/Foo/',
    b: 'https://www.show-score.com/broadway-shows/foo',
  });
  assert.equal(result.length, 1);
  // Whichever entry is seen first wins — Object.entries preserves insertion order.
  assert.equal(result[0].url, 'https://www.Show-Score.com/Broadway-Shows/Foo/');
});
