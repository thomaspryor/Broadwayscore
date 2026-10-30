#!/usr/bin/env node
/**
 * apply-supabase-email-auth.mjs — the Supabase Auth settings behind email
 * sign-in (BRO-6575): a 6-digit code, no password and no link.
 *
 * Why a script: the settings live in the Supabase dashboard, not in the repo.
 * Supabase's built-in mailer sends 2 emails an hour for the whole project and
 * only to team members, so sign-in mail goes through Resend's SMTP relay
 * (the broadwayscorecard.com domain is verified there). The email template is
 * supabase/templates/sign-in-code.html.
 *
 *   node scripts/apply-supabase-email-auth.mjs            # dry run: prints the diff
 *   node scripts/apply-supabase-email-auth.mjs --apply    # PATCHes the project
 *
 * Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, RESEND_API_KEY (--apply only).
 * Exit: 0 applied or already current, 1 failed, 2 dry run found changes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';

const SUPABASE_API = 'https://api.supabase.com';
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'templates', 'sign-in-code.html');
export const SUBJECT = 'Your Broadway Scorecard sign-in code';
const SECRET_KEYS = new Set(['smtp_pass']);

/** The auth config fields this script owns. Pure; tested. */
export function buildEmailAuthPatch({ template, resendKey }) {
  if (!/\{\{ \.Token \}\}/.test(template)) throw new Error('template must contain {{ .Token }}');
  // A link would share the code's token (see the template's comment).
  if (/\{\{ \.ConfirmationURL \}\}/.test(template.replace(/<!--[\s\S]*?-->/g, ''))) throw new Error('template must not contain a sign-in link');
  return {
    external_email_enabled: true,
    // Codes, not passwords: 6 digits are what people expect to type.
    mailer_otp_length: 6,
    mailer_otp_exp: 3600,
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: resendKey,
    smtp_admin_email: 'noreply@broadwayscorecard.com',
    smtp_sender_name: 'Broadway Scorecard',
    // Per address: one email a minute (GoTrue default). Project-wide: an hour's
    // cap well above any sign-up burst after an opening-night email.
    smtp_max_frequency: 60,
    rate_limit_email_sent: 200,
    // New addresses get "Confirm signup", known ones "Magic link"; both carry the code.
    mailer_subjects_magic_link: SUBJECT,
    mailer_subjects_confirmation: SUBJECT,
    mailer_templates_magic_link_content: template,
    mailer_templates_confirmation_content: template,
  };
}

/** Fields whose live value differs from the patch. smtp_pass is never readable, so it always counts once unset. */
export function diffPatch(patch, live) {
  return Object.keys(patch).filter((k) => {
    if (SECRET_KEYS.has(k)) return !live[k];
    return String(live[k] ?? '') !== String(patch[k]);
  });
}

async function api(method, body) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const res = await fetch(`${SUPABASE_API}/v1/projects/${ref}/config/auth`, {
    method,
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} config/auth -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const apply = process.argv.includes('--apply');
  for (const k of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', ...(apply ? ['RESEND_API_KEY'] : [])]) {
    if (!process.env[k]) { console.error(`missing ${k}`); process.exit(1); }
  }
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const patch = buildEmailAuthPatch({ template, resendKey: process.env.RESEND_API_KEY || 'unset' });
  const live = await api('GET');
  const changed = diffPatch(patch, live);
  if (!changed.length) { console.log('Supabase email sign-in settings are current.'); return; }
  for (const k of changed) {
    const show = (v) => (SECRET_KEYS.has(k) ? (v ? '<set>' : '<unset>') : JSON.stringify(String(v ?? '')).slice(0, 80));
    console.log(`${k}: ${show(live[k])} -> ${show(patch[k])}`);
  }
  if (!apply) { console.log('\nDry run. Re-run with --apply to write these.'); process.exit(2); }
  await api('PATCH', Object.fromEntries(changed.map((k) => [k, patch[k]])));
  const after = diffPatch(patch, await api('GET'));
  if (after.length) { console.error(`still different after PATCH: ${after.join(', ')}`); process.exit(1); }
  console.log(`\nApplied ${changed.length} setting(s); live config now matches.`);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
