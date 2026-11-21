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
const MAX_PER_RUN = 10;

function rowKey(row, secret) {
  // Logs of this public repo print the key, so never derive it from the bare email.
  const mac = crypto.createHmac('sha256', secret || 'money-signup').update(String(row.email).toLowerCase()).digest('hex').slice(0, 16);
  return `money-signup:${Date.parse(row.created_at)}:${mac}`;
}

/**
 * rows: every table row (email, created_at, role, first_page, signup_count).
 * Returns { send, digest, total }. Up to `cap` fresh rows: send = one email each.
 * More than `cap` (a burst, likely abuse): send = [] and digest = all of them,
 * emailed once; digestKey changes only when the set of rows changes, so a
 * repeat run over the same set is deduped. (Stateless code cannot tell which
 * rows an earlier run sent, so "first N now, rest later" would resend the
 * first N and strand the rest.) ordinal = 1-based running total at that row,
 * owner test addresses excluded.
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
  if (fresh.length <= cap) return { send: fresh, digest: null, total: real.length };
  const digestKey = 'money-signup-digest:' + crypto.createHash('sha256').update(fresh.map(f => f.key).join('|')).digest('hex').slice(0, 24);
  return { send: [], digest: { items: fresh, key: digestKey }, total: real.length };
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

function buildDigestEmail({ items }, total) {
  const subject = `${items.length} new Profitability Scorecard sign-ups at once`;
  const li = items.map(({ row, ordinal }) => `<li>#${ordinal} ${esc(row.email)} (${esc(row.role || 'no role')}, ${esc(row.created_at)})</li>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px"><h2>${esc(subject)}</h2><p>Over the per-run cap, so sent as one email. ${total} sign-ups now.</p><ul>${li}</ul>` +
    '<p style="color:#999;font-size:12px">Owner-only notification. These people were not emailed.</p></div>';
  return { subject, html };
}

module.exports = { buildDigestEmail, SEED, WINDOW_MS, MAX_PER_RUN, rowKey, planNotifications, buildSignupEmail };
