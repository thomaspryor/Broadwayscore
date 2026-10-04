'use strict';

/**
 * welcome-email.js (BRO-4620): the one-time welcome email for new accounts.
 *
 * Template (subject, HTML, plain text) plus the pure decision logic the sender
 * (scripts/send-welcome-emails.js, run by send-welcome-emails.yml every 15 min)
 * relies on: the on/off switch, the account-age window, the per-day budget and
 * the claim-before-send rule. Kept here so the unit tests exercise the real
 * functions (CLAUDE.md §15).
 *
 * Layout follows buildEmailHtml in ./email-templates.js: dark page, 560px
 * column, two-tone wordmark with a gold hairline, a #1a1a24 card.
 */

const {
  FONT, escapeHtml, siteNameForMarket, buildSocialRowHtml,
} = require('./email-templates');

// ── THE ON/OFF SWITCH ──────────────────────────────────────────────────────
// null = sending OFF (nothing is sent, the cron run exits immediately).
// To turn sending ON, set this to the current UTC time as an ISO string, e.g.
//   const WELCOME_EMAIL_SEND_FROM = '2026-10-05T09:00:00Z';
// Only accounts created at or after that moment get the email, so accounts
// that already exist are never emailed. Back to null turns it off again.
const WELCOME_EMAIL_SEND_FROM = null;

// An account older than this is never emailed, even if it was missed (cron
// outage, budget cap): a "welcome" a week late reads as spam.
const MAX_ACCOUNT_AGE_DAYS = 3;

// Resend's free tier is 100 emails/day, shared with follow notifications and
// owner alerts. Welcome emails take at most this many per rolling 24h and per run.
const DAILY_CAP = 25;
const PER_RUN_CAP = 10;

const SUBJECT = 'Welcome to Broadway Scorecard';
const PREHEADER = "Your diary, your watchlist, and how to bring over the shows you've already logged.";
const MY_SHOWS_URL = 'https://broadwayscorecard.com/my-shows?utm_source=email&utm_medium=welcome&utm_campaign=welcome';
const SITE_URL = 'https://broadwayscorecard.com';

const INTRO = 'Your account is set up. It keeps your theater diary, your watchlist and your lists in one place, and they follow you to any phone or computer you sign in on.';
const STEPS = [
  {
    title: "Rate the shows you've seen",
    body: 'Open any show and tap the stars. Each rating goes into your diary, and you can add the date you went.',
  },
  {
    title: 'Bring your history over',
    body: 'Already log shows on Show Score or Mezzanine? Import them from My Shows and skip the typing.',
  },
  {
    title: 'Keep a watchlist',
    body: "Tap Watchlist on a show you want to catch, then sort the list by closing date so you don't miss it.",
  },
];
const BUTTON_LABEL = 'Open My Shows';
const AFTER_BUTTON = 'Questions, bugs or ideas? Reply to this email. It comes straight to me.';

// First word of the profile display name, or null when there is none.
function firstNameFrom(displayName) {
  if (typeof displayName !== 'string') return null;
  const first = displayName.trim().split(/\s+/)[0];
  return first || null;
}

function headingFor(displayName) {
  const first = firstNameFrom(displayName);
  return first ? `Welcome, ${first}.` : 'Welcome to Broadway Scorecard.';
}

function footerText(email) {
  return `You're getting this one-time email because you created a Broadway Scorecard account with ${email}. To delete your account, open the menu on broadwayscorecard.com and choose Delete account.`;
}

function buildStepRowsHtml() {
  return STEPS.map((s, i) => {
    const divider = i > 0 ? 'border-top:1px solid rgba(255,255,255,0.06);' : '';
    return `<tr><td style="padding:14px 20px;${divider}">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="24" valign="top" style="width:24px;padding-top:1px;">
            <div style="width:24px;height:24px;line-height:24px;border-radius:12px;background-color:rgba(212,165,116,0.15);color:#d4a574;font-size:12px;font-weight:700;text-align:center;font-family:${FONT};">${i + 1}</div>
          </td>
          <td valign="top" style="padding-left:14px;">
            <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#ffffff;line-height:1.4;font-family:${FONT};">${escapeHtml(s.title)}</p>
            <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.7);line-height:1.55;font-family:${FONT};">${escapeHtml(s.body)}</p>
          </td>
        </tr></table>
      </td></tr>`;
  }).join('\n      ');
}

function buildWelcomeEmailHtml({ displayName, email }) {
  const market = 'broadway';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(SUBJECT)}</title></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#0f0f14;opacity:0;">${escapeHtml(PREHEADER)}</div>
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${escapeHtml(headingFor(displayName))}</h1>
  </td></tr>
  <tr><td style="padding:8px 0 8px;">
    <p style="margin:0;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.6;font-family:${FONT};">${escapeHtml(INTRO)}</p>
  </td></tr>
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:16px 20px 2px;">
        <p style="margin:0;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Three ways to start</p>
      </td></tr>
      ${buildStepRowsHtml()}
      <tr><td style="padding-bottom:6px;"></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 0 24px;" align="center">
    <a href="${escapeHtml(MY_SHOWS_URL)}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">${escapeHtml(BUTTON_LABEL)}</a>
  </td></tr>
  <tr><td style="padding:0 0 20px;">
    <p style="margin:0 0 16px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.6;font-family:${FONT};">${escapeHtml(AFTER_BUTTON)}</p>
    <p style="margin:0;font-size:15px;color:#ffffff;line-height:1.5;font-family:${FONT};">Thomas</p>
    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.45);line-height:1.5;font-family:${FONT};">${escapeHtml(siteNameForMarket(market))}</p>
  </td></tr>
  ${buildSocialRowHtml(market)}
  <tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.35);line-height:1.6;font-family:${FONT};">${escapeHtml(footerText(email))}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildWelcomeEmailText({ displayName, email }) {
  const steps = STEPS.map((s, i) => `${i + 1}. ${s.title}\n   ${s.body}`).join('\n\n');
  return [
    headingFor(displayName),
    '',
    INTRO,
    '',
    'THREE WAYS TO START',
    '',
    steps,
    '',
    `${BUTTON_LABEL}: ${MY_SHOWS_URL}`,
    '',
    AFTER_BUTTON,
    '',
    'Thomas',
    'Broadway Scorecard',
    '',
    '--',
    footerText(email),
    '',
  ].join('\n');
}

function buildWelcomeEmail({ displayName, email }) {
  return {
    subject: SUBJECT,
    html: buildWelcomeEmailHtml({ displayName, email }),
    text: buildWelcomeEmailText({ displayName, email }),
  };
}

// ── Decision logic ─────────────────────────────────────────────────────────

// Parses the switch. Returns a Date when sending is on, null when off.
// A malformed value counts as OFF (fail closed), never as "send to everyone".
function parseSendFrom(sendFrom) {
  if (sendFrom == null || sendFrom === '') return null;
  const d = new Date(sendFrom);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Earliest account creation time that may be emailed this run, or null when
// sending is off. The later of the switch time and the max-age window.
function windowStart({ sendFrom, now = new Date(), maxAgeDays = MAX_ACCOUNT_AGE_DAYS }) {
  const from = parseSendFrom(sendFrom);
  if (!from) return null;
  const oldest = new Date(now.getTime() - maxAgeDays * 86400000);
  return from > oldest ? from : oldest;
}

// How many welcome emails this run may send, given how many went out in the
// last 24h.
function sendAllowance({ sentLast24h, dailyCap = DAILY_CAP, perRunCap = PER_RUN_CAP }) {
  const left = dailyCap - (Number(sentLast24h) || 0);
  return Math.max(0, Math.min(perRunCap, left));
}

/**
 * Sends one account its welcome email, at most once.
 *
 * deps.claim(userId)   → true when this caller won the durable claim (a row
 *                        in public.welcome_emails keyed by user id), false when
 *                        the account already has one. Must be atomic.
 * deps.release(userId) → removes the claim after a failed send, so a later run
 *                        retries. Safe because deps.send carries a Resend
 *                        Idempotency-Key per account: a retry of a send that in
 *                        fact went through is dropped by Resend, not delivered.
 * deps.send(user)      → performs the send; throws on failure.
 *
 * Returns { status: 'sent' | 'already-sent' | 'off' }. Rethrows a send error
 * after releasing the claim.
 */
async function sendWelcomeOnce(user, { sendFrom, claim, release, send }) {
  if (!parseSendFrom(sendFrom)) return { status: 'off' };
  if (!user || !user.id || !user.email) throw new Error('sendWelcomeOnce: user needs id and email');
  const won = await claim(user.id);
  if (!won) return { status: 'already-sent' };
  try {
    await send(user);
  } catch (err) {
    await release(user.id);
    throw err;
  }
  return { status: 'sent' };
}

function idempotencyKeyFor(userId) {
  return `welcome-email/${userId}`;
}

module.exports = {
  WELCOME_EMAIL_SEND_FROM,
  MAX_ACCOUNT_AGE_DAYS,
  DAILY_CAP,
  PER_RUN_CAP,
  SUBJECT,
  PREHEADER,
  MY_SHOWS_URL,
  SITE_URL,
  firstNameFrom,
  buildWelcomeEmail,
  buildWelcomeEmailHtml,
  buildWelcomeEmailText,
  parseSendFrom,
  windowStart,
  sendAllowance,
  sendWelcomeOnce,
  idempotencyKeyFor,
};
