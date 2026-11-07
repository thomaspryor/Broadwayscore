/**
 * Unit tests for scripts/lib/placeholder-byline.js (card #1907).
 * Run: node --test tests/unit/placeholder-byline.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlaceholderByline, isPlaceholderRecord, normalizeForCompare } = require('../../scripts/lib/placeholder-byline.js');

test('isPlaceholderByline: outlet-name-as-byline, various real corpus shapes', () => {
  assert.equal(isPlaceholderByline('The Times', 'The Times (UK)'), true);
  assert.equal(isPlaceholderByline('Financial Times', 'Financial Times'), true);
  assert.equal(isPlaceholderByline('The Globe and Mail', 'The Globe and Mail'), true);
  assert.equal(isPlaceholderByline('The Reviews Hub', 'The Reviews Hub'), true);
  assert.equal(isPlaceholderByline('Cititour', 'Cititour'), true);
});

test('isPlaceholderByline: generic desk/staff terms regardless of outlet', () => {
  assert.equal(isPlaceholderByline('Unknown', 'Variety'), true);
  assert.equal(isPlaceholderByline('unknown', 'Vulture'), true);
  assert.equal(isPlaceholderByline('Staff', 'BroadwayWorld'), true);
  assert.equal(isPlaceholderByline('BWW News Desk', 'BroadwayWorld'), true);
  assert.equal(isPlaceholderByline('Editor', 'The Stage'), true);
  assert.equal(isPlaceholderByline('Contributor', 'CurtainUp'), true);
});

test('isPlaceholderByline: empty/null/numeric criticName is a placeholder', () => {
  assert.equal(isPlaceholderByline(null, 'Metro'), true);
  assert.equal(isPlaceholderByline(undefined, 'Metro'), true);
  assert.equal(isPlaceholderByline('', 'Metro'), true);
  assert.equal(isPlaceholderByline('   ', 'Metro'), true);
  assert.equal(isPlaceholderByline('12345', 'AP'), true);
});

test('isPlaceholderByline: real human bylines are never placeholders', () => {
  assert.equal(isPlaceholderByline('Marilyn Stasio', 'Variety'), false);
  assert.equal(isPlaceholderByline('Jackson McHenry', 'Vulture'), false);
  assert.equal(isPlaceholderByline('Clive Davis', 'The Times (UK)'), false);
  assert.equal(isPlaceholderByline('J. Kelly Nestruck', 'The Globe and Mail'), false);
  assert.equal(isPlaceholderByline('David Jays and Maxie Szalwinska', 'The Times (UK)'), false);
});

test('isPlaceholderByline: a bureau/desk qualifier suffix is treated as a distinct (real) byline', () => {
  // "The Reviews Hub - London" is not literally the bare outlet name — the
  // invariant only needs "placeholder never beats real", not that this
  // qualifier is itself a perfect human name.
  assert.equal(isPlaceholderByline('The Reviews Hub - London', 'The Reviews Hub'), false);
});

test('normalizeForCompare: strips parenthetical qualifiers and punctuation, case-insensitive', () => {
  assert.equal(normalizeForCompare('The Times (UK)'), 'the times');
  assert.equal(normalizeForCompare('Financial Times'), 'financial times');
  assert.equal(normalizeForCompare(''), '');
  assert.equal(normalizeForCompare(null), '');
});

// ---------------------------------------------------------------------------
// defaultCritic override — self-branded solo critics (Codex adversarial
// review, card #1907): outlet-registry.json has outlets whose displayName IS
// their one real critic's name (carole-di-tosti, carey-purcell,
// oscar-e-moore — displayName === defaultCritic). Without this override,
// isPlaceholderByline's outlet-name-equality check would wrongly flag every
// one of them as a placeholder.
// ---------------------------------------------------------------------------
test('isPlaceholderByline: defaultCritic override — a self-branded critic whose name equals the outlet name is NEVER a placeholder', () => {
  assert.equal(isPlaceholderByline('Carole Di Tosti', 'Carole Di Tosti', { defaultCritic: 'Carole Di Tosti' }), false);
  assert.equal(isPlaceholderByline('Oscar E Moore', 'Oscar E Moore', { defaultCritic: 'Oscar E Moore' }), false);
  // Without the override, the same input is a placeholder by outlet-name equality.
  assert.equal(isPlaceholderByline('Carole Di Tosti', 'Carole Di Tosti'), true);
});

test('isPlaceholderByline: defaultCritic override does not suppress OTHER placeholder signals (generic terms, empty)', () => {
  assert.equal(isPlaceholderByline('Unknown', 'Variety', { defaultCritic: 'Someone Else' }), true);
  assert.equal(isPlaceholderByline('', 'Variety', { defaultCritic: 'Someone Else' }), true);
});

test('isPlaceholderRecord: shared guard used by both callers — no criticName field on the record is never a placeholder', () => {
  assert.equal(isPlaceholderRecord({ outlet: 'The Times (UK)' }), false, 'filename-only byline, no criticName field at all');
  assert.equal(isPlaceholderRecord({ criticName: null, outlet: 'Metro' }), false);
  assert.equal(isPlaceholderRecord({ criticName: '   ', outlet: 'Metro' }), false);
  assert.equal(isPlaceholderRecord(null), false);
});

test('isPlaceholderRecord: applies the same placeholder + defaultCritic-override logic as isPlaceholderByline', () => {
  assert.equal(isPlaceholderRecord({ criticName: 'The Times', outlet: 'The Times (UK)' }), true);
  assert.equal(isPlaceholderRecord({ criticName: 'Clive Davis', outlet: 'The Times (UK)' }), false);
  assert.equal(isPlaceholderRecord(
    { criticName: 'Carole Di Tosti', outlet: 'Carole Di Tosti' },
    { defaultCritic: 'Carole Di Tosti' },
  ), false);
});
