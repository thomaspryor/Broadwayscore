#!/usr/bin/env node
'use strict';
// BRO-6763: email the owner (only) about each new Profitability Scorecard
// sign-up. Logic in lib/money-signup-notify.js. Never prints addresses.
// Flags: --dry-run (print counts, send nothing), --test-email (send one sample to the owner).
const { planNotifications, buildSignupEmail } = require('./lib/money-signup-notify');

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
  const rows = await readAll(url, key);
  const plan = planNotifications(rows, { secret: key });
  console.log(`rows=${rows.length} real=${plan.total} to_send=${plan.send.length} deferred=${plan.deferred}`);
  const { sendEmailAlert } = require('./lib/discord-notify');
  const out = [];
  if (TEST) {
    const newest = rows.filter(r => r.email).slice(-1)[0];
    out.push({ row: { ...newest, email: 'sample-signup@example.com' }, ordinal: plan.total, key: `money-signup-test:${Date.now()}`, test: true });
  } else out.push(...plan.send);
  let failed = 0;
  for (const item of out) {
    const { subject, html } = buildSignupEmail(item, plan.total);
    if (DRY) { console.log(`[dry-run] would send: ${subject}`); continue; }
    // severity 'error' is the policy's emailable level; subjectLabel '' keeps the subject clean.
    const ok = await sendEmailAlert({ title: item.test ? `[TEST] ${subject}` : subject, description: '', severity: 'error', subjectLabel: '', html, idempotencyKey: item.key });
    if (!ok) { failed++; console.error(`send failed for ordinal ${item.ordinal}`); } else console.log(`sent: ${subject}`);
  }
  if (plan.deferred && !DRY && !TEST) {
    const hour = new Date().toISOString().slice(0, 13);
    const ok = await sendEmailAlert({ title: `${plan.deferred} more Profitability Scorecard sign-ups waiting`, description: 'Over the per-run cap; they are emailed on the next runs. Check the admin sign-ups page.', severity: 'error', subjectLabel: '', idempotencyKey: `money-signup-summary:${hour}` });
    if (!ok) failed++;
  }
  // false from sendEmailAlert also means missing RESEND_API_KEY / OWNER_EMAIL: fail loudly.
  if (failed) process.exit(1);
}
main().catch(e => { console.error(`money-signup-notify failed: ${e.message}`); process.exit(1); });
