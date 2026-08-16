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
const os = require('os');
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

const { readAllSnapshots, describeProblems, readFreshnessReport, summarizeFreshnessHighSeverity, summarizeClosingSoon } = require('./lib/digest-snapshots.js');
const { renderTrunkDigestLine } = require('./lib/trunk-status.js');
const {
  esc,
  renderHealthDigestBlock,
  renderDailyDigestBlock,
  renderRedditDigestBlock,
  renderNamedDigestBlock,
  autofixLoopDeadMessage,
} = require('./lib/autonomous-email-render.js');
const { assessAutofixEffectiveness, readLedgerRows } = require('./lib/autofix-effectiveness.js');
const { assessCyrusRelay } = require('./lib/cyrus-relay-health.js');

// Task #1220/BRO-230 (ship-check adversarial finding): health.errors can
// NEVER carry the "Autofix: jobs actually succeeding" row in the normal case
// — health-check.js runs only in GitHub Actions (data-health-check.yml),
// where data/audit/digest-autofix-ledger.jsonl is a per-machine file that
// doesn't exist in the checkout, so that check always returns status:'warn'
// there, never 'error'. This sender runs LOCALLY (launchd, the same machine
// that writes the ledger) — read it directly here instead of trusting the
// CI-produced health.errors to ever carry the dead-loop signal.
const DIGEST_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'digest-autofix-ledger.jsonl');
function localLoopDeadMessage() {
  let rows;
  try {
    rows = readLedgerRows(DIGEST_LEDGER_PATH);
  } catch (err) {
    console.error(`[digest] WARN could not read local autofix ledger: ${String(err.message).slice(0, 120)}`);
    return null;
  }
  if (rows === null) return null; // ledger absent on this machine this run — unknown, not dead
  const r = assessAutofixEffectiveness(rows);
  return r.status === 'error' ? r.message : null;
}

// Cyrus relay health. Same reasoning as the ledger above: the status file is
// written by a launchd job on THIS machine, so CI health checks can never see
// it. The relay's only failure mode is silence — the drain dies, Linear
// @mentions vanish, and nothing says so until someone wonders why Cyrus went
// quiet. This is the one reader that closes that loop.
// CYRUS_HOME override matches scripts/cyrus-webhook-drain.js, and is what makes
// the alerting path testable without disturbing the live status file.
const CYRUS_STATUS_PATH = path.join(
  process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus'),
  'webhook-drain-status.json'
);
function localCyrusRelayMessage() {
  let status;
  try {
    status = JSON.parse(fs.readFileSync(CYRUS_STATUS_PATH, 'utf8'));
  } catch {
    return null; // no Cyrus on this machine, or file not written yet — unknown, not dead
  }
  return assessCyrusRelay(status).message;
}

// Fix-this buttons (card #634 — owner ask 2026-07-30: "tap a button in the
// digest, get a session dispatched on the issue, no laptop required").
// Signed dispatch links are NOT the approval-loop links this sender
// deliberately omits (see the header note): they carry no loop bookkeeping
// and ask the owner for no triage — they are the one tap that acts on an
// error row this email already prints as "Fix needed: …".
const DISPATCH_CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
// 44h, NOT the loop's 48h linkExpiryHours, and NOT the original 20h (Digest
// v2 Sprint 0c, owner-approved plan 2026-07-31: a day-old email must still
// work — the owner reads on their own schedule, not the sender's, and a
// same-day-only window meant Saturday's email was dead by Sunday morning).
// 44h covers a full missed day plus buffer while still expiring before the
// email TWO send cycles back would still be live (this email sends DAILY at
// 07:30 ET, so 44h < 2×24h keeps at most "yesterday's + today's" tappable,
// never three days of stale buttons stacking up). handleDispatch dedups only
// against still-OPEN cards, so a stale-but-cleared error would file a fresh
// card and burn a session on a non-issue — the expiry window is what bounds
// that blast radius. Deliberately independent of the approve/reject links'
// expiry, which is a different lifecycle.
const DISPATCH_LINK_EXPIRY_H = 44;

const USAGE = `send-morning-digest.js — the owner's single scheduled morning email.

Usage:
  node scripts/send-morning-digest.js --send-to <address>   send (rule 17: one explicit recipient)
  node scripts/send-morning-digest.js --send-to-owner       send to OWNER_EMAIL (from .env)
  node scripts/send-morning-digest.js --dry-run             write HTML preview, no send
  --force      bypass the send-once-per-ET-day guard (deliberate re-send only)
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
function buildSubject({ health = null, autofixRows = null, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(now);
  // The urgent/⛔ escalation flag is driven by health-check.js's own
  // consecutiveErrorDays streak logic ("BSC URGENT (day N): ..." in
  // health.subject) — unchanged by the split below, so the streak counter's
  // identity (what makes the subject scream vs stay calm) is preserved.
  const urgent = health && /URGENT/.test(health.subject || '');
  let suffix = '';
  if (Array.isArray(autofixRows) && autofixRows.length) {
    // Digest truthfulness (BRO-232 S4): a flat error/warning count conflates
    // "we've seen this every morning and it's tracked/dispatched" with
    // "brand-new this run" — the exact conflation the owner flagged. `wasNew`
    // (set by digest-autofix.js's planAutofix/runAutofix) is the real signal:
    // false = already covered by a card/dispatch (or explicitly acknowledged),
    // true = first sighting of this row's family. Decision rows are excluded
    // from both buckets — they're a genuine judgment call, not a fix status,
    // and already render in their own "Needs your decision" section.
    const known = autofixRows.filter(r => r && !r.wasNew && r.state !== 'decision').length;
    const regressing = autofixRows.filter(r => r && r.wasNew && r.state !== 'decision').length;
    if (known || regressing) {
      suffix = ` · ${urgent ? '⛔' : '⚠️'} site health: ${known} known/managed, ${regressing} new/regressing`;
    }
  } else {
    // Fallback (autofixRows unavailable — e.g. autofix failed before compose,
    // see main()'s WARN autofix failed branch): byte-identical to pre-BRO-232
    // behavior.
    const errs = health ? (health.errors?.length || 0) : 0;
    const warns = health ? (health.warns?.length || 0) : 0;
    if (errs || warns) {
      suffix = ` · ${urgent ? '⛔' : '⚠️'} site health: ${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`;
    }
  }
  return `Morning digest — ${dateLabel}${suffix}`;
}

// Sections render via the SAME exported block renderers the old email used —
// identical visual output for the parts the owner kept, none of the loop
// parts. `changes` is overnight-digest.js's pre-rendered HTML block (or null).
function buildHtml({ sections = {}, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
  }).format(now);
  const parts = [];
  parts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);
  parts.push(`<p style="font-size:15px;font-weight:700;margin:0 0 12px;">Morning digest · ${esc(dateLabel)}</p>`);

  // Trunk status (task #1003) — a standing line, always rendered when the
  // snapshot exists, so aggregate CI redness can never again sit unnoticed
  // for days (2026-08-04: red on ~96% of main runs, four separate causes).
  // Past 24h red it takes the HEADLINE slot, above the site-health verdict:
  // at that point it is the most important thing in the email.
  const trunkLine = (() => {
    try { return renderTrunkDigestLine(sections.trunk); }
    catch { return null; }
  })();
  if (trunkLine && trunkLine.headline) {
    parts.push(`<p style="font-size:14px;font-weight:700;color:#b91c1c;margin:0 0 10px;">${esc(trunkLine.text)}</p>`);
  }

  // The 2-second verdict (owner feedback 2026-07-30: "so hard to read and
  // understand … very unactionable"): NAME what needs attention instead of
  // just counting it, and say plainly that warnings are routine watch items.
  const errs = sections.health ? (sections.health.errors?.length || 0) : 0;
  const warns = sections.health ? (sections.health.warns?.length || 0) : 0;
  // Health snapshot items are {name, message} objects; tolerate bare strings.
  const errNames = (sections.health?.errors || []).filter(Boolean)
    .map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean);
  // Data freshness (task #689): revenue-impacting gaps (missing tickets,
  // missing poster) on OPEN shows must escalate the top verdict, not just
  // sit in the demoted-to-context box below — the whole point of this fix
  // is that these signals stop being easy to miss (second-opinion review).
  const freshnessCount = sections.freshness?.count || 0;
  // Closing soon (task #690): only shows closing within summarizeClosingSoon's
  // urgentDays (14) escalate the top verdict — same "count is the escalation
  // signal, items/moreCount hold everything else" contract as freshnessCount.
  const closingSoonCount = sections.closingSoon?.count || 0;
  // Digest v3 summary: everything auto-fixable is BEING fixed — say that,
  // never point at sections that no longer exist (Closing soon / Data
  // freshness / stuck lists were deleted by the 2026-08-02 owner mandate).
  const fixing = Array.isArray(autofixRows) ? autofixRows.length : (errs + warns + (freshnessCount ? 1 : 0) + (stuckCount ? 1 : 0)); // closingSoon intentionally absent — lives in the opening digest
  const working = Array.isArray(autofixRows) ? autofixRows.filter(r => r.state === 'dispatched' || r.state === 'in-progress').length : 0;
  // Task #1220/BRO-230: this line used to claim "being fixed"/"queued for
  // automated fix sessions" no matter what — including the 13 straight
  // mornings (2026-08-10) where the loop was provably dead (logged-out CLI,
  // every job zero-byte-timing-out). health-check.js's "Autofix: jobs
  // actually succeeding" row already measures that outcome-blind spot; when
  // it's tripped, say so here instead of repeating the "being fixed" promise.
  // Local ledger read is authoritative (this machine IS the dispatch host);
  // fall back to scanning health.errors only for the hypothetical case that
  // check ever runs somewhere the ledger is actually visible.
  const loopDeadMsg = localLoopDeadMessage() || autofixLoopDeadMessage(sections.health);
  if (errs) {
    parts.push(`<p style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 6px;">${esc(`${errs} site error${errs === 1 ? '' : 's'}: ${errNames.slice(0, 3).join('; ')}${errNames.length > 3 ? ` (+${errNames.length - 3} more)` : ''}`)}</p>`);
  } else {
    parts.push(`<p style="font-size:13px;font-weight:700;color:#15803d;margin:0 0 6px;">Nothing needs your attention this morning.</p>`);
  }
  if (loopDeadMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(fixing)} issue${fixing === 1 ? '' : 's'} detected, but the auto-fix loop looks DEAD — don't count on these getting fixed automatically. ${esc(loopDeadMsg)}</p>`);
  } else if (fixing) {
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${fixing} issue${fixing === 1 ? '' : 's'} detected — ${working ? `${working} being fixed by automated sessions right now, the rest queued` : 'all queued for automated fix sessions'}. Details below.</p>`);
  }
  const cyrusMsg = localCyrusRelayMessage();
  if (cyrusMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(cyrusMsg)}</p>`);
  }
  if (problemsNote) {
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(problemsNote)}</p>`);
  }

  // Section order (fresh-eyes review): "is the site okay?" first, then what
  // changed, then scores/Reddit. The opening-night radar left this email
  // 2026-07-30 — it's a standalone daily send again (send-opening-digest.js).
  const blocks = [];
  if (sections.health) blocks.push(renderHealthDigestBlock(sections.health, autofixRows, loopDeadMsg));
  // Data freshness (task #689) — high-severity data gaps (missing poster,
  // missing tickets on open shows) that used to be computed daily and thrown
  // away. Same {generatedAt, bannerText, items, moreCount} shape as
  // backlogDrain/providerSpend below, so it reuses renderNamedDigestBlock.
  // Closing soon (task #690) — report.closingSoon is a sibling field of the
  // same freshness-report.json, same {generatedAt, bannerText, items,
  // moreCount} shape, so it reuses renderNamedDigestBlock with no new
  // render code.
  // Backlog drain metric (task #654) — scripts/backlog-drain.js writes
  // {generatedAt, bannerText, items, moreCount}, the same shape every other
  // named digest uses, so it reuses renderNamedDigestBlock with no new
  // render code.
  // Scraping spend vs budget (check-provider-spend.js, Scraping Cost System
  // v2) — same {generatedAt, bannerText, items} shape, no new render code.
  // "Needs You" tab triage (card #870) — the owner's own pending decisions,
  // not a health/pipeline issue. Placed first among the named blocks since
  // it's the most personally actionable: only the owner can resolve these.
  // Trunk status block (task #1003). When it isn't the headline it still
  // renders here as a one-line row — the point of the fix is that the state
  // is ALWAYS visible, green or red, not only when someone goes looking.
  if (trunkLine) {
    blocks.push(trunkLine.level === 'critical'
      ? renderNamedDigestBlock('Trunk (main CI)', trunkLine)
      : `<p style="font-size:12px;color:#15803d;margin:0 0 12px;">${esc(trunkLine.text)}</p>`);
  }
  if (sections.needsYou) blocks.push(renderNamedDigestBlock('Needs your decision', sections.needsYou));
  if (sections.providerSpend) blocks.push(renderNamedDigestBlock('Scraping spend', sections.providerSpend));
  // Coverage Verdict (task #905) — same {generatedAt, bannerText, items,
  // moreCount} shape, no new render code.
  if (sections.coverageVerdict) blocks.push(renderNamedDigestBlock('Coverage verdict', sections.coverageVerdict));
  // Digest v3 (owner mandate 2026-08-02): the old "What changed" block —
  // commit messages, slugs, counters — is gone. One plain sentence remains.
  if (overnightLine) blocks.push(`<div style="font-size:12px;color:#666;margin:0 0 14px;">${overnightLine}</div>`);

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
// wire. (v2's attachHealthFixUrls call lived here; Digest v3 removed all
// root cause — a test that reconstructs this logic instead of calling it
// would not have caught that, which is exactly what happened (renderer unit
// buttons per the 2026-08-02 owner mandate — autofix runs in main().)
function composeDigestEmail({
  sections, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, now = new Date(),
  dispatchSecret = process.env.APPROVAL_HMAC_SECRET, dispatchConfigPath = DISPATCH_CONFIG_PATH,
} = {}) {
  // Digest v3 (owner mandate 2026-08-02, his FIFTH escalation): no Fix-this
  // buttons, ever — "Why do I need to hit 'Fix this'. I'm obvi going to hit it
  // for everything here. Just have a Claude session fix them." Auto-dispatch
  // happens in main() via lib/digest-autofix.js BEFORE compose; this function
  // only renders the resulting statuses.
  // Owner mandate 2026-08-02: every Needs-your-attention card carries a
  // one-click signed dispatch link (never prose-only). Same fail-soft rule
  // as everything else: no secret -> no button, email still sends.
  if (dispatchSecret && sections.health && Array.isArray(sections.health.queued)) {
    try {
      const { buildDispatchUrl } = require('./lib/dispatch-link.js');
      const cfg = (() => { try { return JSON.parse(fs.readFileSync(dispatchConfigPath, 'utf8')); } catch { return {}; } })();
      const baseUrl = cfg.baseUrl || 'https://broadwayscorecard.com';
      const exp = Math.floor(now.getTime() / 1000) + DISPATCH_LINK_EXPIRY_H * 3600;
      for (const q of sections.health.queued) {
        if (!q || !q.title || q.actionUrl) continue;
        q.actionUrl = buildDispatchUrl({
          conditionKey: `digest-needs-you:${q.title}`,
          title: `Fix: ${String(q.title).slice(0, 130)}`,
          description: q.description || '',
          exp, secret: dispatchSecret, baseUrl,
        });
      }
    } catch (err) {
      console.error(`[digest] WARN needs-you action links failed (cards render link-less): ${String(err.message).slice(0, 120)}`);
    }
  }

  const subject = buildSubject({ health: sections.health, autofixRows, now });
  const html = buildHtml({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, now });
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

  // Task #1641: strip forbidden-telemetry queue rows (e.g. "T1 Coverage
  // Scoreboard", "Deployed coverage" — deleted by the 2026-08-02 owner
  // mandate) HERE, before anything downstream reads sections.health.queued.
  // Filtering only inside renderHealthDigestBlock's display path left the
  // raw list open to planAutofix below, which folded these rows into the
  // "Automation queue" block through a path the display-only filter never
  // touched — this single choke point is what a third path can no longer
  // route around.
  if (sections.health && Array.isArray(sections.health.queued)) {
    const { filterForbiddenQueued } = require('./lib/autonomous-email-render.js');
    sections.health.queued = filterForbiddenQueued(sections.health.queued);
  }

  // Data freshness (task #689) — separate file/dir from the SNAPSHOTS fold
  // above, read directly. Fail-soft: a broken read degrades to one missing
  // section, never blocks the send (same rule as every other section here).
  try {
    const r = readFreshnessReport();
    if (r.status === 'fresh') {
      // A valid-JSON, fresh-timestamped report whose dataQuality.hasIssues
      // is missing or the wrong shape (e.g. the producer renames the field)
      // must not read as a quiet "nothing to report" day — that's exactly
      // the "stale silently vanishes" failure this file's SNAPSHOTS design
      // already guards against for every other source (ship-check finding).
      if (Array.isArray(r.snapshot?.dataQuality?.hasIssues)) {
        sections.freshness = summarizeFreshnessHighSeverity(r.snapshot);
      } else {
        problems.push({ key: 'freshness', label: 'data freshness', status: 'invalid', generatedAt: r.generatedAt });
      }
      // Closing soon (task #690) — closingSoon is an independent sibling
      // field of the same report, checked separately so a malformed
      // dataQuality shape doesn't also suppress this section (and vice
      // versa). Deliberately does NOT push a second 'freshness'-labeled
      // problem for stale/missing reports — the outer else below already
      // covers that single root cause once.
      if (Array.isArray(r.snapshot?.closingSoon)) {
        sections.closingSoon = summarizeClosingSoon(r.snapshot);
      } else {
        problems.push({ key: 'closingSoon', label: 'closing soon', status: 'invalid', generatedAt: r.generatedAt });
      }
    } else {
      problems.push({ key: 'freshness', label: 'data freshness', status: r.status, generatedAt: r.generatedAt });
    }
  } catch (err) {
    console.error(`[digest] WARN freshness-report read failed: ${String(err.message).slice(0, 120)}`);
  }

  // "Needs You" tab triage (card #870) — cmux tabs with a pending owner
  // decision (❓-prefixed by ~/.claude/hooks/lib/workspace-mark-done.js).
  // Computed live, not read from a snapshot file — no producer cron exists
  // or is needed; fail-soft like every other section here.
  try {
    const { buildNeedsYouSnapshot } = require('./lib/needs-you-snapshot.js');
    const snap = buildNeedsYouSnapshot();
    if (snap && snap.items.length) sections.needsYou = snap;
  } catch (err) {
    console.error(`[digest] WARN needs-you snapshot failed: ${String(err.message).slice(0, 120)}`);
  }

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

  // Digest v3 auto-fix (owner mandate 2026-08-02): every named health issue
  // plus the freshness/stuck rollups gets its card filed and the oldest few
  // dispatched as headless fix sessions — the email then REPORTS, never asks.
  // Fail-soft: any error here degrades to un-annotated rows, never blocks the send.
  let autofixRows = null;
  try {
    const { planAutofix, runAutofix } = require('./lib/digest-autofix.js');
    const extraIssues = [];
    if (sections.freshness?.count > 0) {
      extraIssues.push({ name: 'Data freshness: shows missing poster/synopsis/tickets',
        message: `${sections.freshness.count} open show(s) missing critical data — auto-fill from the standard image/synopsis/ticket pipelines.` });
    }
    if (stuckCount > 0) {
      extraIssues.push({ name: 'Stuck pipeline items',
        message: `${stuckCount} pipeline signal(s) flagged possibly-stuck by the overnight digest — investigate and unstick.` });
    }
    let tasks = [];
    // loadTasks REQUIRES the shared task directory — a bare call silently
    // returns [] (readdirSync(undefined) swallowed), which disabled dedup on
    // the first live run (Codex finding, 2026-08-02).
    try { const bn = require('./bsc-next.js'); tasks = bn.loadTasks(bn.TASKS_DIR); } catch { /* plan degrades to needs-card */ }
    // Task #843 (owner escalation 2026-08-02): "Needs your attention" rows
    // (owner-alert-router's disposition:'digest' queue) go through the SAME
    // plan/dispatch pipeline as health.errors/warns now — a bare button was
    // the whole bug this card exists to fix. Only rows the caller explicitly
    // marked `decision: true` come back with state:'decision' and stay in
    // sections.health.queued below (button-only); every other queued row is
    // filtered OUT of that array so renderHealthDigestBlock's "Needs your
    // attention" card only ever shows genuine judgment calls.
    const queuedForAutofix = Array.isArray(sections.health?.queued) ? sections.health.queued : [];
    autofixRows = runAutofix({ plan: planAutofix({ health: sections.health, extraIssues, tasks, queued: queuedForAutofix }), dryRun, log: (m) => console.log(m) });
    // Liveness gate (task #940, owner screenshots 2026-08-03): the digest
    // once claimed "a fix session is working on it now" for 4 issues whose
    // sessions had died hours earlier — 'in-progress' state comes purely
    // from the task list's status field, which stays stuck if nobody flips
    // it back. Cross-reference every 'in-progress' row against a LIVE cmux
    // listing + the shared dispatch ledger before the email renders it; a
    // row with no live proof downgrades to 'no-live-session' (honest label,
    // see autonomous-email-render.js). Reuses cmux-workspaces.js's shared
    // listWorkspaces()/claudeAliveIn (not a second raw `cmux list-workspaces`
    // parser) — existence in the listing alone is not proof of a live
    // session (ship-check adversarial finding, 2026-08-03: a workspace can
    // outlive the claude process that opened it), so digest-liveness.js also
    // requires claudeAliveIn's tag/process check to agree. Fail-soft: a
    // broken cmux/ledger read just means every row degrades to
    // "unconfirmed" this run, never blocks the send.
    try {
      const { applyLivenessGate } = require('./lib/digest-liveness.js');
      const dispatchLedger = require('./lib/dispatch-ledger.js');
      const { cmuxAvailable, listWorkspaces, claudeAliveIn } = require('./lib/cmux-workspaces.js');
      let liveWorkspaces = [];
      try {
        if (cmuxAvailable()) liveWorkspaces = listWorkspaces();
      } catch { /* cmux unreachable this run — every in-progress row reads as unconfirmed */ }
      const isProcessAlive = (ref) => { try { return claudeAliveIn(ref); } catch { return true; } };
      autofixRows = applyLivenessGate(autofixRows, { dispatchLedgerEntries: dispatchLedger.readEntries(), liveWorkspaces, isProcessAlive });
    } catch (err) {
      console.error(`[digest] WARN liveness gate failed (in-progress claims unverified this run): ${String(err.message).slice(0, 120)}`);
    }
    if (sections.health && Array.isArray(sections.health.queued)) {
      const decisionConditionKeys = new Set(
        autofixRows.filter(r => r.state === 'decision' && r.conditionKey).map(r => r.conditionKey));
      sections.health.queued = sections.health.queued.filter(q => q && decisionConditionKeys.has(q.conditionKey));
    }
    const d = autofixRows.filter(r => r.state === 'dispatched' || r.state === 'in-progress').length;
    const decisions = autofixRows.filter(r => r.state === 'decision').length;
    console.log(`[digest] autofix: ${autofixRows.length} issue(s) — ${d} being worked, ${autofixRows.length - d - decisions} queued, ${decisions} decision(s) left for the owner`);
  } catch (err) {
    console.error(`[digest] WARN autofix failed (email still sends): ${String(err.message).slice(0, 160)}`);
  }

  // Digest-autofix S6 (task #1225, owner mandate 2026-08-10): daily
  // end-to-end canary — resolves yesterday's synthetic dispatch-pipeline
  // probe and files/dispatches today's, through the REAL pipeline (card
  // filing -> notion-tasks-sync -> bsc-next --headless -> verify gate ->
  // completion). Tomorrow's health-check reads the ledger this writes.
  // Fail-soft: never blocks the digest send.
  try {
    const { runAutofixCanary } = require('./lib/autofix-canary.js');
    runAutofixCanary({ dryRun, log: (m) => console.log(m) });
  } catch (err) {
    console.error(`[digest] WARN autofix canary failed (email still sends): ${String(err.message).slice(0, 160)}`);
  }

  // One plain sentence of overnight activity (replaces the old commit-list block).
  let overnightLine = null;
  try {
    const c = require('./lib/overnight-digest.js').gatherDigest({ repo: REPO })?.counts;
    if (c) {
      const bits = [];
      if (c.newShows) bits.push(`${c.newShows} new show${c.newShows > 1 ? 's' : ''} added`);
      if (c.scoringRuns) bits.push(`${c.scoringRuns} review-scoring run${c.scoringRuns > 1 ? 's' : ''} completed`);
      if (bits.length) overnightLine = `Overnight: ${bits.join(', ')}.`;
    }
  } catch { /* optional */ }

  const now = new Date();
  const { subject, html } = composeDigestEmail({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, now });

  // Card #670/#1641: pre-send content check. Never blocks the SEND itself
  // (the digest must always send — a broken invariant check must not turn
  // into a broken inbox), but a violation is a real regression the CI test
  // on composeDigestEmail() missed, so it must not be able to hide behind a
  // WARN nobody reads — set the process exit code so callers (cron, CI, a
  // manual --dry-run) see it fail even though the email still went out.
  //
  // Card #1648: the exit code alone had no consumer — the launchd job has no
  // failure semantics and nothing else reads this process's exit code — so a
  // future FAIL was exactly as invisible as the WARN it replaced. Append a
  // JSONL record on every FAIL; scripts/health-check.js's
  // checkDigestInvariantFail() (scripts/lib/digest-invariant-fail-monitor.js)
  // reads it and turns a FAIL into a health.errors row tomorrow's digest
  // carries forward, closing the loop without making the SEND itself fail.
  let invariantViolations = [];
  try {
    const { assertDigestInvariants } = require('./lib/digest-content-invariants.js');
    const { ok, violations } = assertDigestInvariants(html, { health: sections.health, subject, verifySecret: process.env.APPROVAL_HMAC_SECRET });
    if (!ok) {
      invariantViolations = violations;
      console.error(`[digest] FAIL content invariant violation(s): ${violations.join('; ')}`);
      try {
        const ledgerPath = path.join(REPO, 'data', 'audit', 'digest-invariant-fail-ledger.jsonl');
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), violations, subject, dryRun: !!dryRun }) + '\n');
      } catch (ledgerErr) {
        console.error(`[digest] WARN could not persist invariant-fail ledger record: ${String(ledgerErr.message).slice(0, 120)}`);
      }
    }
  } catch (err) {
    console.error(`[digest] WARN content invariant check failed to run: ${String(err.message).slice(0, 120)}`);
  }

  if (dryRun) {
    const out = path.join(REPO, 'data', 'audit', 'morning-digest-preview.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`[digest] DRY RUN — preview written to ${out} (subject: ${subject})`);
    if (invariantViolations.length) process.exitCode = 1;
    return;
  }

  // Send-once-per-ET-day guard. 2026-08-02: a worktree session live-testing the
  // Digest v3 autofix lane re-sent the owner's already-delivered morning digest
  // at 3pm — the launchd 07:30 send and the test send were both "legitimate"
  // callers, so the only durable fix is idempotency in the sender itself.
  // State lives OUTSIDE every git checkout (~/.broadwayscore-state) for the
  // same reason as the alert ledger (card #693): a tracked file is clobbered by
  // concurrent git ops in the shared working tree. Keyed per recipient so a
  // test send to a throwaway address never blocks (or is blocked by) the real
  // owner send. --force is the deliberate-re-send escape hatch.
  const { dayKeyET } = require('./lib/scheduled-email-count-rules');
  const SENT_STATE = path.join(os.homedir(), '.broadwayscore-state', 'morning-digest-last-sent.json');
  // dayKeyET expects a Resend-style string (its toDate does string surgery);
  // a bare Date object mangles to Invalid Date. Pass ISO.
  const todayET = dayKeyET(new Date().toISOString());
  // State is a per-recipient MAP — a single-record file would let a test
  // send to a throwaway address overwrite the owner's stamp, re-opening the
  // exact duplicate-send hole this guard exists to close (ship-check P1).
  let sentState = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SENT_STATE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      sentState = parsed.recipients && typeof parsed.recipients === 'object'
        ? parsed.recipients
        // Legacy single-record shape {dayET,to,id,at} — fold into the map.
        : (parsed.to ? { [parsed.to]: parsed } : {});
    }
  } catch { /* no state yet */ }
  if (!args.force) {
    const prev = sentState[sendTo];
    if (prev && prev.dayET === todayET) {
      console.error(`[digest] already sent to ${sendTo} today (ET ${todayET}, Resend id ${prev.id || '?'}) — refusing duplicate send. Use --dry-run to preview, or --force for a deliberate re-send.`);
      process.exit(1);
    }
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
  try {
    sentState[sendTo] = { dayET: todayET, id: res.json?.id || null, at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(SENT_STATE), { recursive: true });
    fs.writeFileSync(SENT_STATE, JSON.stringify({ recipients: sentState }, null, 2) + '\n');
  } catch (e) {
    console.error(`[digest] warn: could not persist sent-state (${e.message}) — the once-per-day guard will not hold until this is fixed`);
  }
  if (invariantViolations.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(`[digest] fatal: ${err.message}`); process.exit(1); });
}

module.exports = { buildSubject, buildHtml, parseArgs, composeDigestEmail };
