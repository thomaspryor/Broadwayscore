/**
 * Unit tests for recordUrlMismatch audit-log helper in scripts/lib/scraper.js.
 *
 * Context: During Joe Turner 2009 recovery, Variety's review canonical-redirected
 * from /legit/reviews/... to /film/awards/.... The scraper correctly rejects the
 * response as url_mismatch (preserving the soft-404/homepage-redirect guard), but
 * we now record each such rejection in data/audit/url-mismatch-suspects.json for
 * human review to distinguish canonical CMS moves from real wrong-article redirects.
 *
 * These tests verify:
 * 1. recordUrlMismatch appends valid JSON records to the audit file.
 * 2. File is created from scratch when missing.
 * 3. Malformed file is reset (with a warning) rather than crashing.
 * 4. File is capped at 10,000 entries (oldest dropped).
 * 5. Entries have the expected schema fields.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// We need to override the audit path so the test writes to a temp dir, not the
// actual data/audit/ directory. The helper uses a module-level constant, so we
// have to monkey-patch the path after require. Instead, we call recordUrlMismatch
// and then redirect via a temp dir by temporarily rewriting the constant via
// module internals — but since the constant is not exported, easiest approach is
// to just exercise the real path in a temp sub-directory by symlinking or by
// calling the real exported function and verifying data/audit/ gets the file.
//
// For isolation we use a different approach: write to /tmp and verify the helper
// itself works correctly by requiring the module with a patched __dirname alias.
// Since that's complex with CJS modules, we call the real function and then clean
// up the real audit file in afterEach.

const scraper = require('../../scripts/lib/scraper');

// Locate the real audit file path so we can clean up
const AUDIT_PATH = path.join(
  path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))),
  'data', 'audit', 'url-mismatch-suspects.json'
);

// Save any pre-existing contents so tests don't destroy real data
let _preExistingContents = null;

describe('recordUrlMismatch audit log', () => {
  beforeEach(() => {
    // Preserve whatever exists before the test
    try {
      _preExistingContents = fs.readFileSync(AUDIT_PATH, 'utf8');
    } catch {
      _preExistingContents = null;
    }
    // Remove the audit file so each test starts clean
    try { fs.unlinkSync(AUDIT_PATH); } catch { /* ok if not found */ }
  });

  afterEach(() => {
    // Restore pre-existing contents (or remove the file if it didn't exist before)
    if (_preExistingContents !== null) {
      fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
      fs.writeFileSync(AUDIT_PATH, _preExistingContents);
    } else {
      try { fs.unlinkSync(AUDIT_PATH); } catch { /* ok */ }
    }
  });

  test('creates the file and appends one record when missing', () => {
    scraper.recordUrlMismatch(
      'https://variety.com/2009/legit/reviews/joe-turner-s-come-and-gone-1117940153/',
      'https://variety.com/2009/film/awards/joe-turner-s-come-and-gone-1200474530/',
      'Bright Data',
      'variety.com'
    );

    assert.ok(fs.existsSync(AUDIT_PATH), 'audit file should be created');
    const entries = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.ok(Array.isArray(entries), 'audit file should contain a JSON array');
    assert.equal(entries.length, 1);

    const entry = entries[0];
    assert.equal(entry.requestedUrl, 'https://variety.com/2009/legit/reviews/joe-turner-s-come-and-gone-1117940153/');
    assert.equal(entry.actualUrl, 'https://variety.com/2009/film/awards/joe-turner-s-come-and-gone-1200474530/');
    assert.equal(entry.source, 'Bright Data');
    assert.equal(entry.hostname, 'variety.com');
    assert.ok(entry.fetchedAt, 'fetchedAt should be set');
    // fetchedAt should be a valid ISO date string
    assert.ok(!isNaN(Date.parse(entry.fetchedAt)), `fetchedAt should be a valid ISO date (got: ${entry.fetchedAt})`);
  });

  test('appends to existing entries', () => {
    // Pre-populate the file with one entry
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    const existing = [{
      requestedUrl: 'https://example.com/a',
      actualUrl: 'https://example.com/b',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      source: 'ScrapingBee',
      hostname: 'example.com',
    }];
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(existing, null, 2));

    scraper.recordUrlMismatch(
      'https://variety.com/second',
      'https://variety.com/redirected',
      'Cookie-plain',
      'variety.com'
    );

    const entries = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.equal(entries.length, 2, 'should have 2 entries after append');
    assert.equal(entries[0].requestedUrl, 'https://example.com/a');
    assert.equal(entries[1].requestedUrl, 'https://variety.com/second');
  });

  test('resets malformed file gracefully', () => {
    // Write invalid JSON to the audit file
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, 'NOT VALID JSON }{');

    // Should not throw
    assert.doesNotThrow(() => {
      scraper.recordUrlMismatch(
        'https://example.com/a',
        'https://example.com/b',
        'Playwright',
        'example.com'
      );
    });

    // File should now contain a valid array with the new entry
    const entries = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 1);
  });

  test('caps entries at 10000 (drops oldest)', () => {
    // Create a file with exactly 10000 entries
    const entries = Array.from({ length: 10000 }, (_, i) => ({
      requestedUrl: `https://example.com/old-${i}`,
      actualUrl: `https://example.com/canon-${i}`,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      source: 'Bright Data',
      hostname: 'example.com',
    }));
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(entries, null, 2));

    // Add one more — should drop the oldest
    scraper.recordUrlMismatch(
      'https://example.com/new',
      'https://example.com/new-canon',
      'ScrapingBee',
      'example.com'
    );

    const result = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.equal(result.length, 10000, 'should still be at cap after adding one');
    assert.equal(result[result.length - 1].requestedUrl, 'https://example.com/new', 'newest entry should be last');
    assert.equal(result[0].requestedUrl, 'https://example.com/old-1', 'oldest entry (old-0) should have been dropped');
  });

  test('non-array file is reset, not appended to', () => {
    // Write a JSON object (not array) to the file
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify({ entries: [] }));

    scraper.recordUrlMismatch(
      'https://example.com/a',
      'https://example.com/b',
      'Playwright',
      'example.com'
    );

    const result = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    assert.ok(Array.isArray(result), 'file should be reset to an array');
    assert.equal(result.length, 1);
  });
});
