import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyTimeoutPage } = require('./timeout-capsule.js');

// Invented page: Time Out "review by" byline, no real review text.
const page = (by) => `<html><body><h2>Time Out says</h2><p>Theater review by ${by} Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p><p>Details</p></body></html>`;
const URL_OK = 'https://www.timeout.com/newyork/theater/the-unbelievers-off-broadway-review-lauren-ambrose';

test('BRO-7044: byline differs from row critic but url is the show review -> review, byline wins', () => {
  const r = classifyTimeoutPage({ html: page('Billy McEntee'), critic: 'Adam Feldman', showYear: 2026, url: URL_OK, showTitle: 'The Unbelievers' });
  assert.equal(r.verdict, 'review');
  assert.equal(r.byline, 'Billy McEntee');
});
test('BRO-7044: without a url/title (or a non-review slug) the wrong_critic verdict stands (BRO-5222)', () => {
  assert.equal(classifyTimeoutPage({ html: page('Billy McEntee'), critic: 'Adam Feldman', showYear: 2026 }).verdict, 'wrong_critic');
  assert.equal(classifyTimeoutPage({ html: page('Billy McEntee'), critic: 'Adam Feldman', showYear: 2026, url: 'https://www.timeout.com/newyork/theater/the-unbelievers', showTitle: 'The Unbelievers' }).verdict, 'wrong_critic');
  assert.equal(classifyTimeoutPage({ html: page('Billy McEntee'), critic: 'Adam Feldman', showYear: 2012, url: URL_OK, showTitle: 'The Unbelievers' }).verdict, 'wrong_critic');
});
test('matching byline is unchanged', () => {
  assert.equal(classifyTimeoutPage({ html: page('Adam Feldman'), critic: 'Adam Feldman', showYear: 2026, url: URL_OK, showTitle: 'The Unbelievers' }).verdict, 'review');
});
