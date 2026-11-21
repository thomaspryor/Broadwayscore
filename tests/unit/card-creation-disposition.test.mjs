// Tests the real resolveDisposition() from scripts/lib/card-disposition.js —
// never copied logic (CLAUDE.md rule 15). Both notion-brain.js create and
// scripts/linear-brain.js create route through this exact function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveDisposition, MIN_PARK_REASON_LENGTH } = require('../../scripts/lib/card-disposition.js');

test('neither --dispatch nor --park given: rejected, message names both flags', () => {
  const result = resolveDisposition({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_DISPOSITION');
  assert.match(result.message, /--dispatch/);
  assert.match(result.message, /--park/);
});

test('undefined args object: same as neither given', () => {
  const result = resolveDisposition();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_DISPOSITION');
});

test('both --dispatch and --park given: rejected as ambiguous', () => {
  const result = resolveDisposition({ dispatch: true, park: 'a valid reason here' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BOTH_FLAGS');
});

test('--park with no value (bare flag parses as true): rejected, not silently accepted', () => {
  const result = resolveDisposition({ park: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PARK_REASON_MISSING');
});

test('--park with empty/whitespace-only string: rejected', () => {
  const result = resolveDisposition({ park: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PARK_REASON_MISSING');
});

test(`--park reason shorter than ${MIN_PARK_REASON_LENGTH} chars: rejected`, () => {
  const result = resolveDisposition({ park: 'too short' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PARK_REASON_TOO_SHORT');
  assert.match(result.message, /too short/);
});

test('valid --dispatch: accepted, mode dispatch', () => {
  const result = resolveDisposition({ dispatch: true });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'dispatch');
});

test('valid --park with a sufficient reason: accepted, mode park, reason trimmed', () => {
  const result = resolveDisposition({ park: '  waiting on owner decision about scope  ' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'park');
  assert.equal(result.reason, 'waiting on owner decision about scope');
});

test('exactly MIN_PARK_REASON_LENGTH chars: accepted (boundary)', () => {
  const reason = 'x'.repeat(MIN_PARK_REASON_LENGTH);
  const result = resolveDisposition({ park: reason });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'park');
});

test('MIN_PARK_REASON_LENGTH - 1 chars: rejected (boundary)', () => {
  const reason = 'x'.repeat(MIN_PARK_REASON_LENGTH - 1);
  const result = resolveDisposition({ park: reason });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PARK_REASON_TOO_SHORT');
});
