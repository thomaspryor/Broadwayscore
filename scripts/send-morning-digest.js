#!/usr/bin/env node
/**
 * send-morning-digest.js — the owner's ONE scheduled daily email.
 *
 * Replaces autonomous-email.js as the consumer of the digest snapshots
 * (cards #364/#497/#511) after the autonomous loop's retirement
 * (2026-07-27, owner decision). Reads ONLY:
 *   - the four snapshot files in scripts/lib/digest-snapshots.js
 *   - the fail-soft "what changed while you slept" collector
 *     (scripts/lib/overnight-digest.js — git/deploy/worktree facts)
 * It deliberately reads NO loop state: no autonomous ledger, no Notion auto
 * states, no approve/reject loop links, no LLM calls. It must never render a
 * triage list or ask the owner to do bookkeeping (owner mandate 2026-07-27:
 * "giant wall of text, completely unactionable" is the failure mode this
 * design forbids).
 *
 * The ONE signed link it does render is the per-error "Fix this" dispatch
 * button (card #634, owner ask 2026-07-30) — that is the opposite of
 * bookkeeping: it turns a "Fix needed: …" line the owner can only read into
 * a line the owner can act on from a phone.
 *
 * RULE 17 (email broadcast safety): TRANSACTIONAL ONLY — direct POST /emails
 * to one explicit recipient. Never a broadcast, never an audience.
 *
 *   node scripts/send-morning-digest.js --send-to you@example.com   send
 *   node scripts/send-morning-digest.js --send-to-owner             send to OWNER_EMAIL from .env
 *   node scripts/send-morning-digest.js --dry-run                   write HTML preview, send nothing
 *
 * Scheduled by scripts/launchd/com.broadwayscore.morning-digest.plist
 * (07:30 ET). Delivery is watched by monitor-scheduled-email-count.js's
 * zero-send floor (CI, 15:00 UTC) — if this job silently dies, that check
 * is the alarm, not the owner's memory.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = path.join(__dirname, '..');

// .env preamble (same pattern as the other launchd-run senders — launchd
// does not inherit shell env, so keys must come from the repo's .env).
for (const envPath of [path.join(REPO, '.env'), '/Users/tompryor/Broadwayscore/.env']) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  break;
}

const { readAllSnapshots, describeProblems } = require('./lib/digest-snapshots.js');
const {
  esc,
  renderHealthDigestBlock,
  renderDailyDigestBlock,
  renderRedditDigestBlock,
  renderNamedDigestBlock,
} = require('./lib/autonomous-email-render.js');
const { attachHealthFixUrls } = require('./lib/dispatch-link.js');

// Fix-this buttons (card #634 — owner ask 2026-07-30: "tap a button in the
// digest, get a session dispatched on the issue, no laptop required").
// Signed dispatch links are NOT the approval-loop links this sender
// deliberately omits (see the header note): they carry no loop bookkeeping
// and ask the owner for no triage — they are the one tap that acts on an
// error row this email already prints as "Fix needed: …".
const DISPATCH_CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
// 20h, NOT the loop's 48h linkExpiryHours (ship-check adversarial finding,
// codex 2026-07-30). This email is sent DAILY at 07:30 ET, so a 48h link
// outlives its own email by a full send cycle: the owner could tap
// yesterday's "Fix this" for an error today's health check already cleared,
// and handleDispatch — which dedups only against still-OPEN cards — would
// happily file a card and burn a session on a non-issue. 20h expires each
// link in the small hours before the next digest lands, so at most one live
// email's buttons are ever tappable. Deliberately independent of the
// approve/reject links' expiry, which is a different lifecycle.
const DISPATCH_LINK_EXPIRY_H = 20;

const USAGE = `send-morning-digest.js — the owner's single scheduled morning email.

Usage:
  node scripts/send-morning-digest.js --send-to <address>   send (rule 17: one explicit recipient)
  node scripts/send-morning-digest.js --send-to-owner       send to OWNER_EMAIL (from .env)
  node scripts/send-morning-digest.js --dry-run             write HTML preview, no send
  --help, -h   show this message, do nothing else`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function httpsJson(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

// Subject contract: MUST match SCHEDULED_SENDERS['morning-digest'].pattern in
// scripts/lib/scheduled-email-count-rules.js — the one-email-per-day monitor
// classifies by this prefix, and the parity test in digest-snapshots.test.mjs
// enforces it. Never a count ("0 items" reads as broken, owner feedback
// 2026-07-27); the site-health escalation suffix is the only variable part.
function buildSubject({ health = null, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(now);
  const errs = health ? (health.errors?.length || 0) : 0;
  const warns = health ? (health.warns?.length || 0) : 0;
  const urgent = health && /URGENT/.test(health.subject || '');
  const suffix = errs || warns
    ? ` · ${urgent ? '⛔' : '⚠️'} site health: ${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`
    : '';
  return `Morning digest — ${dateLabel}${suffix}`;
}

// Sections render via the SAME exported block renderers the old email used —
// identical visual output for the parts the owner kept, none of the loop
// parts. `changes` is overnight-digest.js's pre-rendered HTML block (or null).
function buildHtml({ sections = {}, problemsNote = null, changesHtml = null, stuckCount = 0, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
  }).format(now);
  const parts = [];
  parts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);
  parts.push(`<p style="font-size:15px;font-weight:700;margin:0 0 12px;">Morning digest · ${esc(dateLabel)}</p>`);

  // The 2-second verdict (owner feedback 2026-07-30: "so hard to read and
  // understand … very unactionable"): NAME what needs attention instead of
  // just counting it, and say plainly that warnings are routine watch items.
  const errs = sections.health ? (sections.health.errors?.length || 0) : 0;
  const warns = sections.health ? (sections.health.warns?.length || 0) : 0;
  // Health snapshot items are {name, message} objects; tolerate bare strings.
  const errNames = (sections.health?.errors || []).filter(Boolean)
    .map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean);
  if (errs || stuckCount) {
    const bits = [];
    if (errs) bits.push(`Fix needed: ${errNames.slice(0, 3).join('; ') || `${errs} site error${errs === 1 ? '' : 's'}`}${errNames.length > 3 ? ` (+${errNames.length - 3} more)` : ''}`);
    if (stuckCount) bits.push(`${stuckCount} pipeline item${stuckCount === 1 ? '' : 's'} flagged "possibly stuck" below`);
    parts.push(`<p style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 6px;">${esc(bits.join(' · '))}</p>`);
    if (warns) parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${warns} routine warning${warns === 1 ? '' : 's'} below — being watched, no action needed unless new.</p>`);
  } else if (warns) {
    parts.push(`<p style="font-size:13px;font-weight:700;color:#15803d;margin:0 0 6px;">Nothing urgent this morning.</p>`);
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${warns} routine warning${warns === 1 ? '' : 's'} below — being watched, no action needed unless new.</p>`);
  } else {
    parts.push(`<p style="font-size:13px;font-weight:700;color:#15803d;margin:0 0 12px;">Nothing needs your attention this morning.</p>`);
  }
  if (problemsNote) {
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(problemsNote)}</p>`);
  }

  // Section order (fresh-eyes review): "is the site okay?" first, then what
  // changed, then scores/Reddit. The opening-night radar left this email
  // 2026-07-30 — it's a standalone daily send again (send-opening-digest.js).
  const blocks = [];
  if (sections.health) blocks.push(renderHealthDigestBlock(sections.health));
  if (changesHtml) blocks.push(changesHtml);
  if (sections.dailyDigest) blocks.push(renderDailyDigestBlock(sections.dailyDigest));
  if (sections.redditDigest) blocks.push(renderRedditDigestBlock(sections.redditDigest));
  // Backlog drain metric (task #654) — scripts/backlog-drain.js writes
  // {generatedAt, bannerText, items, moreCount}, the same shape every other
  // named digest uses, so it reuses renderNamedDigestBlock with no new
  // render code.
  if (sections.backlogDrain) blocks.push(renderNamedDigestBlock('Backlog drain', sections.backlogDrain));
  // Scraping spend vs budget (check-provider-spend.js, Scraping Cost System
  // v2) — same {generatedAt, bannerText, items} shape, no new render code.
  if (sections.providerSpend) blocks.push(renderNamedDigestBlock('Scraping spend', sections.providerSpend));

  if (blocks.length) {
    parts.push(blocks.join('\n'));
  } else {
    parts.push(`<p style="font-size:13px;color:#666;margin:0 0 12px;">All quiet — no overnight changes to report.</p>`);
  }

  parts.push(`<p style="color:#999;font-size:11px;margin-top:16px;text-align:center;">Broadway Scorecard morning digest</p>`);
  parts.push(`</div>`);
  return parts.join('\n');
}

// Composes the subject+html the SAME way the real send does: attach Fix-this
// links, then build subject/html — pulled out of main() (CLAUDE.md §15) so
// digest-content-invariants.test.mjs exercises this real caller-to-renderer
// wire, including the attachHealthFixUrls call. Its ABSENCE was card #634's
// root cause — a test that reconstructs this logic instead of calling it
// would not have caught that, which is exactly what happened (renderer unit
// tests fully covered attachHealthFixUrls's OUTPUT, never its caller).
function composeDigestEmail({
  sections, problemsNote = null, changesHtml = null, stuckCount = 0, now = new Date(),
  dispatchSecret = process.env.APPROVAL_HMAC_SECRET, dispatchConfigPath = DISPATCH_CONFIG_PATH,
}) {
  // Card #634: sign a dispatch link per health ERROR so the owner can act
  // from the phone. Fail-soft on purpose — a missing secret costs the
  // buttons, never the email (rule: the digest must always send).
  if (!dispatchSecret) {
    console.error('[digest] WARN APPROVAL_HMAC_SECRET not set — sending without Fix-this buttons');
  } else {
    const cfg = (() => {
      try { return JSON.parse(fs.readFileSync(dispatchConfigPath, 'utf8')); } catch { return {}; }
    })();
    const baseUrl = cfg.baseUrl || 'https://broadwayscorecard.com';
    const exp = Math.floor(Date.now() / 1000) + DISPATCH_LINK_EXPIRY_H * 3600;
    const attached = attachHealthFixUrls({ health: sections.health, exp, secret: dispatchSecret, baseUrl });
    console.log(`[digest] Fix-this buttons attached to ${attached} health error row(s)`);
  }

  const subject = buildSubject({ health: sections.health, now });
  const html = buildHtml({ sections, problemsNote, changesHtml, stuckCount, now });
  return { subject, html };
}

async function main() {
  // --help must never fall through to a real send (bug class #260/#263/#264).
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  let sendTo = args['send-to'] && args['send-to'] !== true ? String(args['send-to']) : null;
  if (!sendTo && args['send-to-owner']) {
    sendTo = process.env.OWNER_EMAIL || null;
    if (!sendTo) { console.error('[digest] --send-to-owner but OWNER_EMAIL is not set (.env)'); process.exit(1); }
  }
  if (!dryRun && !sendTo) {
    console.error('[digest] refusing to run without an explicit recipient (rule 17) — use --send-to <addr>, --send-to-owner, or --dry-run');
    process.exit(1);
  }

  const { sections, problems } = readAllSnapshots();
  const problemsNote = describeProblems(problems);

  // "What changed while you slept" — fail-soft; a broken collector must
  // never block the digest itself.
  let changesHtml = null;
  let stuckCount = 0;
  try {
    const { gatherDigest, renderDigestBlock, countStuckSignals } = require('./lib/overnight-digest.js');
    const digest = gatherDigest({ repo: REPO });
    if (digest) {
      changesHtml = renderDigestBlock(digest);
      stuckCount = countStuckSignals(digest);
    }
  } catch (err) {
    console.error(`[digest] WARN overnight-changes gathering failed: ${String(err.message).slice(0, 120)}`);
  }

  const now = new Date();
  const { subject, html } = composeDigestEmail({ sections, problemsNote, changesHtml, stuckCount, now });

  // Card #670: fail-soft pre-send content check — never blocks the send (the
  // digest must always send), but a violation here means the CI test on
  // composeDigestEmail() didn't catch a regression introduced somewhere else
  // in the render chain, and that must be visible somewhere other than a
  // silently-broken inbox.
  try {
    const { assertDigestInvariants } = require('./lib/digest-content-invariants.js');
    const { ok, violations } = assertDigestInvariants(html, { health: sections.health, subject, verifySecret: process.env.APPROVAL_HMAC_SECRET });
    if (!ok) console.error(`[digest] WARN content invariant violation(s): ${violations.join('; ')}`);
  } catch (err) {
    console.error(`[digest] WARN content invariant check failed to run: ${String(err.message).slice(0, 120)}`);
  }

  if (dryRun) {
    const out = path.join(REPO, 'data', 'audit', 'morning-digest-preview.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`[digest] DRY RUN — preview written to ${out} (subject: ${subject})`);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('[digest] RESEND_API_KEY not set'); process.exit(1); }
  const res = await httpsJson('POST', 'https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}` }, {
    // Same From as the retired morning email on purpose: the owner's Gmail
    // filters, threading, and iOS notification trust key off the sender
    // (plan-review user-impact finding).
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
    to: [sendTo],
    subject,
    html,
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`[digest] send failed: ${res.status} ${JSON.stringify(res.json || {}).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`[digest] sent to ${sendTo} (subject: ${subject} · id ${res.json?.id || '?'})`);
}

if (require.main === module) {
  main().catch((err) => { console.error(`[digest] fatal: ${err.message}`); process.exit(1); });
}

module.exports = { buildSubject, buildHtml, parseArgs, composeDigestEmail };
