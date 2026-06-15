// Create a Resend BROADCAST DRAFT for the weekly newsletter. NEVER SENDS.
//
// This is the sanctioned rule-16/rule-17-safe wrapper for the weekly newsletter
// (CLAUDE.md §17 + cloud-memory/email-broadcast-rules.md). It mirrors the
// fantasy path (scripts/fantasy-weekly-email.js --draft): it creates a broadcast
// in DRAFT state and stops. The owner reviews the draft in the Resend dashboard
// and clicks Send there. THERE IS NO SEND PATH IN THIS SCRIPT — no flag, no
// branch, calls POST /broadcasts only, never POST /broadcasts/{id}/send.
//
// Why this exists: "Scorecard Weekly — <date>" broadcasts were created ad-hoc
// every week (manual UI paste, or a one-off API call from a Claude session).
// That meant re-deriving the audience id, the from address, the unsubscribe
// handling, and the lock every single time — and getting it subtly wrong. This
// commits the recipe once.
//
// Usage:
//   node scripts/newsletter/create-broadcast-draft.mjs <weekStart YYYY-MM-DD> [options]
//
// Options:
//   --create                Actually create the draft. WITHOUT this flag the
//                           script is a DRY RUN that only prints what it would do.
//   --audience=<key>        general (default) | west-end | test
//   --subject="..."         Override the subject (defaults to meta.json subject).
//   --name="..."            Override the broadcast name (default "Scorecard Weekly — <weekStart>").
//   --out-dir=<path>        Where the generated HTML/meta live (default:
//                           $NEWSLETTER_OUT_DIR or ~/Documents/claude-outputs/newsletter-mocks).
//
// Required env: RESEND_API_KEY.
//
// The HTML is consumed verbatim: the generator emits {{{RESEND_UNSUBSCRIBE_URL}}}
// as the unsubscribe link, and Resend substitutes that token per-recipient at
// broadcast send time. (send-test.mjs replaces it with a real URL because
// transactional sends don't get that substitution — broadcasts do, so we leave
// the token in place here.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const cjsRequire = createRequire(import.meta.url);
const { acquireSendLock, releaseSendLock } = cjsRequire(path.join(repo, 'scripts/lib/send-lock.js'));

// --- Audiences (verified live 2026-06-14 via GET /audiences) -------------------
// General is the weekly newsletter list. west-end is the smaller WE list.
// "test" is the dedicated Broadcast Test audience — the ONLY safe place to point
// a throwaway draft (rule 17: never test against a real subscriber audience).
const AUDIENCES = {
  general: { id: '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4', label: 'General' },
  'west-end': { id: '0b17260b-6a72-4a5a-a700-7b7526f18d87', label: 'West End' },
  test: { id: 'b1255239-ad6e-415f-b837-4536c05c6d9b', label: 'Broadcast Test' },
};
const FROM_EMAIL = 'Broadway Scorecard <updates@broadwayscorecard.com>';
const RESEND_BROADCASTS_URL = ['https://api.resend.com', 'broadcasts'].join('/');

// --- Arg parsing ---------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = {};
for (const a of argv.filter((a) => a.startsWith('--'))) {
  const eq = a.indexOf('=');
  if (eq === -1) flags[a.slice(2)] = true;
  else flags[a.slice(2, eq)] = a.slice(eq + 1);
}

const weekStart = positional[0];
if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
  console.error('Usage: node scripts/newsletter/create-broadcast-draft.mjs <weekStart YYYY-MM-DD> [--create] [--audience=general|west-end|test] [--subject="..."]');
  process.exit(1);
}
const isCreate = flags.create === true;
const audienceKey = (flags.audience || 'general').toString();
const audience = AUDIENCES[audienceKey];
if (!audience) {
  console.error(`Unknown audience "${audienceKey}". Valid: ${Object.keys(AUDIENCES).join(', ')}`);
  process.exit(1);
}

const outDir = (flags['out-dir'] || process.env.NEWSLETTER_OUT_DIR
  || path.join(os.homedir(), 'Documents/claude-outputs/newsletter-mocks')).toString();
const htmlPath = path.join(outDir, `A-${weekStart}.html`);
const metaPath = path.join(outDir, `A-${weekStart}.meta.json`);
if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) {
  console.error(`Missing generated files for ${weekStart} in ${outDir}`);
  console.error(`Expected: ${path.basename(htmlPath)} + ${path.basename(metaPath)}`);
  console.error('Run scripts/newsletter/generate.mjs first (with SUBJECT_OVERRIDE/LEDE_OVERRIDE if needed).');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const subject = (flags.subject || meta.subject || '').toString().trim();
const name = (flags.name || `Scorecard Weekly — ${weekStart}`).toString();

// --- Sanity gates (fail loudly before any API call) ----------------------------
const problems = [];
if (!subject) problems.push('Subject is empty (no meta.subject and no --subject).');
if (/^scorecard weekly:/i.test(subject)) problems.push('Subject uses the banned "Scorecard Weekly:" prefix (see pre-send-check.mjs).');
if (!html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}')) problems.push('HTML is missing the {{{RESEND_UNSUBSCRIBE_URL}}} token — Resend needs it to render an unsubscribe link.');
if (problems.length) {
  console.error('Refusing to proceed:');
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}

function summary() {
  console.error('Newsletter broadcast draft');
  console.error(`  weekStart : ${weekStart}`);
  console.error(`  audience  : ${audience.label} (${audience.id})`);
  console.error(`  name      : ${name}`);
  console.error(`  subject   : ${subject}`);
  console.error(`  from      : ${FROM_EMAIL}`);
  console.error(`  html      : ${htmlPath} (${html.length} bytes)`);
}

function apiHeaders() {
  return { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
}

async function apiJSON(method, url, payload) {
  const opt = { method, headers: apiHeaders() };
  if (payload !== undefined) opt.body = JSON.stringify(payload);
  const res = await fetch(url, opt);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`Resend ${res.status} on ${method}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

// Idempotency: find an existing DRAFT broadcast with this exact name so a
// re-run (after a content edit, like this week's mover-rule change) UPDATES the
// same draft instead of leaving a duplicate behind. SENT broadcasts are never
// matched (status !== 'draft' is ignored) — this script never touches a send.
async function findExistingDraft() {
  const list = await apiJSON('GET', RESEND_BROADCASTS_URL);
  const all = (list && list.data) || [];
  const matches = all.filter((b) => b && b.name === name && b.status === 'draft');
  if (matches.length > 1) {
    throw new Error(`${matches.length} draft broadcasts named "${name}" exist — refusing to guess which to update. Resolve in the Resend UI.`);
  }
  return matches[0] || null;
}

(async () => {
  summary();

  if (!isCreate) {
    console.error('\n[DRY RUN] No draft created. Re-run with --create to create the draft in Resend.');
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('\nRESEND_API_KEY is required for --create.');
    process.exit(1);
  }

  // Cross-session advisory lock (GitHub-backed; same gate the send wrappers use)
  // so two sessions can't race a duplicate draft for the same week.
  let lock;
  try {
    lock = acquireSendLock({ purpose: `newsletter-draft-${weekStart}` });
  } catch (e) {
    console.error(`\nCould not acquire send lock: ${e.message}`);
    console.error('Pass nothing to retry, or check data/email-send.lock on origin.');
    process.exit(1);
  }
  if (!lock.acquired) {
    console.error(`\nSEND LOCK REFUSED: ${lock.reason}`);
    console.error('Another session is creating a draft right now. Try again shortly.');
    process.exit(1);
  }
  console.error(`  lock      : acquired (${(lock.sessionId || '').slice(0, 8)})`);

  try {
    const payload = { audience_id: audience.id, from: FROM_EMAIL, subject, html, name };
    const existing = await findExistingDraft();
    let id;
    if (existing) {
      await apiJSON('PATCH', `${RESEND_BROADCASTS_URL}/${existing.id}`, payload);
      id = existing.id;
      console.error(`\n✓ Existing draft updated: ${id}`);
    } else {
      const result = await apiJSON('POST', RESEND_BROADCASTS_URL, payload);
      id = result && result.id;
      console.error(`\n✓ Draft created: ${id}`);
    }
    console.error(`  Review & send in Resend: https://resend.com/broadcasts/${id}`);
    console.error('  This script did NOT send. Open the link, review, and hit Send in the Resend UI.');
  } catch (e) {
    console.error(`\n✗ Draft create/update failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { releaseSendLock(lock); } catch { /* best-effort */ }
  }
})();
