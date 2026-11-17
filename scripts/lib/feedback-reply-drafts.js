/**
 * Every email to a feedback reader goes through here (BRO-7693).
 *
 * Owner rule, 2026-11-17: nothing is sent to a reader without the owner
 * checking the wording first. By default every reply is built as a DRAFT and
 * emailed to OWNER_EMAIL, with a prefilled mailto: link, for the owner to send
 * by hand. The one exception is a reply kind listed in FEEDBACK_AUTO_REPLY_KINDS
 * (comma separated, e.g. "missing-reviews"). That switch defaults to empty and
 * must stay empty until the owner approves the exact wording.
 *
 * Pure builders plus one sender that takes an injected transport, so the tests
 * can prove a draft never addresses the reader without touching the network.
 */

const SIGNATURE = 'Tom\nBroadway Scorecard™';
const { READER_REPLY_CLOSING_LINE: CLOSING_LINE } = require('./reader-reply-closing');
const FROM = 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>';
const DRAFT_FROM = 'Broadway Scorecard Drafts <updates@broadwayscorecard.com>';
const REPLY_KINDS_ENV = 'FEEDBACK_AUTO_REPLY_KINDS';

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAutoKinds(env) {
  const raw = (env && env[REPLY_KINDS_ENV]) || '';
  return new Set(
    String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

/** 'auto' only when the kind is explicitly listed in FEEDBACK_AUTO_REPLY_KINDS. */
function decideReplyMode(kind, env = process.env) {
  if (!kind) return 'draft';
  return parseAutoKinds(env).has(String(kind).trim().toLowerCase()) ? 'auto' : 'draft';
}

function greetingFor(name) {
  return name && name !== 'Anonymous' ? `Hi ${name},` : 'Hi there,';
}

/**
 * Plain-text reply for a reader.
 * @param {'fixed'|'reviews-added'|'acknowledged'|'praise'|'feature'|'content'} type
 * @param {string} [name] reader's first name
 * @param {string} [show] show title
 * @param {{url?: string}} [opts] url: live show page link (fixed, reviews-added)
 * @returns {{subject: string, text: string}}
 */
function buildReplyText(type, name, show, opts = {}) {
  const hi = greetingFor(name);
  const about = show ? ` about ${show}` : '';
  const link = opts.url ? `\n\nHere is the page: ${opts.url}` : '';
  let subject;
  let body;

  switch (type) {
    case 'fixed':
      subject = show ? `Re: ${show}` : 'Re: your feedback';
      body = `${hi}\n\nThank you for writing in${about}. You were right. We looked into it and pushed a fix, and it is live now.${link}\n\nFeedback like yours makes the site better.`;
      break;
    case 'reviews-added':
      subject = show ? `Re: ${show}` : 'Re: your request';
      body = `${hi}\n\nThanks for asking about${show ? ` ${show}` : ' that show'}. The reviews are now on the site.${link}\n\nIf anything still looks off, reply to this email and I will look into it.`;
      break;
    case 'praise':
      subject = name && name !== 'Anonymous' ? `Thanks ${name}!` : 'Thank you!';
      body = `${hi}\n\nThank you. Your kind words made my day. I’m glad the site is useful to you.`;
      break;
    case 'content':
      subject = show ? `Re: ${show}` : 'Re: your request';
      body = `${hi}\n\nThanks for writing in${about}. Requests like this are how we find gaps in our coverage, and I’ll take a look at adding it.`;
      break;
    case 'feature':
      subject = name && name !== 'Anonymous' ? `Thanks ${name}!` : 'Thanks for the idea!';
      body = `${hi}\n\nThank you for sharing that idea. I’ve added it to our list. It helps to hear what people want to see.`;
      break;
    default: // 'acknowledged'
      subject = show ? `Re: ${show}` : 'Re: your feedback';
      body = `${hi}\n\nThank you for writing in${about}. I appreciate you taking the time to flag this.\n\nWe’ve noted it and will keep it in mind as we keep improving the site.`;
      break;
  }
  return { subject, text: `${body}\n\n${CLOSING_LINE}\n\n${SIGNATURE}` };
}

function plainTextToHtml(text) {
  return String(text)
    .split('\n')
    .map((line) => (line === '' ? '<br>' : `<p style="margin:0;">${escapeHtml(line)}</p>`))
    .join('\n');
}

/** Gmail-friendly link that opens a compose window with the reply prefilled. */
function buildMailtoLink(to, subject, text) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

/**
 * The email the OWNER receives. Never addressed to the reader: reply_to is the
 * reader so a plain Reply also lands on the right person.
 * @param {{reader: {name?: string, email: string, show?: string}, reply: {subject: string, text: string}, originalMessage?: string}} p
 */
function buildOwnerDraftEmail({ reader, reply, originalMessage }) {
  const who = reader.name && reader.name !== 'Anonymous' ? reader.name : 'reader';
  const subject = `Draft reply: ${who}${reader.show ? ` (${reader.show})` : ''}`;
  const mailto = buildMailtoLink(reader.email, reply.subject, reply.text);
  const quoted = originalMessage
    ? String(originalMessage).split('\n').map((l) => `> ${l}`).join('\n')
    : '(no original message on file)';

  const text = [
    'Nothing has been sent to the reader. Review the wording, then send it yourself.',
    '',
    `To: ${reader.email}`,
    `Subject: ${reply.subject}`,
    '',
    reply.text,
    '',
    `Open as email: ${mailto}`,
    '',
    'Their original message:',
    quoted,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">
<p style="margin:0 0 12px 0;color:#666;">Nothing has been sent to the reader. Review the wording, then send it yourself.</p>
<p style="margin:0;"><strong>To:</strong> ${escapeHtml(reader.email)}</p>
<p style="margin:0 0 12px 0;"><strong>Subject:</strong> ${escapeHtml(reply.subject)}</p>
<div style="border-left:3px solid #ddd;padding-left:12px;margin:0 0 16px 0;">
${plainTextToHtml(reply.text)}
</div>
<p style="margin:0 0 20px 0;"><a href="${escapeHtml(mailto)}" style="display:inline-block;padding:10px 16px;background:#222;color:#fff;border-radius:6px;text-decoration:none;">Open as email</a></p>
<p style="margin:0 0 4px 0;color:#666;">Their original message:</p>
<div style="color:#555;border-left:3px solid #eee;padding-left:12px;">
${plainTextToHtml(quoted.replace(/^> /gm, ''))}
</div>
</body></html>`;

  return { subject, html, text, mailto };
}

/**
 * Send a reply to a reader, or (default) a draft of it to the owner.
 *
 * @param {object} p
 * @param {string} [p.kind]   routing kind, e.g. 'missing-reviews'; only consulted for auto mode
 * @param {string} p.type     reply type for buildReplyText
 * @param {{name?: string, email?: string, show?: string}} p.reader
 * @param {string} [p.originalMessage]
 * @param {string} [p.url]    live show page link for the reply text
 * @param {object} [p.env]
 * @param {(payload: object) => Promise<any>} p.transport  posts one Resend email payload
 * @returns {Promise<{mode: 'auto'|'draft', sent: boolean, reason?: string, recipient?: 'reader'|'owner'}>}
 */
async function sendReplyOrDraft({ kind, type, reader, originalMessage, url, env = process.env, transport }) {
  if (!reader || !reader.email) return { mode: 'draft', sent: false, reason: 'no-reader-email' };
  const mode = decideReplyMode(kind, env);
  const reply = buildReplyText(type, reader.name, reader.show, { url });

  if (mode === 'auto') {
    await transport({
      from: FROM,
      reply_to: env.FEEDBACK_REPLY_TO || 'hi@broadwayscorecard.com',
      to: [reader.email],
      subject: reply.subject,
      html: `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head>\n<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">\n${plainTextToHtml(reply.text)}\n</body></html>`,
      text: reply.text,
    });
    return { mode, sent: true, recipient: 'reader' };
  }

  const ownerEmail = env.OWNER_EMAIL;
  if (!ownerEmail) {
    // Never fall back to the reader: no owner address means no email at all.
    return { mode, sent: false, reason: 'no-owner-email' };
  }
  const draft = buildOwnerDraftEmail({ reader, reply, originalMessage });
  await transport({
    from: DRAFT_FROM,
    reply_to: reader.email,
    to: [ownerEmail],
    subject: draft.subject,
    html: draft.html,
    text: draft.text,
  });
  return { mode, sent: true, recipient: 'owner' };
}

/** Default transport: one Resend email. Throws on a non-2xx. */
function makeResendTransport(resendKey) {
  const { postJSON } = require('./email-templates.js');
  return (payload) => postJSON('https://api.resend.com/emails', payload, { Authorization: `Bearer ${resendKey}` });
}

const DRAFTED_LABEL = 'reply-drafted';

/** Mark a GitHub issue so no second draft is sent for it. Returns true on success. */
function markReplyDrafted(issueNumber, { token, repo = 'thomaspryor/Broadwayscore' } = {}) {
  const n = parseInt(issueNumber, 10);
  if (!token || isNaN(n)) return Promise.resolve(false);
  const https = require('https');
  const data = JSON.stringify({ labels: [DRAFTED_LABEL] });
  return new Promise((resolve) => {
    const req = https.request(`https://api.github.com/repos/${repo}/issues/${n}/labels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'broadwayscorecard-reply-drafts',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
    req.setTimeout(30000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

/**
 * "The reviews are now on the site" drafts for requests that just went live
 * (BRO-7693). Only missing-reviews entries; each gets ONE draft to the owner
 * (never the reader unless the owner listed 'missing-reviews' in
 * FEEDBACK_AUTO_REPLY_KINDS). Sets entry.replyDraftedAt so a re-run never
 * drafts twice.
 *
 * @param {Array<{entry: object, url?: string}>} nowLive
 * @param {{lookupReader: (submissionId: string) => ({name?: string, email?: string, show?: string, message?: string}|null), transport: Function, env?: object, now?: () => string}} deps
 * @returns {Promise<Array<{key: string, status: 'drafted'|'skipped'|'failed', reason?: string}>>}
 */
async function draftReviewsAddedReplies(nowLive, { lookupReader, transport, env = process.env, now = () => new Date().toISOString() }) {
  const out = [];
  for (const r of nowLive || []) {
    const entry = r && r.entry;
    if (!entry || entry.kind !== 'missing-reviews') continue;
    const key = entry.key || entry.submissionId || '?';
    if (entry.replyDraftedAt) { out.push({ key, status: 'skipped', reason: 'already-drafted' }); continue; }
    const stored = entry.submissionId ? lookupReader(entry.submissionId) : null;
    if (!stored || !stored.email) { out.push({ key, status: 'skipped', reason: 'no-reader-email' }); continue; }
    try {
      const res = await sendReplyOrDraft({
        kind: 'missing-reviews',
        type: 'reviews-added',
        reader: { name: stored.name, email: stored.email, show: stored.show || entry.title },
        originalMessage: stored.message,
        url: r.url,
        env,
        transport,
      });
      if (!res.sent) {
        if (res.reason === 'no-owner-email') entry.replyDraftRetry = true;
        out.push({ key, status: 'skipped', reason: res.reason });
        continue;
      }
      entry.replyDraftedAt = now();
      delete entry.replyDraftRetry;
      out.push({ key, status: 'drafted' });
    } catch (err) {
      entry.replyDraftRetry = true; // verify-feedback-requests-live retries these next run
      out.push({ key, status: 'failed', reason: err.message });
    }
  }
  return out;
}

module.exports = {
  draftReviewsAddedReplies,
  DRAFTED_LABEL,
  markReplyDrafted,
  REPLY_KINDS_ENV,
  decideReplyMode,
  buildReplyText,
  buildMailtoLink,
  buildOwnerDraftEmail,
  sendReplyOrDraft,
  makeResendTransport,
};
