// BRO-6575: email sign-in settings. The template must carry the code the
// web modal and iOS app ask for, and the diff must not loop on smtp_pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEmailAuthPatch, diffPatch } from './apply-supabase-email-auth.mjs';

const template = readFileSync(new URL('../supabase/templates/sign-in-code.html', import.meta.url), 'utf8');

test('committed template builds a patch with the code and link', () => {
  const p = buildEmailAuthPatch({ template, resendKey: 're_x' });
  assert.match(p.mailer_templates_magic_link_content, /\{\{ \.Token \}\}/);
  assert.equal(p.mailer_templates_confirmation_content, p.mailer_templates_magic_link_content);
  assert.equal(p.mailer_otp_length, 6);
  assert.equal(p.smtp_host, 'smtp.resend.com');
});

test('a template without the code is refused', () => {
  assert.throws(() => buildEmailAuthPatch({ template: '<a href="{{ .ConfirmationURL }}">x</a>', resendKey: 'k' }), /Token/);
});

test('diff ignores matching values and an already-set smtp_pass', () => {
  const p = buildEmailAuthPatch({ template, resendKey: 're_x' });
  const live = { ...p, smtp_pass: '********', mailer_otp_length: 6, smtp_port: 465 };
  assert.deepEqual(diffPatch(p, live), []);
  assert.deepEqual(diffPatch(p, { ...live, smtp_pass: null, mailer_otp_length: 8 }), ['mailer_otp_length', 'smtp_pass']);
});
