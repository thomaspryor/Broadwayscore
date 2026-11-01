'use strict';

// BRO-6309: one-time welcome email for new Profitability Scorecard sign-ups.
// Pure decision logic plus an injectable send loop; scripts/send-money-welcome.js
// does the I/O. One transactional email per person, never a broadcast and never
// a Resend audience (CLAUDE.md §17).
//
// Once-only: each row is claimed by setting welcomed_at (only where it is still
// null) BEFORE the Resend call. A transient failure releases the claim so the
// next run retries; a permanent rejection keeps it so the address is not retried.
// The migration backfills welcomed_at for everyone who signed up before launch.

const crypto = require('crypto');
const { isOwnerTestEmail } = require('./admin-money-signups');

const PER_RUN_CAP = 50;
const SITE = 'https://broadwayscorecard.com';
const REPLY_TO = 'hi@broadwayscorecard.com';
const FROM = 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>';

function isProbeEmail(email) {
  const e = String(email).trim().toLowerCase();
  return /@example\.(com|org|net)$/.test(e) || e.endsWith('@resend.dev') || e.includes('roundtrip');
}

/** Pick who gets a welcome this run. rows are expected oldest first. */
function planWelcomes(rows, { cap = PER_RUN_CAP } = {}) {
  const send = [];
  const skipped = { welcomed: 0, unsubscribed: 0, probe: 0, over_cap: 0 };
  for (const row of rows) {
    if (row.welcomed_at) { skipped.welcomed++; continue; }
    if (row.unsubscribed_at) { skipped.unsubscribed++; continue; }
    if (isProbeEmail(row.email) || isOwnerTestEmail(row.email)) { skipped.probe++; continue; }
    if (send.length >= cap) { skipped.over_cap++; continue; }
    send.push(row);
  }
  return { send, skipped };
}

function unsubscribeUrl(email) {
  return `${SITE}/api/unsubscribe?list=money&email=${encodeURIComponent(String(email).trim().toLowerCase())}`;
}

function buildWelcomeEmail(row) {
  const unsub = unsubscribeUrl(row.email);
  const subject = 'Welcome to the Profitability Scorecard';
  const lines = [
    'Hi,',
    'Thanks for signing up. You now have full access to the Broadway Profitability Scorecard.',
    "I made it because there's no public record of which Broadway shows pay back their investors. This is a small list, and I'd like to know who's on it. What's your connection to Broadway, and what would make the scorecard more useful to you?",
    'Just hit reply. It comes straight to me.',
    'Tom',
  ];
  const footer = 'You are getting this because you signed up at broadwayscorecard.com/biz.';
  const text = `${lines.join('\n\n')}\n\n${footer}\nUnsubscribe: ${unsub}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222">${lines
    .map((l) => `<p>${l}</p>`).join('')}<p style="font-size:12px;color:#777">${footer} <a href="${unsub}">Unsubscribe</a></p></div>`;
  const headers = {
    'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${unsub}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  return { subject, text, html, headers };
}

function idempotencyKey(email, secret) {
  // Logged in a public repo's Actions, so never derived from the bare address.
  const mac = crypto.createHmac('sha256', secret || 'money-welcome').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 20);
  return `money-welcome:${mac}`;
}

/** 'sent' | 'rejected' (bad recipient, do not retry) | 'retry' (transient or our setup, stop the run). */
function resendOutcome(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'sent';
  if (statusCode === 400 || statusCode === 422) return 'rejected';
  return 'retry';
}

/** Real runs only when MONEY_WELCOME_ENABLED is exactly "true". Previews never need it. */
function runAllowed({ enabled, preview }) {
  return preview === true || String(enabled).trim() === 'true';
}

/**
 * claim(email) -> true when this run now owns the row; release(email) undoes a claim;
 * send(row) -> { statusCode }. Stops at the first 'retry' outcome (likely our setup).
 */
async function sendWelcomes(rows, { claim, release, send, cap = PER_RUN_CAP }) {
  const plan = planWelcomes(rows, { cap });
  const out = { sent: 0, rejected: 0, lost_claim: 0, halted: false, skipped: plan.skipped };
  for (const row of plan.send) {
    if (!(await claim(row.email))) { out.lost_claim++; continue; }
    let res;
    try { res = await send(row); } catch (e) { res = { statusCode: 0 }; }
    const o = resendOutcome(res.statusCode);
    if (o === 'sent') out.sent++;
    else if (o === 'rejected') out.rejected++;
    else { await release(row.email); out.halted = true; break; }
  }
  return out;
}

module.exports = {
  PER_RUN_CAP, FROM, REPLY_TO, isProbeEmail, planWelcomes, buildWelcomeEmail, unsubscribeUrl,
  idempotencyKey, resendOutcome, runAllowed, sendWelcomes,
};
