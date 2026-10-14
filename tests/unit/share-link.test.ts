/** shareOrCopy (src/lib/share-link.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shareOrCopy } from '../../src/lib/share-link';

const DATA = { title: 'My theater plans', url: 'https://broadwayscorecard.com/plans/abc' };

test('native sheet completes → shared, nothing copied', async () => {
  let copied = '';
  const out = await shareOrCopy(DATA, { share: async () => {}, writeText: async t => { copied = t; } });
  assert.equal(out, 'shared');
  assert.equal(copied, '');
});

test('person closes the sheet → cancelled, nothing copied', async () => {
  let copied = '';
  const abort = Object.assign(new Error('x'), { name: 'AbortError' });
  const out = await shareOrCopy(DATA, { share: async () => { throw abort; }, writeText: async t => { copied = t; } });
  assert.equal(out, 'cancelled');
  assert.equal(copied, '');
});

test('no share sheet → copies the url', async () => {
  let copied = '';
  assert.equal(await shareOrCopy(DATA, { writeText: async t => { copied = t; } }), 'copied');
  assert.equal(copied, DATA.url);
});

test('share throws something else → falls back to copy', async () => {
  let copied = '';
  const err = Object.assign(new Error('x'), { name: 'NotAllowedError' });
  assert.equal(await shareOrCopy(DATA, { share: async () => { throw err; }, writeText: async t => { copied = t; } }), 'copied');
  assert.equal(copied, DATA.url);
});

test('nothing works → failed', async () => {
  assert.equal(await shareOrCopy(DATA, {}), 'failed');
  assert.equal(await shareOrCopy(DATA, { writeText: async () => { throw new Error('denied'); } }), 'failed');
});

test('the sheet gets only title + url, never text that a target could glue onto the link', async () => {
  let sent: unknown;
  await shareOrCopy({ ...DATA, text: 'My theater plans on Broadway Scorecard' } as typeof DATA, { share: async d => { sent = d; } });
  assert.deepEqual(sent, { title: DATA.title, url: DATA.url });
});
