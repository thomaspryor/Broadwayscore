import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkDtliCandidate } = require('../../scripts/lib/dtli-watcher-year-guard');
const show = { id: 'tristan-and-yseult-off-broadway-2026', openingDate: '2026-11-19' };
const page = (...years) => years.map(y => `<div class="review-item-date">December 14, ${y}</div>`).join('');

test('watcher refuses a prior production and accepts current or undated pages', async () => {
  for (const [html, allowed] of [[page(2014, 2014), false], [page(2026), true], ['', true], [page(2014, 2026), true]]) {
    const result = await checkDtliCandidate(show, 'candidate', async () => ({ ok: true, body: html }));
    assert.equal(result.allowed, allowed);
  }
});

test('watcher retries instead of writing when the page cannot be checked', async () => {
  assert.equal((await checkDtliCandidate(show, 'candidate', async () => ({ ok: false }))).allowed, false);
});
