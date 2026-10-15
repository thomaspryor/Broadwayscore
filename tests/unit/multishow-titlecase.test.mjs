/**
 * BRO-5373: detectMultiShowContent's requireTitleCase option. Ordinary-word
 * show titles in lowercase prose ("miles around", "the estate") stop counting;
 * titles printed in Title Case (a junk index page, a named comparison) still do.
 * Pattern: require() the real functions, never copy logic into tests (§15).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const cq = require('../../scripts/lib/content-quality.js');

test('titleCaseMatch: every main word capitalised, small words aside', () => {
  assert.strictEqual(cq.titleCaseMatch('The Estate'), true);
  assert.strictEqual(cq.titleCaseMatch("Everybody's Talking About Jamie"), true);
  assert.strictEqual(cq.titleCaseMatch('Standing at the Edge'), true);
  assert.strictEqual(cq.titleCaseMatch('the estate'), false);
  assert.strictEqual(cq.titleCaseMatch('The estate'), false);
  assert.strictEqual(cq.titleCaseMatch('miles'), false);
});

const titles = () => {
  const sample = ['The Estate', 'Tender', 'Local', 'Miles', 'Reckless', 'Middle', 'Stories', 'The Story'];
  return sample;
};

test('lowercase prose mentions of ordinary-word titles do not count with requireTitleCase', () => {
  const prose = 'People came from miles around to the estate. One local said the story was reckless and tender, '
    + 'with stories from the middle of the block. '.repeat(1) + 'More words about the production follow here. '.repeat(10);
  const off = cq.detectMultiShowContent(prose, 'some-show-west-end-2023', { requireTitleCase: false });
  const on = cq.detectMultiShowContent(prose, 'some-show-west-end-2023', { requireTitleCase: true });
  assert.ok(on.showsFound.length <= off.showsFound.length);
  for (const t of on.showsFound) assert.ok(!['tender', 'local', 'miles', 'the estate'].includes(t), `${t} counted from lowercase prose`);
});

test('a Title Case index page still trips the detector with requireTitleCase', () => {
  const list = titles().join(' | ');
  const page = `Now Playing: ${list} | Hamilton | Wicked | Chicago Tickets | Hadestown | Six | Moulin Rouge `.repeat(3);
  const on = cq.detectMultiShowContent(page, 'some-show-west-end-2023', { requireTitleCase: true });
  const off = cq.detectMultiShowContent(page, 'some-show-west-end-2023', { requireTitleCase: false });
  assert.strictEqual(on.detected, off.detected);
});

test('default behaviour is unchanged until the corpus audit flips it', () => {
  const prose = 'People came from miles around. One local said it was tender. '.repeat(8);
  assert.deepStrictEqual(
    cq.detectMultiShowContent(prose, 'x-2023').showsFound,
    cq.detectMultiShowContent(prose, 'x-2023', { requireTitleCase: false }).showsFound,
  );
});
