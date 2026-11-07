// The owner's "reader fix applied" email, sent by both reader-feedback fix
// paths: execute-approved-fix.js (owner-approved plan) and
// auto-fix-feedback-bug.js (automatic fix, which used to send the owner
// nothing). Owner asked 2026-10-01 (BRO-4452): when a reader's bug report is
// fixed, show who sent it (name, email, show) and what they wrote.
//
// Only reader-feedback issues email. Cloud sessions also route their own
// private-data fixes through execute-approved-fix.yml with ids like
// "bro-4431-f" (CLOUD.md, BRO-4216); those report in chat and Linear, so
// emailing them was noise (five in two days). Whitelist the reader shape so
// any other future id prefix stays silent.

const https = require('https');
const { escapeHtml } = require('./email-templates.js');

const REPO = 'thomaspryor/Broadwayscore';
const SEND_TIMEOUT_MS = 20000;

function isReaderFeedbackIssue(issueNumber) {
  return /^\d+(-systematic)?$/.test(String(issueNumber ?? '').trim());
}

function shouldEmailOwnerOnFix({ issueNumber, ownerEmail, appliedCount }) {
  if (!ownerEmail || !(appliedCount > 0)) return false;
  return isReaderFeedbackIssue(issueNumber);
}

// DIAGNOSIS_JSON (process-feedback.yml) -> reader contact + their words.
function readerFromDiagnosis(diagnosis) {
  const d = diagnosis || {};
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const name = clean(d.submitterName);
  return {
    name: name && name !== 'Anonymous' ? name : null,
    email: clean(d.submitterEmail),
    show: clean(d.submitterShow),
    message: clean(d.originalMessage),
  };
}

// Pipeline status strings carry em dashes ("not found — already fixed");
// the owner wants none in email copy. The reader's own message stays verbatim.
function plainLine(s) {
  return String(s ?? '').replace(/\s*—\s*/g, ', ').trim();
}

function buildReaderFixOwnerEmail({ issueNumber, reader, summary, changes = [], skipped = [], how = 'approved', partial = false }) {
  const r = reader || {};
  const issue = String(issueNumber);
  const ghIssue = parseInt(issue, 10);
  const who = r.name || r.email || 'A reader';
  const status = partial || skipped.length > 0 ? 'Partly fixed' : how === 'systematic' ? 'Fixed across shows' : 'Fixed';
  const subject = `${status}: ${r.show || 'reader report'} (reported by ${who})`;

  const row = (label, valueHtml) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top;">${label}</td><td style="padding:2px 0;">${valueHtml}</td></tr>`;
  const emailHtml = r.email
    ? `<a href="mailto:${encodeURIComponent(r.email).replace(/%40/g, '@')}">${escapeHtml(r.email)}</a>`
    : '<span style="color:#999;">not given</span>';
  const howText = {
    approved: 'You approved this fix.',
    systematic: 'You approved this fix (the same problem, fixed across other shows too).',
    automatic: 'This was fixed automatically.',
  }[how] || '';

  const list = (items) => items.map(i => `<li>${escapeHtml(plainLine(i))}</li>`).join('\n');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#333;">
<p style="margin:0 0 12px;">${escapeHtml(status)}${summary ? `: ${escapeHtml(plainLine(summary))}` : '.'} ${escapeHtml(howText)} It shows on the site after the next update, usually within half an hour.</p>
<p style="margin:16px 0 4px;font-weight:600;">Who reported it</p>
<table style="border-collapse:collapse;font-size:15px;">
${row('Name', r.name ? escapeHtml(r.name) : '<span style="color:#999;">not given</span>')}
${row('Email', emailHtml)}
${row('Show', r.show ? escapeHtml(r.show) : '<span style="color:#999;">not given</span>')}
</table>
<p style="margin:16px 0 4px;font-weight:600;">What they wrote</p>
<div style="margin:0;padding:8px 12px;border-left:3px solid #ddd;white-space:pre-wrap;">${r.message ? escapeHtml(r.message) : '<span style="color:#999;">(no message saved)</span>'}</div>
${changes.length ? `<p style="margin:16px 0 4px;font-weight:600;">What changed</p>\n<ul style="margin:0;padding-left:20px;font-size:13px;color:#555;">\n${list(changes)}\n</ul>` : ''}
${skipped.length ? `<p style="margin:16px 0 4px;font-weight:600;color:#c00;">Not changed</p>\n<ul style="margin:0;padding-left:20px;font-size:13px;color:#555;">\n${list(skipped)}\n</ul>` : ''}
${Number.isNaN(ghIssue) ? '' : `<p style="margin:16px 0 0;font-size:13px;color:#999;">Report <a href="https://github.com/${REPO}/issues/${ghIssue}">#${ghIssue}</a></p>`}
</body></html>`;

  return { subject, html };
}

// Best effort: never throws, never logs the reader's email address.
async function sendReaderFixOwnerEmail(opts) {
  const ownerEmail = process.env.OWNER_EMAIL;
  const resendKey = process.env.RESEND_API_KEY;
  if (!shouldEmailOwnerOnFix({ issueNumber: opts.issueNumber, ownerEmail, appliedCount: (opts.changes || []).length })) return false;
  if (!resendKey) { console.log('Owner fix email: no RESEND_API_KEY'); return false; }
  const { subject, html } = buildReaderFixOwnerEmail(opts);
  const payload = JSON.stringify({
    from: 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
    to: [ownerEmail],
    subject,
    html,
  });
  const result = await new Promise((resolve) => {
    // Own request (not email-templates postJSON) so a hung Resend call is
    // destroyed rather than holding the job open until its timeout.
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      timeout: SEND_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? 'ok' : `HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve(err.message.slice(0, 200)));
    req.end(payload);
  });
  if (result === 'ok') {
    console.log(`Owner fix email sent for #${opts.issueNumber}`);
    return true;
  }
  console.log(`Owner fix email failed for #${opts.issueNumber}: ${result}`);
  return false;
}

module.exports = {
  isReaderFeedbackIssue,
  shouldEmailOwnerOnFix,
  readerFromDiagnosis,
  buildReaderFixOwnerEmail,
  sendReaderFixOwnerEmail,
};
