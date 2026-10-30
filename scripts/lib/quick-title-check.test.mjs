// BRO-6676: DTLI /shows/the-heart/ is a Heart of Rock and Roll page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { quickTitleCheck } = require('./quick-title-check.js');
const shows = [
  { id: 'the-heart-off-broadway-2026', title: 'The Heart', category: 'off-broadway' },
  { id: 'heart-of-rock-and-roll-2024', title: 'The Heart of Rock and Roll', category: 'broadway' },
];
const page = t => `<html><head><title>${t}</title></head></html>`;
const q = { log: () => {}, shows };

test('rejects a longer sibling show page for a short title', () => {
  assert.equal(quickTitleCheck(page('The Heart of Rock and Roll Reviews | Did They Like It?'), 'The Heart', q), false);
});
test('accepts the right page, and the sibling for itself', () => {
  assert.equal(quickTitleCheck(page('The Heart Off-Broadway Reviews | Did They Like It?'), 'The Heart', q), true);
  assert.equal(quickTitleCheck(page('The Heart of Rock and Roll Reviews'), 'The Heart of Rock and Roll', q), true);
});
test('still rejects unrelated pages and accepts title-less html', () => {
  assert.equal(quickTitleCheck(page('Hamilton Reviews'), 'The Heart', q), false);
  assert.equal(quickTitleCheck('<html></html>', 'The Heart', q), true);
});
