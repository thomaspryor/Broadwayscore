/**
 * Shared Plans privacy (BRO-4481): links out of /plans/<token> must load a new
 * document so GA never sees the plans URL as a client-side page_referrer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { documentNavigationFor, type LinkClick } from '../../src/lib/analytics/leave-by-document';

const HERE = 'https://broadwayscorecard.com/plans/abcdefabcdefabcdefabcdefabcdef12';
const click = (over: Partial<LinkClick>): LinkClick => ({
  href: '/show/wicked-2003', currentHref: HERE, target: null, download: false,
  button: 0, modified: false, defaultPrevented: false, ...over,
});

test('same-site links become document loads', () => {
  assert.equal(documentNavigationFor(click({})), 'https://broadwayscorecard.com/show/wicked-2003');
  assert.equal(documentNavigationFor(click({ href: '/' })), 'https://broadwayscorecard.com/');
  assert.equal(documentNavigationFor(click({ href: 'https://broadwayscorecard.com/browse?x=1' })), 'https://broadwayscorecard.com/browse?x=1');
  assert.equal(documentNavigationFor(click({ target: '_self' })), 'https://broadwayscorecard.com/show/wicked-2003');
});

test('everything else keeps the browser default', () => {
  assert.equal(documentNavigationFor(click({ href: null })), null);
  assert.equal(documentNavigationFor(click({ href: 'https://calendar.google.com/x' })), null, 'off-site');
  assert.equal(documentNavigationFor(click({ href: '/api/calendar.ics?d=2026-10-06' })), null, '.ics download');
  assert.equal(documentNavigationFor(click({ target: '_blank' })), null, 'new tab');
  assert.equal(documentNavigationFor(click({ download: true })), null);
  assert.equal(documentNavigationFor(click({ modified: true })), null, 'cmd/ctrl-click');
  assert.equal(documentNavigationFor(click({ button: 1 })), null, 'middle click');
  assert.equal(documentNavigationFor(click({ defaultPrevented: true })), null);
  assert.equal(documentNavigationFor(click({ href: '#top' })), null, 'in-page anchor');
  assert.equal(documentNavigationFor(click({ href: 'javascript:void(0)' })), null);
});
