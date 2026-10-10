/**
 * Unit tests for review-write-guard hasPlaceholderUrlPattern (S1-T2)
 *
 * Motivation: Joe Turner 2009 catalog audit (2026-04-26) found 8 review files
 * with fabricated WSJ legacy-ID URLs containing sequential-digit placeholder
 * patterns. These tests verify the detector and its write-time integration.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { hasPlaceholderUrlPattern, safeWriteReview } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwg-placeholder-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hasPlaceholderUrlPattern — unit checks', () => {
  test('WSJ fake legacy ID with 1234 sequential run → TRUE', () => {
    // Joe Turner investigaton: SB1234… is a fabricated placeholder
    assert.equal(
      hasPlaceholderUrlPattern('https://www.wsj.com/articles/SB123944876543210987'),
      true,
      'WSJ SB-prefixed ID containing "1234" sequential run should be flagged'
    );
  });

  test('real WSJ legacy ID (long, non-sequential) → FALSE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://www.wsj.com/articles/SB10001424052748703555004574482420697854228'),
      false,
      'Real WSJ legacy IDs are long and non-sequential — must not be flagged'
    );
  });

  test('real Variety numeric slug → FALSE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://variety.com/2009/film/awards/joe-turner-s-come-and-gone-1200474530/'),
      false,
      'Real Variety numeric IDs are not sequential placeholders'
    );
  });

  test('AP News path with 1234567 sequential run → TRUE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://apnews.com/article/foo/1234567/'),
      true,
      'Generic 7-digit sequential placeholder in path should be flagged'
    );
  });

  test('URL with 9-digit sequential run → TRUE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://example.com/article/123456789012345678'),
      true,
      'URL with 9-digit sequential placeholder should be flagged'
    );
  });

  test('"1234" in isolation (not a sequential run) → FALSE', () => {
    // "1234" alone is 4 digits — below the 7-digit threshold for generic sequential
    // and doesn't match WSJ pattern (no wsj.com domain). abc-1234-def is benign.
    assert.equal(
      hasPlaceholderUrlPattern('https://example.com/article/abc-1234-def'),
      false,
      '"1234" in isolation is below the sequential-run threshold'
    );
  });

  test('null url → FALSE (no crash)', () => {
    assert.equal(
      hasPlaceholderUrlPattern(null),
      false,
      'null must not throw and must return false'
    );
  });

  test('empty string → FALSE (no crash)', () => {
    assert.equal(
      hasPlaceholderUrlPattern(''),
      false,
      'empty string must not throw and must return false'
    );
  });

  test('USA Today path ending in 7-digit placeholder → TRUE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://www.usatoday.com/story/life/theater/2009/10/06/hamlet-broadway-review/1234567/'),
      true,
      'Path segment ending in 7-digit sequential run should be flagged'
    );
  });
});

describe('hasPlaceholderUrlPattern — additional edge cases', () => {
  test('WSJ SB2345 sequential variant → TRUE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://www.wsj.com/articles/SB23456789'),
      true,
      'WSJ ID with "2345" sequential run should be flagged'
    );
  });

  test('non-WSJ URL with SB-prefixed 7-digit sequential → TRUE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://example.com/articles/SB1234567'),
      true,
      'SB-prefixed 7-digit sequential pattern in any domain should be flagged'
    );
  });

  test('real AP News article ID (non-sequential hex) → FALSE', () => {
    assert.equal(
      hasPlaceholderUrlPattern('https://apnews.com/article/theater-review-a3f8b2c1d9e4'),
      false,
      'Real hex-style AP News IDs are not sequential placeholders'
    );
  });
});

describe('hasPlaceholderUrlPattern — write-time integration (safeWriteReview)', () => {
  test('safeWriteReview sets urlPlaceholderSuspect=true on placeholder URL', () => {
    const filePath = path.join(tmpDir, 'wsj-fake.json');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      safeWriteReview(filePath, {
        showId: 'joe-turner-2009',
        outletId: 'wsj',
        criticName: 'Terry Teachout',
        url: 'https://www.wsj.com/articles/SB123944876543210987',
      });
    } finally {
      console.warn = originalWarn;
    }

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(written.urlPlaceholderSuspect, true, 'urlPlaceholderSuspect must be true for placeholder URL');
    assert.ok(
      warnings.some(w => w.includes('[review-write-guard] placeholder URL detected')),
      `Expected placeholder URL warning, got: ${JSON.stringify(warnings)}`
    );
  });

  test('safeWriteReview does NOT block the write — review is still saved', () => {
    // FLAG-ONLY: the write must complete even when the URL is suspicious
    const filePath = path.join(tmpDir, 'placeholder-still-writes.json');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = safeWriteReview(filePath, {
        showId: 'joe-turner-2009',
        url: 'https://www.wsj.com/articles/SB123944876543210987',
        fullText: 'Some review text',
      });
      assert.equal(result.wrote, true, 'safeWriteReview must return wrote=true even for placeholder URL');
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(fs.existsSync(filePath), 'File must exist on disk — write was not blocked');
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(written.fullText, 'Some review text', 'Payload data must survive the write');
  });

  test('safeWriteReview does NOT set urlPlaceholderSuspect on a real URL', () => {
    const filePath = path.join(tmpDir, 'real-url.json');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      safeWriteReview(filePath, {
        showId: 'joe-turner-2009',
        outletId: 'wsj',
        url: 'https://www.wsj.com/articles/SB10001424052748703555004574482420697854228',
      });
    } finally {
      console.warn = originalWarn;
    }

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.ok(
      !written.urlPlaceholderSuspect,
      'Real WSJ URL must NOT be flagged as a placeholder'
    );
  });

  test('safeWriteReview with no url field — no urlPlaceholderSuspect set', () => {
    const filePath = path.join(tmpDir, 'no-url.json');
    safeWriteReview(filePath, { showId: 'test', outletId: 'nyt' });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.ok(
      !written.urlPlaceholderSuspect,
      'Review without url field must not have urlPlaceholderSuspect set'
    );
  });
});
