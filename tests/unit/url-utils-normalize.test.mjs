/**
 * Unit tests for normalizeUrl (task #704, cousin of #702's verifyFetchedUrl fix)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeUrl, stripInvisibleUnicode } = require('../../scripts/lib/url-utils');

describe('normalizeUrl', () => {
  describe('invisible Unicode stripping', () => {
    test('theatre.reviews trailing U+200E strips and matches non-marked version', () => {
      const withMark = 'https://theatre.reviews/the-gin-game-review/‎';
      const withoutMark = 'https://theatre.reviews/the-gin-game-review/';
      assert.equal(normalizeUrl(withMark), normalizeUrl(withoutMark));
    });

    test('zero-width space mid-path strips', () => {
      const withZwsp = 'https://example.com/re​view';
      const clean = 'https://example.com/review';
      assert.equal(normalizeUrl(withZwsp), normalizeUrl(clean));
    });

    test('BOM prefix strips', () => {
      const withBom = '﻿https://example.com/review';
      const clean = 'https://example.com/review';
      assert.equal(normalizeUrl(withBom), normalizeUrl(clean));
    });

    test('RTL/LTR embedding and override marks strip', () => {
      const withMarks = 'https://example.com/‪review‬';
      const clean = 'https://example.com/review';
      assert.equal(normalizeUrl(withMarks), normalizeUrl(clean));
    });

    test('stripInvisibleUnicode is exported and strips directly', () => {
      assert.equal(stripInvisibleUnicode('foo‎bar'), 'foobar');
    });
  });

  describe('existing behavior unchanged', () => {
    test('strips query string', () => {
      assert.equal(normalizeUrl('https://example.com/review?utm_source=x'), 'https://example.com/review');
    });

    test('lowercases', () => {
      assert.equal(normalizeUrl('https://Example.COM/Review'), 'https://example.com/review');
    });

    test('removes trailing slash', () => {
      assert.equal(normalizeUrl('https://example.com/review/'), 'https://example.com/review');
    });

    test('combined query + case + trailing slash', () => {
      assert.equal(
        normalizeUrl('https://Example.com/Review/?utm_source=x'),
        'https://example.com/review'
      );
    });

    test('non-string input falls back to input via catch', () => {
      assert.equal(normalizeUrl(null), null);
    });
  });
});
