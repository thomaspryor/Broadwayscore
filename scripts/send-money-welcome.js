#!/usr/bin/env node
'use strict';

// BRO-6309: welcome email for new Profitability Scorecard sign-ups. Logic lives in
// scripts/lib/money-welcome.js. Run hourly by .github/workflows/money-welcome.yml.
//
//   node scripts/send-money-welcome.js                 real run (needs MONEY_WELCOME_ENABLED=true)
//   node scripts/send-money-welcome.js --dry-run       read-only: who would get it
//   node scripts/send-money-welcome.js --send-to=ADDR  one preview email to ADDR, no database
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, MONEY_WELCOME_ENABLED.
// Transactional only: POST /emails, one recipient per call (CLAUDE.md §17). Never prints addresses.

const { hasHelpFlag } = require('./lib/cli-help.js');
const { enforceLocalSendGuard } = require('./lib/local-send-guard');
const w = require('./lib/money-welcome');

const USAGE = `send-money-welcome.js: welcome email for new Profitability Scorecard sign-ups (BRO-6309).

Usage:
  node scripts/send-money-welcome.js [--dry-run] [--send-to=ADDRESS] [--allow-local-send]
  node scripts/send-money-welcome.js --help, -h    print this usage and exit
`;

const base = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const hdr = (prefer) => {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) };
};
const enc = encodeURIComponent;

async function resendSend(row, apiKey, { preview = false } = {}) {
  const { subject, text, html, headers } = w.buildWelcomeEmail(row);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`,
      ...(preview ? {} : { 'Idempotency-Key': w.idempotencyKey(row.email, process.env.SUPABASE_SERVICE_ROLE_KEY) }) },
    body: JSON.stringify({ from: w.FROM, reply_to: w.REPLY_TO, to: [row.email], subject: preview ? `[PREVIEW] ${subject}` : subject,
      text, html, headers, tags: [{ name: 'category', value: 'money-welcome' }] }),
    signal: AbortSignal.timeout(30000),
  });
  return { statusCode: res.status };
}

async function claim(email) {
  const res = await fetch(`${base()}/rest/v1/money_scorecard_signups?email=eq.${enc(email)}&welcomed_at=is.null&unsubscribed_at=is.null`, {
    method: 'PATCH', headers: hdr('return=representation'), body: JSON.stringify({ welcomed_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`claim: HTTP ${res.status}`);
  return (await res.json()).length === 1;
}

async function release(email) {
  const res = await fetch(`${base()}/rest/v1/money_scorecard_signups?email=eq.${enc(email)}`, {
    method: 'PATCH', headers: hdr('return=minimal'), body: JSON.stringify({ welcomed_at: null }), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`release: HTTP ${res.status}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  enforceLocalSendGuard('money-welcome.yml', { previewFlags: ['--dry-run', '--send-to='] });
  const sendTo = (argv.find((a) => a.startsWith('--send-to=')) || '').slice('--send-to='.length);
  const dryRun = argv.includes('--dry-run');
  const apiKey = process.env.RESEND_API_KEY;

  if (sendTo) {
    if (!apiKey) throw new Error('RESEND_API_KEY not set');
    const r = await resendSend({ email: sendTo }, apiKey, { preview: true });
    console.log(`Preview sent: HTTP ${r.statusCode}`);
    if (r.statusCode < 200 || r.statusCode >= 300) process.exit(1);
    return;
  }
  let fileEnabled = false;
  try { fileEnabled = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'config', 'money-welcome.json'), 'utf8')).enabled === true; } catch { fileEnabled = false; }
  const enabled = w.resolveEnabled({ envValue: process.env.MONEY_WELCOME_ENABLED, fileEnabled });
  if (!w.runAllowed({ enabled, preview: dryRun })) {
    console.log('Money welcome emails are switched OFF (scripts/config/money-welcome.json is not enabled, or MONEY_WELCOME_ENABLED is "false"). Nothing to do.');
    return;
  }
  const res = await fetch(`${base()}/rest/v1/money_scorecard_signups?select=email,created_at,welcomed_at,unsubscribed_at&welcomed_at=is.null&unsubscribed_at=is.null&order=created_at.asc,email.asc&limit=${w.PER_RUN_CAP * 4}`,
    { headers: hdr(), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`select: HTTP ${res.status}`);
  const rows = await res.json();
  if (dryRun) {
    const p = w.planWelcomes(rows);
    console.log(`DRY RUN: ${rows.length} unwelcomed rows, ${p.send.length} would be emailed, skipped ${JSON.stringify(p.skipped)}`);
    return;
  }
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const out = await w.sendWelcomes(rows, { claim, release, send: (row) => resendSend(row, apiKey) });
  console.log(`Done: sent=${out.sent} rejected=${out.rejected} stamped=${out.stamped} lost_claim=${out.lost_claim} halted=${out.halted} skipped=${JSON.stringify(out.skipped)}`);
  if (out.flood) {
    console.error('FLOOD GUARD: more than ' + w.FLOOD_LIMIT + ' new sign-ups waiting in one run. Nothing was sent. Check for junk sign-ups, then clear them or raise the limit.');
    process.exit(1);
  }
  if (out.halted || out.rejected > 0) {
    console.error('Resend refused one or more welcome sends (halted=' + out.halted + ', rejected=' + out.rejected + '). Check the payload; rejected rows are not retried.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(`send-money-welcome failed: ${e.message}`); process.exit(1); });
