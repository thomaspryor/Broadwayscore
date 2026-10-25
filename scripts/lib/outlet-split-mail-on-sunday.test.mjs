/**
 * BRO-5373 (per the BRO-5137 owner decision 2026-10-13: a Sunday edition is
 * its own critic vote): The Mail on Sunday is outletId `mail-on-sunday`,
 * `splitFrom: daily-mail`. Theatre Record files its print reviews under a
 * MAIL ON SUNDAY heading, which used to normalize to daily-mail and was
 * stored as "Daily Mail". Both papers publish on dailymail.co.uk, so the URL
 * never names the paper; daily-mail keeps the domain (edition pair). Drives
 * the real normalizeOutlet, resolveOutletFromUrl, splitOutletCorrection and
 * isGenericLabel. Invented records, real file shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quiet = (fn) => {
  const { warn, log } = console;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = warn; console.log = log; }
};
const { normalizeOutlet, resolveOutletFromUrl, validateCriticOutlet } = quiet(() => require('./review-normalization.js'));
const { splitOutletCorrection, isGenericLabel } = require('./outlet-mismatch-heal.js');
const { EDITION_PAIRS } = require('./outlet-registry-domain-collisions.js');

const URL_DM = 'https://www.dailymail.co.uk/tvshowbiz/article-14022881/Barcelona-review.html';
const st = (d) => quiet(() => splitOutletCorrection(d))?.outletId ?? null;

test('a Theatre Record MAIL ON SUNDAY heading routes to the Mail on Sunday', () => {
  for (const n of ['MAIL ON SUNDAY', 'Mail on Sunday', 'The Mail on Sunday', 'mail-on-sunday', 'mailonsunday']) {
    assert.equal(normalizeOutlet(n), 'mail-on-sunday', n);
  }
  for (const n of ['DAILY MAIL', 'Daily Mail', 'The Mail', 'Mail+', 'daily-mail']) {
    assert.equal(normalizeOutlet(n), 'daily-mail', n);
  }
});

test('the shared domain stays with the Daily Mail', () => {
  assert.equal(quiet(() => resolveOutletFromUrl(URL_DM))?.outletId, 'daily-mail');
  assert.ok(EDITION_PAIRS.some(([a, b]) => a === 'daily-mail' && b === 'mail-on-sunday'));
});

test('a known Mail on Sunday byline under the stored "Daily Mail" stamp moves; other Mail critics stay', () => {
  // Shape of christmas-carol-goes-wrong-apollo-west-end-2025/daily-mail--mark-cook.json.
  const tr = { outletId: 'daily-mail', outlet: 'Daily Mail', url: null, source: 'theatre-record' };
  assert.equal(st({ ...tr, criticName: 'Mark Cook' }), 'mail-on-sunday');
  assert.equal(st({ ...tr, criticName: 'Robert Gore-Langton' }), 'mail-on-sunday');
  assert.equal(st({ ...tr, criticName: 'Neil Armstrong' }), 'mail-on-sunday');
  assert.equal(st({ ...tr, criticName: 'Patrick Marmion' }), null);
  assert.equal(st({ ...tr, criticName: 'Georgina Brown', url: URL_DM }), null, 'Brown writes dailymail.co.uk web reviews');
  assert.equal(st({ ...tr, criticName: 'Mark Cook', _locked: true }), null, '_locked never moves');
  assert.equal(isGenericLabel('Daily Mail', 'daily-mail'), true, 'our own display-name stamp');
  assert.equal(isGenericLabel('daily mail', 'daily-mail'), false, 'an aggregator spelling of the masthead is a signal');
});

test('the Times edition rule is unchanged by the display-name case', () => {
  assert.equal(isGenericLabel('The Times (UK)', 'times-uk'), true);
  assert.equal(isGenericLabel('The Times', 'times-uk'), false);
});

test('a Mail on Sunday critic is not flagged as misattributed at the new id', () => {
  const v = quiet(() => validateCriticOutlet('Robert Gore-Langton', 'mail-on-sunday'));
  assert.notEqual(v && v.confidence, 'high', JSON.stringify(v));
});
