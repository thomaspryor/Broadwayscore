// BRO-7272 defect 3: the 62 unresolved same-critic keys are triaged. Real functions only (CLAUDE.md section 15).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { findSameCriticMultiOutlet, unresolved, REVIEWED_DISTINCT } = require('./same-critic-multi-outlet.js');
const { getSyndicationPrimaries } = require('./syndication-pairs.js');

const rows = (show, critic, ...outlets) => outlets.map((outletId) => ({ showId: show, criticName: critic, outletId }));

test('an unreviewed two-outlet key stays unresolved (the live double count is still reported)', () => {
  const keys = findSameCriticMultiOutlet(rows('some-show-2030', 'Pat Example', 'outlet-a', 'outlet-b'));
  assert.strictEqual(unresolved(keys).length, 1);
});

test('a reviewed-distinct key is reported but not unresolved, with its reason attached', () => {
  const [show, critic, outlets] = Object.keys(REVIEWED_DISTINCT)[0].split('|');
  const [a, b] = outlets.split('+');
  const keys = findSameCriticMultiOutlet(rows(show, critic, a, b));
  assert.strictEqual(keys.length, 1);
  assert.ok(keys[0].reviewed, 'reason is carried on the key');
  assert.strictEqual(unresolved(keys).length, 0);
});

test('a review is bound to its outlet pair: a new outlet for the same critic is unresolved again', () => {
  const [show, critic, outlets] = Object.keys(REVIEWED_DISTINCT)[0].split('|');
  const [a] = outlets.split('+');
  const keys = findSameCriticMultiOutlet(rows(show, critic, a, 'some-new-outlet'));
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].reviewed, null);
  assert.strictEqual(unresolved(keys).length, 1);
});

test('every reviewed entry is show|critic|outlets with a lowercase critic and a known reason code', () => {
  for (const [k, code] of Object.entries(REVIEWED_DISTINCT)) {
    const [show, critic, outlets] = k.split('|');
    assert.ok(show && critic && critic === critic.toLowerCase(), k);
    assert.ok(/^[a-z0-9-]+(\+[a-z0-9-]+)+$/.test(outlets || ''), `outlet set missing on ${k}`);
    assert.ok(['two-outlets', 'later-piece', 'no-text'].includes(code), `${k} -> ${code}`);
  }
});

test('Denver Post runs the AP wire review by Jennifer Farrar, so it defers to AP', () => {
  assert.ok(getSyndicationPrimaries('jennifer farrar', 'denver-post').includes('ap'));
  const keys = findSameCriticMultiOutlet(rows('it-shoulda-been-you-2015', 'Jennifer Farrar', 'ap', 'denver-post'));
  assert.strictEqual(unresolved(keys).length, 0);
});
