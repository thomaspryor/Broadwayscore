#!/usr/bin/env node
/**
 * Reply to the reader behind a feedback GitHub issue (BRO-7693). Replaces the
 * inline `node -e` block in auto-fix-feedback-bug.yml.
 *
 * Nothing is sent to the reader unless FEEDBACK_AUTO_REPLY_KINDS lists the
 * kind. By default this emails a DRAFT to OWNER_EMAIL for the owner to send.
 *
 * Usage: node scripts/send-feedback-reply.js --type=fixed|acknowledged [--dry-run]
 * Env:   ISSUE_NUMBER, GH_TOKEN (labels the issue reply-drafted), ISSUE_BODY (issue body with DIAGNOSIS_JSON), RESEND_API_KEY, OWNER_EMAIL,
 *        FEEDBACK_AUTO_REPLY_KINDS (optional, default empty)
 * --dry-run prints the email that would go out and sends nothing.
 */
const { loadIssueDiagnosis } = require('./lib/feedback-submitter-store.js');
const { readerFromDiagnosis } = require('./lib/owner-fix-email.js');
const { maskEmail } = require('./lib/pii-scan.js');
const { sendReplyOrDraft, makeResendTransport, markReplyDrafted } = require('./lib/feedback-reply-drafts.js');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const typeArg = (args.find((a) => a.startsWith('--type=')) || '').slice(7);
  const type = typeArg === 'fixed' ? 'fixed' : 'acknowledged';

  const diag = loadIssueDiagnosis(process.env.ISSUE_BODY || '');
  if (!diag) { console.log('No DIAGNOSIS_JSON found'); return; }
  const reader = readerFromDiagnosis(diag);
  if (!reader.email) { console.log('No reader email on file'); return; }

  const resendKey = process.env.RESEND_API_KEY;
  if (!dryRun && !resendKey) { console.log('No Resend key'); return; }

  const transport = dryRun
    ? async (p) => console.log(`[dry-run] would send to ${p.to.map(maskEmail).join(', ')}\nSubject: ${p.subject}`)
    : makeResendTransport(resendKey);

  try {
    const res = await sendReplyOrDraft({
      kind: type === 'fixed' ? 'bug-fixed' : 'bug-acknowledged',
      type,
      reader,
      originalMessage: reader.message,
      transport,
    });
    // Only a "fixed" draft retires the issue: an acknowledgement must not stop
    // the later "it's fixed" draft when someone closes the bug by hand.
    if (res.sent && !dryRun && type === 'fixed') {
      if (!(await markReplyDrafted(process.env.ISSUE_NUMBER, { token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN }))) {
        console.log('WARN: could not label the issue reply-drafted');
      }
    }
    console.log(res.sent
      ? `${res.mode === 'auto' ? 'Sent' : 'Drafted to owner:'} ${type} reply for ${maskEmail(reader.email)}`
      : `No ${type} reply for ${maskEmail(reader.email)} (${res.reason})`);
  } catch (err) {
    // Best effort: a failed draft must not fail the fix workflow.
    console.log(`Reply email error: ${err.message}`);
  }
}

main();
