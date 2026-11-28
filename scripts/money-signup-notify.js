#!/usr/bin/env node
'use strict';
// BRO-6763: email the owner (only) about each new Profitability Scorecard
// sign-up. Logic in lib/money-signup-notify.js. Never prints addresses.
// Flags: --dry-run (print counts, send nothing), --test-email (send one sample to the owner).
const { planNotifications, buildSignupEmail, buildDigestEmail } = require('./lib/money-signup-notify');

const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/money-signup-notify.js [--dry-run | --test-email]\nEmails the owner (only) about new Profitability Scorecard sign-ups. --dry-run sends nothing; --test-email sends one sample.');
  process.exit(0);
}
const DRY = process.argv.includes('--dry-run');
const TEST = process.argv.includes('--test-email');

async function readAll(url, key) {
  const rows = [];
  for (let page = 0; page < 100; page++) {
    const u = new URL('/rest/v1/money_scorecard_signups', url);
    u.search = new URLSearchParams({
      select: 'email,created_at,role,first_page,signup_count', order: 'created_at.asc,email.asc',
      limit: '1000', offset: String(rows.length),
    }).toString();
    const res = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Supabase read returned a non-array');
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
  throw new Error('Supabase read exceeded page cap');
}

async function main() {
  const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  // sendEmailAlert returns false (no throw) without these: fail on quiet days too.
  if (!DRY && (!process.env.RESEND_API_KEY || !process.env.OWNER_EMAIL)) throw new Error('RESEND_API_KEY / OWNER_EMAIL not set');
  const rows = await readAll(url, key);
  const plan = planNotifications(rows, { secret: key });
  console.log(`rows=${rows.length} real=${plan.total} to_send=${plan.send.length} digest=${plan.digest ? plan.digest.items.length : 0}`);
  const { sendEmailAlert } = require('./lib/discord-notify');
  const out = [];
  if (TEST) {
    out.push({ row: { email: 'sample-signup@example.com', role: 'fan', first_page: 'biz-season:/biz/season/2026-2027', signup_count: 1, created_at: new Date().toISOString() }, ordinal: plan.total + 1, key: `money-signup-test:${Date.now()}`, test: true });
  } else out.push(...plan.send);
  let failed = 0;
  for (const item of out) {
    const { subject, html } = buildSignupEmail(item, plan.total);
    if (DRY) { console.log(`[dry-run] would send: ${subject}`); continue; }
    // severity 'error' is the policy's emailable level; subjectLabel '' keeps the subject clean.
    const ok = await sendEmailAlert({ title: item.test ? `[TEST] ${subject}` : subject, description: '', severity: 'error', subjectLabel: '', html, idempotencyKey: item.key });
    if (!ok) { failed++; console.error(`send failed for ordinal ${item.ordinal}`); } else console.log(`sent: ${subject}`);
  }
  if (plan.digest && !DRY && !TEST) {
    const { subject, html } = buildDigestEmail(plan.digest, plan.total);
    const ok = await sendEmailAlert({ title: subject, description: '', severity: 'error', subjectLabel: '', html, idempotencyKey: plan.digest.key });
    if (!ok) failed++; else console.log(`sent digest of ${plan.digest.items.length}`);
  }
  // false from sendEmailAlert also means missing RESEND_API_KEY / OWNER_EMAIL: fail loudly.
  if (failed) process.exit(1);
}
main().catch(e => { console.error(`money-signup-notify failed: ${e.message}`); process.exit(1); });
