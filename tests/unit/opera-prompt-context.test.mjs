/**
 * Regression test for the opera-aware classifier prompts.
 *
 * Background: scripts/classify-wrong-production.js and classify-wrong-show.js
 * historically used Broadway-theater-tuned prompts ("You are an expert in
 * Broadway theater history"), causing them to mis-flag Met opera reviews as
 * wrong_production or wrong_show. Tristan und Isolde had 13 of 13 reviews
 * auto-flagged at every 6-hour enrichment cron, rescued only by the temporal
 * override at rebuild time.
 *
 * Fix (2026-05-17): both classifiers now inject opera-specific context blocks
 * from scripts/lib/opera-prompt-context.js when the filed show is an opera.
 * This test guards the framing — if the opera context block goes missing,
 * opera reviews will fall back to the override rescue, which is a hack.
 *
 * See Notion 363637c5-416f-81cc-8240-c48df8b4cfd2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOperaShow,
  getOperaWrongProductionContext,
  getOperaWrongShowContext,
} from '../../scripts/lib/opera-prompt-context.js';

test('isOperaShow recognizes type=opera', () => {
  assert.equal(isOperaShow({ type: 'opera' }), true);
  assert.equal(isOperaShow({ type: 'opera', category: 'off-broadway' }), true);
});

test('isOperaShow rejects non-opera and null', () => {
  assert.equal(isOperaShow({ type: 'musical' }), false);
  assert.equal(isOperaShow({ type: 'play' }), false);
  assert.equal(isOperaShow({ type: 'special' }), false);
  assert.equal(isOperaShow({}), false);
  assert.equal(isOperaShow(null), false);
  assert.equal(isOperaShow(undefined), false);
});

test('wrong-production opera context tells the model prior performances at other houses are normal', () => {
  const ctx = getOperaWrongProductionContext();
  assert.match(ctx, /OPERA CONTEXT/i);
  assert.match(ctx, /Metropolitan Opera/i);
  assert.match(ctx, /different.*casts.*conductors/i);
  assert.match(ctx, /(other opera houses|prior performances)/i);
  assert.match(ctx, /(do NOT mean|NORMAL context)/i);
});

test('wrong-show opera context tells the model opera vocabulary is valid', () => {
  const ctx = getOperaWrongShowContext();
  assert.match(ctx, /OPERA/);
  assert.match(ctx, /Metropolitan Opera House/i);
  // Must mention the opera vocabulary so the model recognizes valid opera reviews
  assert.match(ctx, /conductor/i);
  assert.match(ctx, /(sopranos|tenors|arias)/i);
  assert.match(ctx, /(do NOT flag|are VALID)/i);
});

test('opera contexts are non-empty distinct strings', () => {
  const wp = getOperaWrongProductionContext();
  const ws = getOperaWrongShowContext();
  assert.ok(wp.length > 200, 'wrong-production context should be substantive');
  assert.ok(ws.length > 200, 'wrong-show context should be substantive');
  assert.notEqual(wp, ws, 'contexts should be distinct (different classifier purposes)');
});
