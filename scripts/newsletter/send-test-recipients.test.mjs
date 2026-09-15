// BRO-40 Phase 2: the [DRAFT] preview sent by send-test.mjs must also reach
// the email-worker's +claude alias, so a Reply-All carries edits + "ship it"
// back to the worker without the owner typing the alias by hand.
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
