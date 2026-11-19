/**
 * owner-email-thread.js: the ONE place owner-only reader-feedback emails get
 * their thread headers and get sent (BRO-7847).
 *
 * Every owner email about one reader report (the proposal, the "fix applied"
 * note, the reply draft) shares a stable base subject and a Message-ID derived
 * from the GitHub issue number, so Gmail stacks them in one conversation and no
 * thread state has to be stored. The recipient is OWNER_EMAIL only: there is
 * no `to` parameter on purpose, so this helper can never email a reader.
 *
 * Resend may ignore a custom Message-ID. The stable subject keeps Gmail
 * threading anyway; the e2e test in the card verifies it on a real send.
 */
'use strict';

const https = require('https');

const DOMAIN = 'broadwayscorecard.com';
const FROM = 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>';
const SEND_TIMEOUT_MS = 20000;

function cleanIssue(issueNumber) {
  const n = String(issueNumber ?? '').trim().replace(/-systematic$/, '');
  return /^\d+$/.test(n) ? n : null;
}

function threadMessageId(issueNumber) {
  const n = cleanIssue(issueNumber);
  return n ? `<bsc-feedback-${n}@${DOMAIN}>` : null;
}

// Same subject on every email of the thread. Gmail groups on it.
function threadSubject({ show, issueNumber } = {}) {
  const n = cleanIssue(issueNumber);
  const what = String(show || '').replace(/\s+/g, ' ').trim() || 'reader report';
  return `Reader feedback: ${what}${n ? ` (#${n})` : ''}`;
}

// root=true on the email that starts the thread; every later one replies to it.
function threadHeaders(issueNumber, { root = false } = {}) {
  const id = threadMessageId(issueNumber);
  if (!id) return {};
  if (root) return { 'Message-ID': id };
  return { 'In-Reply-To': id, References: id };
}

function buildOwnerPayload({ issueNumber, subject, html, text, root = false, env = process.env }) {
  const owner = env.OWNER_EMAIL;
  if (!owner) return null;
  const payload = { from: FROM, to: [owner], subject, html, headers: threadHeaders(issueNumber, { root }) };
  if (text) payload.text = text;
  return payload;
}

function resendTransport(env = process.env) {
  return (payload) => new Promise((resolve, reject) => {
    const key = env.RESEND_API_KEY;
    if (!key) return reject(new Error('no RESEND_API_KEY'));
    const data = JSON.stringify(payload);
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve(body)
        : reject(new Error(`Resend ${res.statusCode} ${body.slice(0, 160)}`))));
    });
    req.setTimeout(SEND_TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${SEND_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Send one threaded owner-only email. Returns { sent, reason? }.
 * `transport` is injectable for tests.
 */
async function sendOwnerThreadEmail({ issueNumber, subject, html, text, root = false, env = process.env, transport }) {
  const payload = buildOwnerPayload({ issueNumber, subject, html, text, root, env });
  if (!payload) return { sent: false, reason: 'no-owner-email' };
  // Dry run for local tests: write the payload instead of sending it.
  if (!transport && env.OWNER_EMAIL_DRY_RUN_FILE) {
    require('fs').writeFileSync(env.OWNER_EMAIL_DRY_RUN_FILE, JSON.stringify(payload, null, 2));
    return { sent: true, dryRun: true };
  }
  await (transport || resendTransport(env))(payload);
  return { sent: true };
}

module.exports = { threadMessageId, threadSubject, threadHeaders, buildOwnerPayload, sendOwnerThreadEmail, resendTransport, FROM };
