'use strict';

// BRO-6918: delivery history survives fresh checkouts and lost stamp commits.
// Stable keys also protect concurrent runs between the history read and send.
const { createHash } = require('crypto');
const { buildDailyReport, dayKeyET } = require('./scheduled-email-count-rules');
const { fetchOwnerEmailsSince } = require('./resend-owner-emails');
const { buildIdempotencyKey } = require('./resend-send-retry');

async function loadScheduledSendHistory({ apiKey, recipient, now = new Date(), fetchEmails = fetchOwnerEmailsSince }) {
  if (!apiKey || !recipient) throw new Error('RESEND_API_KEY and recipient are required for the send guard');
  const dayKey = dayKeyET(now.toISOString());
  // Start before ET midnight, including the 25-hour fall DST day. The planner
  // below filters to the precise calendar day; strict rejects truncated feeds.
  const sinceMs = Date.parse(`${dayKey}T00:00:00Z`) - 24 * 3600 * 1000;
  const emails = await fetchEmails({ apiKey, ownerEmail: recipient, sinceMs, strict: true });
  if (!Array.isArray(emails)) throw new Error('Cannot verify send history');
  return { emails, dayKey };
}

function planScheduledSend({ sender, recipient, subject, history }) {
  if (!['opening-digest', 'reddit-post-ready'].includes(sender)) throw new Error(`Unsupported guarded sender: ${sender}`);
  const bucket = buildDailyReport(history.emails, recipient).get(history.dayKey);
  const subjects = bucket?.senders.get(sender)?.subjects || [];
  // Reddit is event driven: different drafts, updated scores and reminders
  // remain separate emails. An identical subject today is the repeated event.
  const alreadySent = sender === 'opening-digest' ? subjects.length > 0 : subjects.includes(subject);
  const eventKey = sender === 'reddit-post-ready' ? createHash('sha256').update(subject).digest('hex') : '';
  const idempotencyKey = buildIdempotencyKey(sender, history.dayKey, recipient, eventKey);
  return { alreadySent, idempotencyKey };
}

module.exports = { loadScheduledSendHistory, planScheduledSend };
