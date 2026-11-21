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
const FLOOD_LIMIT = 25; // more than this many new sign-ups in one hourly run looks like abuse: send nothing, alert the owner
const FLOOD_WINDOW_MIN = 60; // the flood guard also counts sign-ups created in this window, whatever the run frequency
const MAX_AGE_DAYS = 14; // a late switch-on never mails a stale backlog
const MAX_CONSECUTIVE_REJECTS = 2; // 2 in a row is our payload, not the recipients
const SITE = 'https://broadwayscorecard.com';
const REPLY_TO = 'hi@broadwayscorecard.com';
const FROM = 'Tom Pryor <updates@broadwayscorecard.com>';

function isProbeEmail(email) {
  const e = String(email).trim().toLowerCase();
  return /@example\.(com|org|net)$/.test(e) || e.endsWith('@resend.dev') || e.includes('roundtrip');
}

/** Pick who gets a welcome this run. rows are expected oldest first. */
function planWelcomes(rows, { cap = PER_RUN_CAP, now = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  const send = [];
  const stamp = []; // probe/stale rows: marked welcomed without mail so they never clog the queue
  const skipped = { welcomed: 0, unsubscribed: 0, probe: 0, stale: 0, over_cap: 0 };
  for (const row of rows) {
    if (row.welcomed_at) { skipped.welcomed++; continue; }
    if (row.unsubscribed_at) { skipped.unsubscribed++; continue; }
    if (isProbeEmail(row.email) || isOwnerTestEmail(row.email)) { skipped.probe++; stamp.push(row); continue; }
    const age = row.created_at ? now - Date.parse(row.created_at) : 0;
    if (age > maxAgeDays * 86400000) { skipped.stale++; stamp.push(row); continue; }
    if (send.length >= cap) { skipped.over_cap++; continue; }
    send.push(row);
  }
  return { send, stamp, skipped };
}

function unsubscribeUrl(email) {
  return `${SITE}/api/unsubscribe?list=money&email=${encodeURIComponent(String(email).trim().toLowerCase())}`;
}

function buildWelcomeEmail(row) {
  const unsub = unsubscribeUrl(row.email);
  // BRO-7995: owner wants this to read like a note from Tom, not a marketing email. Plain text only
  // (no HTML part, no styling, no banner), one specific question, a one-line footer.
  const subject = 'Thanks for signing up';
  const lines = [
    'Hi,',
    "Thanks for signing up for the Profitability Scorecard. I'm Tom, I built it.",
    'Nobody publishes which Broadway shows pay back their investors, so I wanted one place to see it.',
    'What were you hoping to find? Reply with a line or two. It comes straight to me and I read every one.',
    'Tom',
  ];
  const footer = `You signed up at broadwayscorecard.com/biz. Unsubscribe: ${unsub}`;
  const text = `${lines.join('\n\n')}\n\n--\n${footer}\n`;
  const headers = {
    'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${unsub}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  return { subject, text, headers };
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
 * On/off switch. The committed file scripts/config/money-welcome.json ({"enabled": true}) turns real
 * runs on; the repo variable MONEY_WELCOME_ENABLED="false" is an emergency off-switch that wins over
 * the file, and "true" also turns it on. Anything else defers to the file.
 */
function resolveEnabled({ envValue, fileEnabled }) {
  const v = String(envValue == null ? '' : envValue).trim();
  if (v === 'false') return 'false';
  if (v === 'true') return 'true';
  return fileEnabled === true ? 'true' : 'false';
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * claim(email) -> true when this run now owns the row; release(email) undoes a claim;
 * send(row) -> { statusCode }. Stops at the first 'retry' outcome (likely our setup)
 * and after MAX_CONSECUTIVE_REJECTS rejections in a row (likely our payload).
 * Callers must fail the run when halted or rejected is non-zero.
 */
async function sendWelcomes(rows, { claim, release, send, cap = PER_RUN_CAP, now, sleep = defaultSleep, gapMs = 250, flood = FLOOD_LIMIT, recentTotal = 0 }) {
  const plan = planWelcomes(rows, { cap, now });
  const out = { sent: 0, rejected: 0, lost_claim: 0, stamped: 0, halted: false, flood: false, skipped: plan.skipped };
  // BRO-7704: runs now start minutes apart, so a per-run count alone lets a slow flood drain in small batches.
  // recentTotal = every row created in the last FLOOD_WINDOW_MIN minutes (welcomed or not).
  if (plan.send.length + plan.skipped.over_cap > flood || recentTotal > flood) { out.flood = true; out.halted = true; return out; }
  for (const row of plan.stamp) { if (await claim(row.email)) out.stamped++; }
  let streak = 0;
  for (const row of plan.send) {
    if (!(await claim(row.email))) { out.lost_claim++; continue; }
    let res;
    try { res = await send(row); } catch (e) { res = { statusCode: 0 }; }
    const o = resendOutcome(res.statusCode);
    if (o === 'sent') {
      out.sent++; streak = 0;
      const d = row.created_at ? ((now == null ? Date.now() : now) - Date.parse(row.created_at)) / 60000 : NaN;
      if (Number.isFinite(d)) out.max_delay_min = Math.max(out.max_delay_min || 0, Math.round(d));
    }
    else if (o === 'rejected') {
      out.rejected++; streak++;
      if (streak >= MAX_CONSECUTIVE_REJECTS) { out.halted = true; break; }
    } else {
      try { await release(row.email); } catch (e) { /* run fails below; claim stays, no double send */ }
      out.halted = true; break;
    }
    await sleep(gapMs);
  }
  return out;
}

module.exports = {
  PER_RUN_CAP, FLOOD_LIMIT, FLOOD_WINDOW_MIN, MAX_AGE_DAYS, MAX_CONSECUTIVE_REJECTS, FROM, REPLY_TO, isProbeEmail, planWelcomes, buildWelcomeEmail, unsubscribeUrl,
  idempotencyKey, resendOutcome, runAllowed, resolveEnabled, sendWelcomes,
};
