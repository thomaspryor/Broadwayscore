import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Sample Tests', () => {
  test('basic arithmetic: 1 + 1 = 2', () => {
    assert.strictEqual(1 + 1, 2);
  });

  test('basic string operations', () => {
    const str = 'Hello, Broadway!';
    assert.ok(str.includes('Broadway'));
    assert.strictEqual(str.length, 16);
  });

  test('basic array operations', () => {
    const shows = ['Hamilton', 'Wicked', 'Chicago'];
    assert.strictEqual(shows.length, 3);
    assert.ok(shows.includes('Hamilton'));
  });
});
