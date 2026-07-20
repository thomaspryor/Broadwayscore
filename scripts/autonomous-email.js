#!/usr/bin/env node
/**
 * autonomous-email.js — the morning evidence email (S2-T6).
 *
 * Gathers needs-approval cards (Notion Auto select) + their ledger evidence,
 * builds signed Approve/Reject links, renders via
 * scripts/lib/autonomous-email-render.js, and sends ONE transactional email
 * to the owner via Resend.
 *
 *   node scripts/autonomous-email.js --send-to you@example.com   send
 *   node scripts/autonomous-email.js --dry-run                   write HTML preview, send nothing
 *
 * RULE 17 (email broadcast safety): this script is TRANSACTIONAL ONLY —
 * direct POST /emails to one explicit --send-to recipient. It must never
 * touch broadcast endpoints or Resend audiences, and it REFUSES to run
 * without an explicit recipient.
 *
 * Usage numbers: ledger estimates by default; if ANTHROPIC_ADMIN_KEY is set
 * the account-level Admin API replaces them (actual USD + spend limit),
 * with the loop's own ledger share broken out. Both paths fail soft.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ledger = require('./lib/autonomous-ledger.js');
const { buildActionUrl } = require('./lib/autonomous-links.js');
const { renderEmail, extractWhy, summarizeQueue, buildPlainLanguageItemPrompt, sanitizePlainLanguageText } = require('./lib/autonomous-email-render.js');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
const MAX_EMAIL_ITEMS = 3;
const QUEUE_SUMMARY_MAX_AGE_H = 24; // stale queues describe a different night
// Cheap model for the plain-language item copy (owner scope-add 2026-07-14)
// — one short call per item, ≤3 items/night.
const PLAIN_LANGUAGE_MODEL = process.env.AUTONOMOUS_EMAIL_COPY_MODEL || 'claude-haiku-4-5-20251001';

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

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

function httpsJson(method, url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, res => {
      let out = '';
      res.on('data', c => out += c);
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

// ── Plain-language item copy (owner scope-add 2026-07-14) ──────────────────
// One cheap LLM call per item so the owner can decide approve/reject from
// plain language alone, instead of the card's own Why/Done text (function
// names, file paths, test commands — "I don't follow this at all" verdict on
// the first real email). Fail-soft: no ANTHROPIC_API_KEY, a non-200, or a
// network error just means renderItem() falls back to the old technical
// layout — a broken copy call must never block the email itself.
async function generatePlainLanguageText(item) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await httpsJson('POST', 'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model: PLAIN_LANGUAGE_MODEL, max_tokens: 300, messages: [{ role: 'user', content: buildPlainLanguageItemPrompt(item) }] });
    if (res.status !== 200 || !res.json) return null;
    const text = (res.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = sanitizePlainLanguageText(text);
    return clean || null;
  } catch {
    return null;
  }
}

// ── Admin API (real account numbers) — fail-soft ────────────────────────────

async function fetchAdminUsage() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return null;
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  try {
    const cost = await httpsJson('GET',
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(since)}&bucket_width=1d`, headers);
    if (cost.status !== 200 || !cost.json) return null;
    // Walk the report defensively: sum every numeric amount field found in
    // the buckets (the report schema has shifted; exactness matters less
    // than never crashing the morning email).
    let usd = 0;
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'amount' && Number.isFinite(parseFloat(v))) usd += parseFloat(v);
          else walk(v);
        }
      }
    };
    walk(cost.json.data || cost.json.results || []);
    return { actualUSD7d: Math.round(usd * 100) / 100, spendLimitUSD: null };
  } catch {
    return null;
  }
}

// ── Assemble items ──────────────────────────────────────────────────────────

function latestEvidenceByCard(entries) {
  const by = new Map();
  for (const e of entries) {
    if (e.event === 'card-pass' && e.cardId) by.set(e.cardId, e);
  }
  return by;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const sendTo = args['send-to'];
  if (!dryRun && (!sendTo || sendTo === true)) {
    console.error('[email] refusing to run without an explicit --send-to <owner-address> (rule 17: transactional only) — or use --dry-run');
    process.exit(1);
  }

  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const baseUrl = cfg.baseUrl || 'https://broadwayscorecard.com';
  const expiryH = Number(cfg.linkExpiryHours) || 48;
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[email] APPROVAL_HMAC_SECRET not set — cannot sign action links'); process.exit(1); }

  const { entries } = ledger.readEntries();
  const stats = ledger.usageStats(entries);
  const evidence = latestEvidenceByCard(entries);

  // Needs-approval cards, priority order (notion-brain list default); ≤3 in
  // the email. A listing FAILURE must never masquerade as "no items to
  // approve" (ship-check P1) — the email says so and the subject warns.
  let awaiting = [];
  let listingFailed = false;
  try { awaiting = notionBrain(['list', '--auto', 'needs-approval', '--limit', '50']); }
  catch (err) {
    listingFailed = true;
    console.error(`[email] WARN could not list needs-approval cards: ${err.message.slice(0, 120)}`);
  }

  const exp = Math.floor(Date.now() / 1000) + expiryH * 3600;
  const items = [];
  let missingEvidence = 0;
  for (const row of awaiting.slice(0, MAX_EMAIL_ITEMS)) {
    const ev = evidence.get(row.id) || {};
    const evd = ev.evidence || {};
    let why = null;
    try { why = extractWhy(notionBrain(['get', row.id]).notes); } catch { /* keep null */ }
    // Never sign action links for a branch we have no ledger evidence for —
    // an approve tap must always refer to a branch the executor pushed.
    if (!evd.branch) { missingEvidence++; continue; }
    const branch = evd.branch;
    const newItem = {
      name: row.name,
      why,
      summary: evd.summary || null,
      branch,
      usd: ev.totalUSD || 0,
      checks: evd.checks || [],
      approveUrl: buildActionUrl({ action: 'approve', cardId: row.id, branch, exp, secret, baseUrl }),
      rejectUrl: buildActionUrl({ action: 'reject', cardId: row.id, branch, exp, secret, baseUrl }),
    };
    // Plain-language primary text (owner scope-add 2026-07-14) — fail-soft,
    // never blocks the email; renderItem() falls back to the old technical
    // layout if this comes back null.
    newItem.plainText = await generatePlainLanguageText(newItem);
    items.push(newItem);
  }

  // Per-execution facts come from the LAST segment of the run: a runId can
  // span several executions (preflight skip → manual re-run adopts the same
  // queue.runId), and a stale skip banner or fail count must not outlive a
  // successful re-run (ship-check finding).
  const runEntries = stats.runId ? ledger.entriesForLastSegment(entries, stats.runId) : [];
  const failedCount = runEntries.filter(e => e.event === 'card-fail').length;
  const runEnd = runEntries.find(e => e.event === 'run-end');
  const throttled = runEnd && /^throttled:/.test(runEnd.note || '') ? runEnd.note.replace(/^throttled:\s*/, '') : null;
  // Auth pre-flight skip (night-1 fix #3): surface the run-skip note verbatim
  // so an expired login is never a silent no-op night.
  const runSkip = runEntries.find(e => e.event === 'run-skip');
  const runSkipped = runSkip ? runSkip.note || 'run skipped (see ledger)' : null;
  const lastTs = ledger.lastEntryTs(entries);
  const lastRunNote = lastTs ? `last run activity ${new Date(lastTs).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no runs recorded yet';

  // 0-planned skip breakdown (night-1 fix #2) — fail-soft: a missing or
  // stale queue just omits the section, never blocks the morning email.
  let queueSummary = null;
  let freshQueue = null;
  try {
    const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    const ageH = (Date.now() - new Date(queue.generatedAt).getTime()) / 3600e3;
    if (ageH < QUEUE_SUMMARY_MAX_AGE_H) { queueSummary = summarizeQueue(queue); freshQueue = queue; }
  } catch { /* no queue on this machine — skip the section */ }

  // Needs-your-attention (2026-07-19 wedge postmortem): every state that
  // silently stalls the loop, with the owner action. Fail-soft per source —
  // a Notion hiccup must never block the email.
  //   config-warnings: tonight's run segment (inadmissibleSizes etc.)
  //   failed cards:    auto=failed — parked until the OWNER clears Auto
  //   parked items:    planned at a size the config doesn't enable (L, or a
  //                    size-floor bump past the enabled set) — skipped nightly
  const attention = { configWarnings: [], failedCards: [], parkedItems: [] };
  for (const e of runEntries) {
    // Strip the note's own "config-warning: " prefix — the block's label
    // already says "config" (review tidy).
    if (e.event === 'config-warning' && e.note) attention.configWarnings.push(String(e.note).replace(/^config-warning:\s*/, ''));
  }
  try {
    attention.failedCards = (notionBrain(['list', '--auto', 'failed', '--limit', '10']) || [])
      .map(c => ({ name: c.name }));
  } catch (err) {
    console.error(`[email] WARN could not list auto=failed cards: ${err.message.slice(0, 120)}`);
  }
  if (freshQueue) {
    const enabled = new Set(Array.isArray(cfg.sizes) ? cfg.sizes : ['S']);
    for (const p of [...(freshQueue.plan || []), ...(freshQueue.dataPlan || [])]) {
      if (p && p.size && !enabled.has(p.size)) attention.parkedItems.push({ name: p.name, size: p.size });
    }
  }
  const attentionCount = attention.configWarnings.length + attention.failedCards.length + attention.parkedItems.length;

  const admin = await fetchAdminUsage();
  const html = renderEmail({
    items,
    moreAwaiting: Math.max(0, awaiting.length - items.length),
    failedCount,
    runSkipped,
    queueSummary,
    attention,
    throttled: listingFailed
      ? 'could not read the approval queue from Notion — items below may be incomplete; check the cards directly'
      : missingEvidence
        ? `${missingEvidence} needs-approval card(s) have no ledger evidence on this machine — no action links generated for them${throttled ? `; ${throttled}` : ''}`
        : throttled,
    stats,
    admin,
    config: { weeklyUSD: cfg.weeklyUSD ?? null },
    lastRunNote,
    awaitingTotal: awaiting.length,
  });

  // A skipped run outranks everything in the subject — stale approvals from
  // earlier nights must not hide an expired login (ship-check finding).
  const skipLabel = runSkipped ? (/^auth:/.test(runSkipped) ? 'login expired on Mac Studio' : 'preflight failed') : null;
  const subject = runSkipped
    ? `Overnight: ⛔ run skipped — ${skipLabel}${items.length ? ` (+${items.length} still awaiting your tap)` : ''}`
    : listingFailed
      ? `Overnight: ⚠️ could not read the approval queue`
      : items.length
        ? `Overnight: ${items.length} item${items.length > 1 ? 's' : ''} awaiting your tap — ${items.map(i => i.name).join(' · ').slice(0, 80)}`
        : attentionCount
          ? `Overnight: ⚠️ ${attentionCount} item${attentionCount > 1 ? 's' : ''} stalling the loop — needs your triage`
          : queueSummary
            ? `Overnight: no items to approve (${queueSummary.total} triaged, 0 workable)`
            : `Overnight: no items to approve (${failedCount} failed)`;

  if (dryRun) {
    const out = path.join(REPO, 'data', 'audit', 'autonomous-email-preview.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`[email] DRY RUN — preview written to ${out} (${items.length} item(s), subject: ${subject})`);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('[email] RESEND_API_KEY not set'); process.exit(1); }
  const res = await httpsJson('POST', 'https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}` }, {
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
    to: [sendTo],
    subject,
    html,
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`[email] send failed: ${res.status} ${JSON.stringify(res.json || {}).slice(0, 200)}`);
    process.exit(1);
  }
  ledger.appendEntry({ event: 'email', runId: stats.runId || undefined, note: `sent to ${sendTo}: ${items.length} item(s), ${failedCount} failed` });
  console.log(`[email] sent to ${sendTo} (${items.length} item(s) · id ${res.json?.id || '?'})`);
}

if (require.main === module) {
  main().catch(err => { console.error(`[email] fatal: ${err.message}`); process.exit(1); });
}

module.exports = { fetchAdminUsage, latestEvidenceByCard, MAX_EMAIL_ITEMS };
