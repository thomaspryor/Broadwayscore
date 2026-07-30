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
const { gatherDigest } = require('./lib/overnight-digest.js');
const { buildActionUrl } = require('./lib/autonomous-links.js');
const { buildDispatchUrl, attachHealthFixUrls } = require('./lib/dispatch-link.js');
const { renderEmail, extractWhy, summarizeQueue, buildPlainLanguageItemPrompt, sanitizePlainLanguageText, actionableAttentionCountOf } = require('./lib/autonomous-email-render.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { summarize: summarizeRecheck, describeResult } = require('./lib/autonomous-recheck-core.js');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
// Card #364 (owner merge decision 2026-07-26): health-check.js used to email
// its own "BSC Daily"/"BSC URGENT" digest separately from this one. It now
// writes its results here instead; this is the ONE place that reads it back
// out, so one scheduled morning email carries both, not two.
const HEALTH_DIGEST_PATH = path.join(REPO, 'data', 'audit', 'health-digest-snapshot.json');
// data-health-check.yml runs once/day — a snapshot older than this means the
// cron itself is stuck or broken, not just "yesterday's news"; show nothing
// rather than pass off day-old health data as this morning's.
const HEALTH_DIGEST_MAX_AGE_H = 36;
// Card #497 (owner merge decision — exactly one scheduled email/day, not
// three): daily-digest.yml (score-drift) and opening-digest.yml no longer
// email on their own either. Same snapshot-then-fold pattern as #364's
// health digest above.
const DAILY_DIGEST_PATH = path.join(REPO, 'data', 'audit', 'daily-digest-snapshot.json');
const OPENING_DIGEST_PATH = path.join(REPO, 'data', 'audit', 'opening-digest-snapshot.json');
const DAILY_DIGEST_MAX_AGE_H = 36;
const OPENING_DIGEST_MAX_AGE_H = 36;
// Card #511 (reddit-engagement-digest.js migration, same snapshot-fold class
// as #364): the twice-daily r/Broadway digest no longer emails on its own
// either — same fail-soft freshness pattern as HEALTH_DIGEST_PATH above.
const REDDIT_DIGEST_PATH = path.join(REPO, 'data', 'audit', 'reddit-digest-snapshot.json');
// reddit-engagement-digest.yml now runs once/day before the loop starts — a
// snapshot older than this means the cron itself is stuck, not just
// "yesterday's threads"; show nothing rather than pass off stale suggestions.
const REDDIT_DIGEST_MAX_AGE_H = 36;
// Raised 3 → 5 (S4-T2): approvals were arriving faster than 3/morning could
// drain, so items aged out of sight behind a "+N more" line for days. The
// counter below the items still names anything past the cap.
const MAX_EMAIL_ITEMS = 5;
// Screenshot attachments for UI items (S2-T6). Small caps on purpose: this is
// evidence for a decision, not a gallery, and Resend rejects oversized sends.
const MAX_ATTACHMENTS = 8;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
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

// Reads health-check.js's digest snapshot (card #364). Fail-soft — missing
// file (health-check.js hasn't run yet on this repo) or a stale one (the cron
// broke) both just omit the section rather than show wrong data as current.
function readHealthDigest() {
  try {
    const snap = JSON.parse(fs.readFileSync(HEALTH_DIGEST_PATH, 'utf8'));
    const ageH = (Date.now() - new Date(snap.generatedAt).getTime()) / 3600e3;
    if (!(ageH < HEALTH_DIGEST_MAX_AGE_H)) return null;
    return snap;
  } catch {
    return null;
  }
}

// Card #497: send-daily-digest.js's (score-drift) snapshot — same fail-soft
// shape/reasoning as readHealthDigest above.
function readDailyDigestSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(DAILY_DIGEST_PATH, 'utf8'));
    const ageH = (Date.now() - new Date(snap.generatedAt).getTime()) / 3600e3;
    if (!(ageH < DAILY_DIGEST_MAX_AGE_H)) return null;
    return snap;
  } catch {
    return null;
  }
}

// Card #497: send-opening-digest.js's snapshot — same fail-soft
// shape/reasoning as readHealthDigest above.
function readOpeningDigestSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(OPENING_DIGEST_PATH, 'utf8'));
    const ageH = (Date.now() - new Date(snap.generatedAt).getTime()) / 3600e3;
    if (!(ageH < OPENING_DIGEST_MAX_AGE_H)) return null;
    return snap;
  } catch {
    return null;
  }
}

// Card #511: reddit-engagement-digest.js's snapshot — same fail-soft
// shape/reasoning as readHealthDigest above.
function readRedditDigestSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(REDDIT_DIGEST_PATH, 'utf8'));
    const ageH = (Date.now() - new Date(snap.generatedAt).getTime()) / 3600e3;
    if (!(ageH < REDDIT_DIGEST_MAX_AGE_H)) return null;
    return snap;
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
  // --help must never fall through to a real send (cousin bug class
  // #260/#263/#264 — a `--help --send-to x` invocation used to send).
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('autonomous-email.js — morning approval email.\n\nUsage:\n  node scripts/autonomous-email.js --send-to <owner-address>   send (rule 17: one explicit recipient)\n  node scripts/autonomous-email.js --dry-run                   write HTML preview, no send\n  --executor-skipped <reason>   say so instead of a silent no-op (e.g. "monitor night")\n  --help, -h   show this message, do nothing else');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const sendTo = args['send-to'];
  // #476: autonomous-nightly.sh calls this script DIRECTLY (bypassing
  // autonomous-run.js) on a monitor night, so there is no run-skip ledger
  // entry to explain the gap — the caller has to say so itself, or the
  // morning email reads as a silent do-nothing night with 5 dropped attempts
  // and no explanation (the 2026-07-26 incident this card fixes).
  const executorSkippedReason = args['executor-skipped'] && args['executor-skipped'] !== true
    ? String(args['executor-skipped'])
    : (args['executor-skipped'] === true ? 'skipped' : null);
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
      // UI evidence (S2-T6): renderItem withholds the approve link entirely
      // when a look-at-it change arrived without screenshots.
      ui: evd.ui === true,
      screenshots: Array.isArray(evd.screenshots) ? evd.screenshots : [],
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

  // #476: the executor-skipped banner — a plain-language "here's why nothing
  // happened", not the technical 0-planned breakdown above (that one only
  // fires when triage itself planned 0 attempts; this one covers the case
  // where triage planned real work and the executor never got to run it).
  let executorSkipped = null;
  if (executorSkippedReason) {
    // ship-check (codex): counts.attempt is tier-3 code attempts ONLY —
    // autonomous-triage.js tracks tier-2 data-repo attempts separately as
    // counts.dataPlan, and autonomous-run.js's live() runs BOTH plan and
    // dataPlan when the executor isn't skipped. Reporting attempt alone
    // undercounts (or shows 0 while dataPlan work was actually deferred).
    const c = freshQueue && freshQueue.counts;
    const attempted = c && (Number.isFinite(c.attempt) || Number.isFinite(c.dataPlan))
      ? (Number(c.attempt) || 0) + (Number(c.dataPlan) || 0)
      : null;
    executorSkipped = attempted !== null
      ? `executor skipped (${executorSkippedReason}): ${attempted} planned attempt${attempted === 1 ? '' : 's'} deferred to tomorrow`
      : `executor skipped (${executorSkippedReason}): planned attempts deferred to tomorrow`;
  }

  // Needs-your-attention (2026-07-19 wedge postmortem): every state that
  // silently stalls the loop, with the owner action. Fail-soft per source —
  // a Notion hiccup must never block the email.
  //   config-warnings: tonight's run segment (inadmissibleSizes etc.)
  //   failed cards:    auto=failed — parked until the OWNER clears Auto
  //   parked items:    planned at a size the config doesn't enable (L, or a
  //                    size-floor bump past the enabled set) — skipped nightly
  //   attempt-memory:  triage skipped the card before the LLM call because it
  //                    failed N times unchanged (task #635/#637) — distinct
  //                    from parkedItems above (that's a size mismatch, this
  //                    is a repeat-failure park); was invisible until now.
  const attention = { configWarnings: [], failedCards: [], parkedItems: [], attemptMemoryParked: [] };
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
    for (const e of freshQueue.entries || []) {
      const reason = e && e.preFilter && e.preFilter.reason;
      if (reason && /^parked:/.test(reason)) {
        attention.attemptMemoryParked.push({ name: (e.card && e.card.name) || e.card?.id || 'unknown card', reason });
      }
    }
  }
  // Only configWarnings + failedCards name a decision the owner must actually
  // make tonight — parkedItems are a routine skip reason ("bigger than the
  // loop's enabled size tiers"), not new information, so they're excluded
  // from the subject's "needs your triage" escalation (card #475 fix: the
  // subject previously counted parked items too, producing "10 items
  // stalling the loop — needs your triage" on nights where every one of
  // those 10 was just a parked-by-config item, contradicted by the body's
  // own "Nothing needs you this morning" headline).
  const attentionCount = actionableAttentionCountOf(attention);

  // Acceptance recheck (S3-T4): last night's shadow results, straight off the
  // ledger. Fail-soft — a missing/short ledger just omits the section.
  let recheck = null;
  try {
    const since = Date.now() - 24 * 3600 * 1000;
    const recent = entries.filter(e => e.event === 'recheck' && new Date(e.ts).getTime() >= since);
    if (recent.length) {
      const results = recent.map(e => {
        // Structured fields first (written since the ship-check fix); the
        // note-prefix parse is the fallback for rows written before that.
        if (e.status || e.skip) return { name: e.name || '(untitled)', status: e.status || null, skip: e.skip || null };
        const note = String(e.note || '');
        const skipped = /^skipped/.test(note);
        return {
          name: e.name || '(untitled)',
          status: skipped ? null : note.split(':')[0].trim(),
          skip: skipped ? (note.replace(/^skipped:?\s*/, '') || 'being worked on') : null,
        };
      });
      recheck = { counts: summarizeRecheck(results), lines: results.map(describeResult) };
    }
  } catch (err) {
    console.error(`[email] WARN could not read recheck results: ${String(err.message).slice(0, 120)}`);
  }

  // Prune count (S4-T3): "Closed N finished tabs" — the owner watches the
  // workspace list shrink overnight and had no record of what closed it.
  let prunedCount = null;
  try {
    const since = Date.now() - 24 * 3600 * 1000;
    const sweeps = dispatchLedger.readEntries().filter(e => e.event === 'prune' && new Date(e.ts).getTime() >= since);
    if (sweeps.length) prunedCount = sweeps.reduce((n, e) => n + (Number(e.closed) || 0), 0);
  } catch (err) {
    console.error(`[email] WARN could not read prune sweeps: ${String(err.message).slice(0, 120)}`);
  }

  const admin = await fetchAdminUsage();
  // "What changed while you slept" — owner request 2026-07-22. Fails soft:
  // a broken source becomes a "couldn't check" line inside the block.
  let digest = null;
  try { digest = gatherDigest({ repo: REPO }); }
  catch (err) { console.error(`[email] WARN digest gathering failed: ${String(err.message).slice(0, 120)}`); }

  // Site health (card #364): folds health-check.js's former standalone
  // digest email into this one. null when no fresh snapshot exists.
  const health = readHealthDigest();
  // Fix-this button (card #634 — owner ask 2026-07-30): sign a dispatch link
  // per health-digest ERROR so a tap creates a session on it, no laptop
  // required. Same conditionKey convention health-check.js's own routeAlert()
  // call already uses (`health-check:${r.name}`) — a tap on an issue that
  // already auto-dispatched via that path lands on the SAME open card
  // instead of filing a duplicate (see handleDispatch's Notion dedup query).
  attachHealthFixUrls({ health, exp, secret, baseUrl });
  // Card #497: same fold-in for the two remaining routine scheduled digests
  // (score-drift + opening-night radar) — null when no fresh snapshot exists.
  const dailyDigest = readDailyDigestSnapshot();
  const openingDigest = readOpeningDigestSnapshot();
  // Card #511: reddit-engagement-digest.js's twice-daily "worth replying to"
  // digest folds in the same way. null when no fresh snapshot exists.
  const redditDigest = readRedditDigestSnapshot();

  // Screenshot attachments (S2-T6): the owner reads this on a phone as often
  // as at the Mac, where a local file path is useless — the pictures have to
  // travel WITH the email or the "look at it before approving" instruction
  // can't be followed. Capped so a runaway capture can never blow up a send.
  //
  // Done BEFORE rendering, and each item's list is REPLACED with what actually
  // attached: the caps are per-email, so with 5 items x 4 shots the later items
  // used to render "Screenshots attached to this email" (and an approve link)
  // with nothing attached (ship-check finding). An item whose evidence did not
  // make it into the message is treated exactly like one that was never
  // captured — no approve link.
  const attachments = [];
  let attachBytes = 0;
  for (const item of items) {
    const attached = [];
    for (const rel of (item.screenshots || [])) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      try {
        const buf = fs.readFileSync(path.join(REPO, rel));
        if (attachBytes + buf.length > MAX_ATTACH_BYTES) continue;
        attachBytes += buf.length;
        attachments.push({ filename: path.basename(rel), content: buf.toString('base64') });
        attached.push(rel);
      } catch (err) {
        console.error(`[email] WARN could not attach ${rel}: ${String(err.message).slice(0, 120)}`);
      }
    }
    if ((item.screenshots || []).length !== attached.length) {
      console.error(`[email] "${item.name}": ${attached.length}/${(item.screenshots || []).length} screenshots fit in the email` +
        (attached.length ? '' : ' — rendering it as needing a look, since its evidence did not travel'));
    }
    item.screenshots = attached;
  }

  const html = renderEmail({
    items,
    digest,
    health,
    dailyDigest,
    openingDigest,
    redditDigest,
    recheck,
    prunedCount,
    moreAwaiting: Math.max(0, awaiting.length - items.length),
    failedCount,
    runSkipped,
    executorSkipped,
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
  const baseSubject = runSkipped
    ? `Overnight: ⛔ run skipped — ${skipLabel}${items.length ? ` (+${items.length} still awaiting your tap)` : ''}`
    : executorSkipped
      ? `Overnight: ⏸ ${executorSkipped}${items.length ? ` (+${items.length} still awaiting your tap)` : ''}`
      : listingFailed
        ? `Overnight: ⚠️ could not read the approval queue`
        : items.length
          ? `Overnight: ${items.length} item${items.length > 1 ? 's' : ''} awaiting your tap — ${items.map(i => i.name).join(' · ').slice(0, 80)}`
          : attentionCount
            ? `Overnight: ⚠️ ${attentionCount} item${attentionCount > 1 ? 's' : ''} stalling the loop — needs your triage`
            : queueSummary
              ? `Overnight: no items to approve (${queueSummary.total} triaged, 0 workable)`
              : `Overnight: no items to approve (${failedCount} failed)`;

  // Card #364: fold health-check.js's escalation into this ONE subject line
  // instead of a second email. "BSC URGENT" (day 3/7/weekly milestone, see
  // health-check.js's isEscalationDay) gets a ⛔ suffix; any other unresolved
  // error/warning set gets a quieter ⚠️ one. Clean snapshots add nothing.
  const healthErrorCount = health ? (health.errors?.length || 0) : 0;
  const healthWarnCount = health ? (health.warns?.length || 0) : 0;
  const healthUrgent = health && /URGENT/.test(health.subject || '');
  const healthSuffix = healthErrorCount || healthWarnCount
    ? ` · ${healthUrgent ? '⛔' : '⚠️'} site health: ${healthErrorCount} error${healthErrorCount === 1 ? '' : 's'}, ${healthWarnCount} warning${healthWarnCount === 1 ? '' : 's'}`
    : '';
  const subject = `${baseSubject}${healthSuffix}`;

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
    ...(attachments.length ? { attachments } : {}),
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

module.exports = { fetchAdminUsage, latestEvidenceByCard, MAX_EMAIL_ITEMS, MAX_ATTACHMENTS, MAX_ATTACH_BYTES };
