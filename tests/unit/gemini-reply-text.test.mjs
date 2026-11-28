// BRO-7511: 3.x Gemini replies can split text across parts and carry thought parts.
// geminiReplyText is the one reader the callers share; these are the reply shapes it must handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { geminiReplyText } = createRequire(import.meta.url)('../../scripts/lib/llm-batch.js');

const reply = (parts) => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });

test('one text part', () => assert.equal(geminiReplyText(reply([{ text: '{"a":1}' }])), '{"a":1}'));
test('text split across parts is joined in order', () =>
  assert.equal(geminiReplyText(reply([{ text: '{"a":' }, { text: '1}' }])), '{"a":1}'));
test('thought parts are dropped (reading parts[0] would return the thought)', () =>
  assert.equal(geminiReplyText(reply([{ text: 'Let me think', thought: true }, { text: 'answer' }])), 'answer'));
test('thought-only, empty, non-text and missing shapes give an empty string', () => {
  assert.equal(geminiReplyText(reply([{ text: 'x', thought: true }])), '');
  assert.equal(geminiReplyText(reply([])), '');
  assert.equal(geminiReplyText(reply([{ functionCall: {} }, null])), '');
  assert.equal(geminiReplyText({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), '');
  assert.equal(geminiReplyText({}), '');
  assert.equal(geminiReplyText(null), '');
  assert.equal(geminiReplyText({ candidates: [{ content: { parts: { text: 'x' } } }] }), ''); // non-array parts
});
