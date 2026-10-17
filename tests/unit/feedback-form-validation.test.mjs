/**
 * Unit tests for src/lib/feedback-form-validation.ts — the pure validation
 * function FeedbackForm.tsx uses to find the first invalid field so it can
 * scroll-to + inline-error it instead of relying on native HTML5 constraint
 * validation (silent no-op bug, task #930).
 *
 * Run: node --test tests/unit/feedback-form-validation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getFirstInvalidField, FEEDBACK_FIELDS } = require('../../src/lib/feedback-form-validation.js');

const VALID = { email: '', category: 'bug', message: 'hello' };

test('returns category field when category is blank', () => {
  const result = getFirstInvalidField({ ...VALID, category: '' });
  assert.equal(result?.name, 'category');
});

test('returns message field when only message is blank', () => {
  const result = getFirstInvalidField({ ...VALID, message: '' });
  assert.equal(result?.name, 'message');
});

test('returns email first when email is malformed, even if category/message are also blank (DOM order)', () => {
  const result = getFirstInvalidField({ email: 'not-an-email', category: '', message: '' });
  assert.equal(result?.name, 'email');
});

test('returns category before message when both are blank', () => {
  const result = getFirstInvalidField({ ...VALID, category: '', message: '' });
  assert.equal(result?.name, 'category');
});

test('returns null when all fields are valid', () => {
  const result = getFirstInvalidField(VALID);
  assert.equal(result, null);
});

test('treats a whitespace-only message as blank', () => {
  const result = getFirstInvalidField({ ...VALID, message: '   ' });
  assert.equal(result?.name, 'message');
});

test('treats a missing key as blank', () => {
  const result = getFirstInvalidField({ category: 'bug' });
  assert.equal(result?.name, 'message');
});

test('blank email is valid (email is optional)', () => {
  const result = getFirstInvalidField({ ...VALID, email: '' });
  assert.equal(result, null);
});

test('rejects a malformed email', () => {
  const result = getFirstInvalidField({ ...VALID, email: 'not-an-email' });
  assert.equal(result?.name, 'email');
});

test('accepts a well-formed email', () => {
  const result = getFirstInvalidField({ ...VALID, email: 'user@example.com' });
  assert.equal(result, null);
});

test('FEEDBACK_FIELDS is in DOM order: email, category, message', () => {
  assert.deepEqual(FEEDBACK_FIELDS.map((f) => f.name), ['email', 'category', 'message']);
});
