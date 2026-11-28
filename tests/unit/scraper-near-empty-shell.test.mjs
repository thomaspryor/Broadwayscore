// BRO-5874: bachtrack.com served CI runners a ~175-char rendered HTML shell that the
// Playwright tier reported as Success, so fetchPage stopped before BD/SB. The shell
// must count as garbage so the chain moves on; real pages and non-HTML must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNearEmptyHtmlShell } = require('../../scripts/lib/scraper.js');

const shell = '<!DOCTYPE html><html><head><title>Bachtrack</title></head><body><div id="root"></div><script>var a=1;</script></body></html>';

test('a near-empty rendered shell is garbage', () => {
  assert.equal(isNearEmptyHtmlShell(shell), true);
  assert.equal(isNearEmptyHtmlShell('<html><body>Just a moment...</body></html>'), true);
});

test('a page with a real article body is not garbage', () => {
  const body = '<html><body><article><p>' + 'A fine and thoughtful review of the opera. '.repeat(10) + '</p></article></body></html>';
  assert.equal(isNearEmptyHtmlShell(body), false);
});

test('non-HTML, empty, redirect wrappers and JSON views are never judged', () => {
  assert.equal(isNearEmptyHtmlShell(''), false);
  assert.equal(isNearEmptyHtmlShell(null), false);
  assert.equal(isNearEmptyHtmlShell('{"ok":true}'), false);
  assert.equal(isNearEmptyHtmlShell('<html><head><meta http-equiv="refresh" content="0;url=x"></head><body></body></html>'), false);
  assert.equal(isNearEmptyHtmlShell('<html><body><pre>{"a":1}</pre></body></html>'), false);
});

test('a page of 5KB or more is never judged a shell', () => {
  assert.equal(isNearEmptyHtmlShell('<html><body>' + '<script>x</script>'.repeat(400) + '</body></html>'), false);
});
