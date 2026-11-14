'use strict';

// test-send-marker.js — BRO-3577.
//
// Any script that sends a real, full-fidelity transactional email to a
// single address for manual testing (the `--send-to=you@email.com` pattern
// documented in CLAUDE.md §17) must make that email visibly a test in the
// recipient's inbox. Without this, a test send is byte-for-byte
// indistinguishable from a real one — including its claims ("confirmed",
// "sorry for the delay") — which is exactly what happened on 2026-09-15:
// a BRO-1325 session verified scripts/send-btc-confirmation-emails.js by
// sending the real template with unit-test fixture data
// ({'Best Musical': 'Foo'}) to the owner's real inbox. It read as a genuine,
// confusing confirmation for a contest the owner never entered, prompting
// "No sessions should be sending emails like this to any people. Ever."
//
// Apply this to {subject, html} ONLY on the single-recipient test path —
// never on a real production send to a real recipient.

const BANNER_HTML = `<div style="background:#7c2d12;color:#fed7aa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;text-align:center;padding:10px 16px;">⚠️ TEST EMAIL — sent for manual verification, not a real confirmation. Ignore.</div>`;

/**
 * @param {{subject: string, html: string}} email
 * @returns {{subject: string, html: string}} the same email, unmistakably marked as a test
 */
function markTestSend({ subject, html }) {
  if (typeof subject !== 'string' || typeof html !== 'string') {
    throw new TypeError('markTestSend: { subject, html } strings are required');
  }
  return {
    subject: `[TEST] ${subject}`,
    html: BANNER_HTML + html,
  };
}

module.exports = { markTestSend };
