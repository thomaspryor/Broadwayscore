'use strict';

// BRO-6763: one owner-only email per new Profitability Scorecard sign-up.
// Pure decision logic; scripts/money-signup-notify.js does the I/O.
//
// Stateless on purpose: no cursor to commit every 15 minutes. A row is "new"
// when created_at is after SEED and inside WINDOW_MS. Resend's Idempotency-Key
// (24h, first send wins) stops a row being emailed twice while it sits in the
// window; WINDOW_MS stays under 24h so the key always outlives the window.
// Cost: a gap in runs longer than WINDOW_MS loses those rows (the daily digest
// still counts them). SEED only matters for the first WINDOW_MS after deploy.

const crypto = require('crypto');
const { isOwnerTestEmail } = require('./admin-money-signups');

// Newest sign-up that existed when this was built (44 rows): never emailed.
const SEED = '2026-10-30T23:25:33.639794+00:00';
const WINDOW_MS = 20 * 60 * 60 * 1000;
const MAX_PER_RUN = 5;

function rowKey(row, secret) {
  // Logs of this public repo print the key, so never derive it from the bare email.
  const mac = crypto.createHmac('sha256', secret || 'money-signup').update(String(row.email).toLowerCase()).digest('hex').slice(0, 16);
  return `money-signup:${Date.parse(row.created_at)}:${mac}`;
}

/**
 * rows: every table row (email, created_at, role, first_page, signup_count).
 * Returns { send: [{row, ordinal, key}], deferred: n } where ordinal is the
 * 1-based running total at that row (owner test addresses excluded).
 */
function planNotifications(rows, { now = new Date(), seed = SEED, windowMs = WINDOW_MS, cap = MAX_PER_RUN, secret } = {}) {
  const real = rows
    .filter(r => typeof r?.email === 'string' && Number.isFinite(Date.parse(r.created_at)) && !isOwnerTestEmail(r.email))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.email.localeCompare(b.email));
  const seedMs = Date.parse(seed);
  const since = Math.max(seedMs, new Date(now).getTime() - windowMs);
  const fresh = [];
  real.forEach((row, i) => {
    const t = Date.parse(row.created_at);
    if (t > since && t <= new Date(now).getTime()) fresh.push({ row, ordinal: i + 1, key: rowKey(row, secret) });
  });
  return { send: fresh.slice(0, cap), deferred: Math.max(0, fresh.length - cap), total: real.length };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSignupEmail({ row, ordinal }, total) {
  const subject = `New Profitability Scorecard sign-up #${ordinal}`;
  const lines = [
    ['Email', row.email], ['Role', row.role || 'not given'], ['First page', row.first_page || 'unknown'],
    ['Sign-up count', row.signup_count == null ? 1 : row.signup_count], ['Signed up', row.created_at],
    ['Running total', `${ordinal} (${total} now)`],
  ];
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px"><h2>${esc(subject)}</h2><ul>${
    lines.map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('')}</ul>` +
    '<p style="color:#999;font-size:12px">Owner-only notification. This person was not emailed.</p></div>';
  return { subject, html };
}

module.exports = { SEED, WINDOW_MS, MAX_PER_RUN, rowKey, planNotifications, buildSignupEmail };
