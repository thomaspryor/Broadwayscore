import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_APPROVAL_INSTRUCTION } from './lib/visual-qa-agent-instructions.mjs';

test('owner approval asks for screenshot review and a plain yes without a hash', () => {
  assert.match(OWNER_APPROVAL_INSTRUCTION, /Show the user the screenshots/);
  assert.match(OWNER_APPROVAL_INSTRUCTION, /ask if it looks right/);
  assert.match(OWNER_APPROVAL_INSTRUCTION, /any plain yes clears the gate/);
  assert.doesNotMatch(OWNER_APPROVAL_INSTRUCTION, /APPROVED:|hash|reply with:/i);
});
