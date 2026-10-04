#!/usr/bin/env node
/**
 * send-welcome-emails.js (BRO-4620)
 *
 * Sends the one-time welcome email (scripts/lib/welcome-email.js) to accounts
 * created since sending was switched on. Run every 15 min by
 * .github/workflows/send-welcome-emails.yml.
 *
 * ON/OFF: WELCOME_EMAIL_SEND_FROM in scripts/lib/welcome-email.js. While it is
 * null this script exits before touching the network.
 *
 * Once-only: each account is claimed by inserting its row into
 * public.welcome_emails (primary key = user id) BEFORE the Resend call, and
 * the send carries a per-account Idempotency-Key. Overlapping runs, retries
 * and re-runs cannot double-send. A failed send releases the claim and alerts
 * the owner; the next run retries.
 *
 * Why a cron and not a Supabase database webhook + edge function: the edge
 * functions have no Resend key, a webhook adds a second deploy surface with
 * its own retry semantics, and the repo already sends user email this way
 * (send-follow-notifications.js). A 15-minute delay is fine for a welcome.
 *
 * Transactional only: POST /emails, one recipient per call. Never broadcasts,
 * never an audience (CLAUDE.md §17).
 *
 * Usage:
 *   node scripts/send-welcome-emails.js                 # real run (needs the switch on)
 *   node scripts/send-welcome-emails.js --dry-run       # read-only: who would get it
 *   node scripts/send-welcome-emails.js --dry-run --preview-since=2026-10-01T00:00:00Z
 *       # read-only: who WOULD get it had the switch been set to that time
 *       # (ignores the switch; never sends, never claims)
 *   node scripts/send-welcome-emails.js --test-send     # one send to delivered@resend.dev
 *                                                       # (Resend's test sink), no database
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
 *      OWNER_EMAIL (failure alerts)
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { sleep, buildFromAddress, buildReplyToAddress } = require('./lib/email-templates');
const { sendAlert } = require('./lib/discord-notify');
const db = require('./lib/supabase-service-rest');
const welcome = require('./lib/welcome-email');

const USAGE = `send-welcome-emails.js — one-time welcome email for new accounts (BRO-4620).

Usage:
  node scripts/send-welcome-emails.js [--dry-run [--preview-since=ISO]] [--test-send]
  node scripts/send-welcome-emails.js --help, -h    print this usage and exit
`;

const TEST_SINK = 'delivered@resend.dev';
// PostHog project API key: the public, write-only key the site already ships
// in its client bundle (src/lib/promo-tracking.ts).
const POSTHOG_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';
const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';

function argValue(name) {
  const hit = process.argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

// Logs never carry an email address (or a name): user id prefix only.
function label(user) {
  return `user ${String(user.id).slice(0, 8)}`;
}

// Resolves { statusCode, body }; statusCode 0 on a network error. Never throws
// for an HTTP status: welcome.sendWelcomeOnce decides what each one means.
async function resendSend(user, apiKey) {
  const { subject, html, text } = welcome.buildWelcomeEmail({ displayName: user.display_name, email: user.email });
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': welcome.idempotencyKeyFor(user.id),
      },
      body: JSON.stringify({
        from: buildFromAddress('broadway'),
        reply_to: buildReplyToAddress(),
        to: [user.email],
        subject,
        html,
        text,
        tags: [{ name: 'category', value: 'welcome' }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    return { statusCode: res.status, body: await res.text() };
  } catch (err) {
    return { statusCode: 0, body: `request error: ${err.message}` };
  }
}

async function captureSent(userId) {
  try {
    const res = await fetch(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event: 'welcome_email_sent',
        distinct_id: userId,
        properties: { user_id: userId, source: 'send-welcome-emails', $process_person_profile: false },
      }),
    });
    if (!res.ok) console.warn(`  PostHog capture HTTP ${res.status} (send still counted)`);
  } catch (err) {
    console.warn(`  PostHog capture failed: ${err.message} (send still counted)`);
  }
}

async function testSend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const fake = { id: `test-${Date.now()}`, email: TEST_SINK, display_name: 'Ada Lovelace' };
  const res = await resendSend(fake, apiKey);
  const outcome = welcome.resendOutcome(res.statusCode, res.body);
  console.log(`Test send to ${TEST_SINK}: HTTP ${res.statusCode} -> ${outcome} ${welcome.redactEmails(res.body).slice(0, 200)}`);
  if (outcome !== 'sent') throw new Error(`test send not accepted (HTTP ${res.statusCode})`);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (process.argv.includes('--test-send')) { await testSend(); return; }

  const dryRun = process.argv.includes('--dry-run');
  const previewSince = argValue('--preview-since');
  if (previewSince && !dryRun) throw new Error('--preview-since is only allowed with --dry-run');

  const sendFrom = previewSince || welcome.WELCOME_EMAIL_SEND_FROM;
  const since = welcome.windowStart({ sendFrom });
  if (!since) {
    console.log('Welcome emails are switched OFF (WELCOME_EMAIL_SEND_FROM is null in scripts/lib/welcome-email.js). Nothing to do.');
    return;
  }
  console.log(`Welcome emails ${previewSince ? `PREVIEW as if switched on at ${previewSince}` : `ON since ${welcome.WELCOME_EMAIL_SEND_FROM}`}; accounts created since ${since.toISOString()}${dryRun ? ' [DRY RUN]' : ''}`);

  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const sentRecent = await db.selectRows('welcome_emails', `select=user_id&sent_at=gte.${encodeURIComponent(dayAgo)}`);
  const allowance = welcome.sendAllowance({ sentLast24h: sentRecent.length });
  console.log(`Sent in the last 24h: ${sentRecent.length}; this run may send ${allowance} (daily cap ${welcome.DAILY_CAP}, per run ${welcome.PER_RUN_CAP})`);

  // Fetch one more than the allowance so a backlog beyond the cap is visible.
  const candidates = await db.rpc('welcome_email_candidates', { p_since: since.toISOString(), p_limit: Math.max(allowance, 0) + 1 });
  console.log(`Candidates: ${candidates.length}${candidates.length > allowance ? ` (more than this run's allowance of ${allowance})` : ''}`);

  if (dryRun) {
    for (const u of candidates.slice(0, Math.max(allowance, 1))) {
      const { subject } = welcome.buildWelcomeEmail({ displayName: u.display_name, email: u.email });
      console.log(`  [DRY] would send to ${label(u)} (created ${u.created_at}, ${welcome.firstNameFrom(u.display_name) ? 'has a name' : 'no name'}): "${subject}"`);
    }
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  let sent = 0;
  const failures = [];
  const rejected = [];
  for (const user of candidates.slice(0, allowance)) {
    const rowFilter = `user_id=eq.${encodeURIComponent(user.id)}`;
    try {
      const r = await welcome.sendWelcomeOnce(user, {
        sendFrom: welcome.WELCOME_EMAIL_SEND_FROM,
        claim: async (id) => (await db.insertIgnoreDuplicates('welcome_emails', { user_id: id })).length === 1,
        release: async () => db.deleteRows('welcome_emails', rowFilter),
        send: (u) => resendSend(u, apiKey),
        recordSent: async (id, resendId) => {
          if (!resendId) return;
          await db.updateRows('welcome_emails', rowFilter, { resend_id: resendId })
            .catch(err => console.warn(`  could not record resend_id for ${label(user)}: ${welcome.redactEmails(err.message)}`));
        },
        recordRejected: async (id, reason) => {
          await db.updateRows('welcome_emails', rowFilter, { failed_reason: reason })
            .catch(err => console.warn(`  could not record failed_reason for ${label(user)}: ${welcome.redactEmails(err.message)}`));
        },
      });
      if (r.status === 'sent') {
        sent++;
        console.log(`  Sent to ${label(user)}`);
        await captureSent(user.id);
      } else if (r.status === 'rejected') {
        rejected.push({ id: user.id, error: r.detail });
        console.error(`  REJECTED by Resend for ${label(user)} (kept as done, will not retry): ${r.detail}`);
      } else {
        console.log(`  Skipped ${label(user)}: ${r.status}`);
      }
    } catch (err) {
      const msg = welcome.redactEmails(err.message).slice(0, 300);
      failures.push({ id: user.id, error: msg });
      console.error(`  FAILED ${label(user)} (claim released, next run retries): ${msg}`);
    }
    await sleep(250);
  }

  console.log(`Done: ${sent} sent, ${rejected.length} rejected, ${failures.length} failed`);
  // Rejected: one alert per account, ever (Resend dedups the key for 24h and
  // the account is never retried, so it cannot come back after that).
  for (const f of rejected) {
    await sendAlert({
      title: 'Welcome email rejected by Resend',
      description: `Resend refused the welcome email for user ${String(f.id).slice(0, 8)}; it will not be retried. ${f.error}`,
      severity: 'error',
      email: true,
      idempotencyKey: `welcome-email-rejected/${f.id}`,
    });
  }
  // Retryable failures: at most one alert per day, however many runs fail.
  if (failures.length) {
    await sendAlert({
      title: 'Welcome email send failed',
      description: `${failures.length} welcome email(s) failed with a retryable error. The claims were released, so the next run (15 min) retries. First error: ${failures[0].error}`,
      severity: 'error',
      email: true,
      fields: failures.slice(0, 5).map(f => ({ name: `user ${String(f.id).slice(0, 8)}`, value: f.error })),
      idempotencyKey: `welcome-email-failed/${new Date().toISOString().slice(0, 10)}`,
    });
  }
  if (failures.length || rejected.length) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Fatal error:', welcome.redactEmails(err.message));
  // Manual dry runs and test sends report in their own log; only the
  // scheduled real run pages the owner.
  const manual = process.argv.some(a => a === '--dry-run' || a === '--test-send' || a.startsWith('--preview-since'));
  if (!manual) await sendAlert({
    title: 'Welcome email job crashed',
    description: `send-welcome-emails.js stopped before sending: ${welcome.redactEmails(err.message).slice(0, 300)}`,
    severity: 'error',
    email: true,
    // One alert per day at most: a paused Supabase project would otherwise
    // page every 15 minutes.
    idempotencyKey: `welcome-email-crash/${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => {});
  process.exit(1);
});
