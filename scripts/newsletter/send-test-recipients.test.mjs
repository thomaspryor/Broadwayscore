// BRO-40 Phase 2: the [DRAFT] preview sent by send-test.mjs must also reach
// the email-worker's +claude alias, so its mailbox already holds the draft
// before the owner forwards it there with edits + "ship it" (Reply-All does
// NOT deliver to a +alias of your own Gmail account — verified 2026-09-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildClaudeAliasAddress, buildDraftPreviewRecipients } = require('../lib/email-templates.js');

test('buildClaudeAliasAddress inserts +claude before the @', () => {
  assert.equal(buildClaudeAliasAddress('thomas.pryor@gmail.com'), 'thomas.pryor+claude@gmail.com');
});

test('buildClaudeAliasAddress rejects an address with no @', () => {
  assert.throws(() => buildClaudeAliasAddress('not-an-email'), /Invalid email address/);
});

test('buildDraftPreviewRecipients includes the owner email and the +claude alias', () => {
  const recipients = buildDraftPreviewRecipients('thomas.pryor@gmail.com');
  assert.deepEqual(recipients, ['thomas.pryor@gmail.com', 'thomas.pryor+claude@gmail.com']);
});

test('buildDraftPreviewRecipients does not duplicate when the owner address is already the alias', () => {
  const recipients = buildDraftPreviewRecipients('thomas.pryor+claude@gmail.com');
  assert.deepEqual(recipients, ['thomas.pryor+claude@gmail.com']);
});
