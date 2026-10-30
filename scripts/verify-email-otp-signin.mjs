#!/usr/bin/env node
/**
 * verify-email-otp-signin.mjs — live check that email-code sign-in works on
 * the real Supabase project (BRO-6575), without sending any email.
 *
 * The admin API mints the same one-time code the email would carry
 * (generate_link returns it), then the public anon client signs in with
 * verifyOtp({ type: 'email' }) exactly as the website and app do. Cases:
 *   new       a never-seen address: an account is created, then deleted here.
 *   existing  dev-test@broadwayscorecard.com (a password account): the code
 *             must sign into that same account, not create a second one.
 *
 *   node scripts/verify-email-otp-signin.mjs
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Exit: 0 all cases pass, 1 a case failed.
 */
import { createClient } from '@supabase/supabase-js';
import { isMainModule } from './lib/is-main-module.mjs';

const EXISTING = 'dev-test@broadwayscorecard.com';

async function admin(path, method, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function signInWithCode(email) {
  const link = await admin('generate_link', 'POST', { type: 'magiclink', email });
  const code = link.email_otp ?? link.properties?.email_otp;
  if (!/^\d+$/.test(code || '')) throw new Error(`no numeric code from generate_link (got ${typeof code})`);
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) throw new Error(`verifyOtp: ${error.code || ''} ${error.message}`);
  // A second use of the same code must fail (single use).
  const again = await client.auth.verifyOtp({ email, token: code, type: 'email' });
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
  return { userId: data.user?.id, codeLength: code.length, reusable: !again.error, linkUserId: link.id ?? link.user?.id };
}

async function main() {
  for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[k]) { console.error(`missing ${k}`); process.exit(1); }
  }
  let failed = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; };

  const fresh = `otp-check-${Date.now()}@broadwayscorecard.com`;
  let freshId = null;
  try {
    const r = await signInWithCode(fresh);
    freshId = r.userId;
    check(!!r.userId, `new address signs in and gets an account (${r.codeLength}-digit code)`);
    check(!r.reusable, 'new address: the code works only once');
  } catch (e) {
    check(false, `new address: ${e.message}`);
  } finally {
    if (freshId) await admin(`users/${freshId}`, 'DELETE').then(() => console.log('cleaned up the test account'), (e) => check(false, `cleanup: ${e.message}`));
  }

  try {
    const before = await admin(`users?per_page=1&filter=${encodeURIComponent(EXISTING)}`, 'GET').catch(() => null);
    const r = await signInWithCode(EXISTING);
    const known = before?.users?.find((u) => u.email === EXISTING)?.id ?? r.linkUserId;
    check(!!r.userId && (!known || r.userId === known), `existing account signs into the same user${known ? '' : ' (id not cross-checked)'}`);
    check(!r.reusable, 'existing account: the code works only once');
  } catch (e) {
    check(false, `existing account: ${e.message}`);
  }

  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
