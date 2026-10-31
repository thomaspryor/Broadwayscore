/**
 * Regression test for Rocky Horror 2026-04-23 opening-night #11.
 *
 * cote-notices--david-finkle.json was manually deleted; the poller rediscovered
 * the same URL (with a ?triedRedirect tracking param) 2h later and re-created
 * the file. The _blocklist.json mechanism lets deletions stick.
 *
 * Run: node --test tests/unit/poller-blocklist.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadBlocklist, isBlocked, findBlockedEntry } = require('../../scripts/lib/poller-blocklist.js');

let tmpShowDir;

before(() => {
  tmpShowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-'));
});

after(() => {
  fs.rmSync(tmpShowDir, { recursive: true, force: true });
});

test('missing _blocklist.json returns empty set (no-op)', () => {
  const bl = loadBlocklist(tmpShowDir);
  assert.equal(bl.urls.size, 0);
  assert.equal(isBlocked(bl, 'https://any.example/article'), false);
});

test('blocks exact URL match', () => {
  fs.writeFileSync(path.join(tmpShowDir, '_blocklist.json'), JSON.stringify({
    urls: [{
      url: 'https://davidcote1.substack.com/p/the-rocky-horror-show',
      reason: 'duplicate of cote-notices--david-cote',
      blockedAt: '2026-04-23T22:00Z',
    }],
  }));
  const bl = loadBlocklist(tmpShowDir);
  assert.equal(bl.urls.size, 1);
  assert.equal(isBlocked(bl, 'https://davidcote1.substack.com/p/the-rocky-horror-show'), true);
  const entry = findBlockedEntry(bl, 'https://davidcote1.substack.com/p/the-rocky-horror-show');
  assert.equal(entry.reason, 'duplicate of cote-notices--david-cote');
});

test('normalizes tracking params (the Rocky Horror failure mode)', () => {
  const bl = loadBlocklist(tmpShowDir);
  // Same URL with ?triedRedirect=true appended — the poller's actual rediscovery
  assert.equal(isBlocked(bl, 'https://davidcote1.substack.com/p/the-rocky-horror-show?triedRedirect=true'), true);
  assert.equal(isBlocked(bl, 'https://davidcote1.substack.com/p/the-rocky-horror-show?utm_source=twitter'), true);
  assert.equal(isBlocked(bl, 'https://davidcote1.substack.com/p/the-rocky-horror-show?fbclid=abc'), true);
});

test('does not block unrelated URLs', () => {
  const bl = loadBlocklist(tmpShowDir);
  assert.equal(isBlocked(bl, 'https://davidcote1.substack.com/p/a-different-review'), false);
  assert.equal(isBlocked(bl, 'https://nytimes.com/2026/04/23/rocky-horror-review.html'), false);
});

test('accepts legacy bare-string form: { urls: ["https://..."] }', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-legacy-'));
  fs.writeFileSync(path.join(dir, '_blocklist.json'), JSON.stringify({
    urls: ['https://example.com/bad'],
  }));
  const bl = loadBlocklist(dir);
  assert.equal(isBlocked(bl, 'https://example.com/bad'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts top-level array form: [ { url, reason } ]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-array-'));
  fs.writeFileSync(path.join(dir, '_blocklist.json'), JSON.stringify([
    { url: 'https://example.com/bad', reason: 'test' },
  ]));
  const bl = loadBlocklist(dir);
  assert.equal(isBlocked(bl, 'https://example.com/bad'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('malformed JSON falls back to empty set without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-malformed-'));
  fs.writeFileSync(path.join(dir, '_blocklist.json'), '{not valid json');
  const bl = loadBlocklist(dir);
  assert.equal(bl.urls.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
