'use strict';
// BRO-6199: --require preload for scripts/send-welcome-emails.test.mjs. Replaces
// global fetch so `--test-send` never reaches Resend; the fake Resend reply
// echoes a recipient address that the script's redactEmails guard must scrub.
globalThis.fetch = async () => ({
  status: 200,
  ok: true,
  text: async () => JSON.stringify({ id: 'stub-id', to: 'leak.check@example.com' }),
});
