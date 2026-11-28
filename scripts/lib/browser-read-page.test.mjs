// BRO-7262: a challenge page that redirects mid-read destroyed the read's context and lost the review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readBrowserPage, isNavigationRace } = require('./browser-read-page.js');

const NAV = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';

/** A fake Playwright page whose first `failFirst` reads throw the navigation error. */
function fakePage({ failFirst = 1, body = 'Theatre Review by Karen Topham '.repeat(30) } = {}) {
  let calls = 0;
  const boom = () => { calls++; if (calls <= failFirst) throw new Error(NAV); };
  return {
    goto: async () => ({ status: () => 200 }),
    title: async () => { boom(); return 'Talkin Broadway Regional Chicago - "Adirondack Chair Circle"'; },
    evaluate: async (fn) => { boom(); return fn.toString().includes('innerText') ? body : fn.toString().includes('canonical') ? null : []; },
    content: async () => { boom(); return `<html><body>${body}</body></html>`; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://example.test/ch944.html',
  };
}

const CONTENT_NAV = 'page.content: Unable to retrieve content because the page is navigating and changing the content.';

test('isNavigationRace matches the Playwright navigation errors only', () => {
  assert.equal(isNavigationRace(new Error(NAV)), true);
  assert.equal(isNavigationRace(new Error(CONTENT_NAV)), true);
  assert.equal(isNavigationRace(new Error('Target page, context or browser has been closed')), false);
  assert.equal(isNavigationRace(new Error('net::ERR_TIMED_OUT')), false);
});

test('a redirect during the read is retried and the page still comes back', async () => {
  const r = await readBrowserPage(fakePage({ failFirst: 1 }), 'https://example.test/ch944.html');
  assert.equal(r.status, 200);
  assert.ok(r.html.includes('Karen Topham'));
  assert.equal(r.challenge, false);
});

test('a non-navigation error still throws', async () => {
  const page = fakePage({ failFirst: 0 });
  page.content = async () => { throw new Error('net::ERR_TIMED_OUT'); };
  await assert.rejects(readBrowserPage(page, 'https://example.test/x'), /ERR_TIMED_OUT/);
});

test('a redirect during the final content() read is retried too', async () => {
  const page = fakePage({ failFirst: 0 });
  let n = 0;
  page.content = async () => { n++; if (n === 1) throw new Error(CONTENT_NAV); return '<html><body>Theatre Review by Karen Topham</body></html>'; };
  const r = await readBrowserPage(page, 'https://example.test/ch944.html');
  assert.ok(r.html.includes('Karen Topham'));
  assert.equal(n, 2);
});

test('endless navigation gives up after 4 attempts instead of looping', async () => {
  const page = fakePage({ failFirst: 0 });
  let n = 0;
  page.title = async () => { n++; throw new Error(NAV); };
  await assert.rejects(readBrowserPage(page, 'https://example.test/x'), /Execution context was destroyed/);
  assert.equal(n, 4);
});
