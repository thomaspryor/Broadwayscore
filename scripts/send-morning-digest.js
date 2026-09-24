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

const { readAllSnapshots, describeProblems, readFreshnessReport, summarizeFreshnessHighSeverity, summarizeClosingSoon, readSyncRefused, SYNC_REFUSED_READ_FAILED } = require('./lib/digest-snapshots.js');
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
const { assessThroughputRow, throughputDeathMessage } = require('./lib/autofix-canary.js');
const { assessCyrusRelay } = require('./lib/cyrus-relay-health.js');
const { assessRunnerHealth } = require('./lib/cyrus-runner-health.js');
const { assessSupervisorStatus } = require('./lib/pr-supervisor-core.js');
const { fetchInflowCounts, assessInflowRatio } = require('./lib/backlog-inflow-ratio.js');
const { doneRatePerDay, fetchUnarmedUrgentHighCount, formatDrainThroughputLine, isHeartbeatFresh } = require('./lib/linear-drain-throughput.js');

// Task #1220/BRO-230 (ship-check adversarial finding): health.errors can
// NEVER carry the "Autofix: jobs actually succeeding" row in the normal case
// — health-check.js runs only in GitHub Actions (data-health-check.yml),
// where data/audit/digest-autofix-ledger.jsonl is a per-machine file that
// doesn't exist in the checkout, so that check always returns status:'warn'
// there, never 'error'. This sender runs LOCALLY (launchd, the same machine
// that writes the ledger) — read it directly here instead of trusting the
// CI-produced health.errors to ever carry the dead-loop signal.
const DIGEST_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'digest-autofix-ledger.jsonl');
const BACKLOG_LEDGER_PATH = path.join(REPO, 'data', 'audit', 'backlog-drain-ledger.jsonl');
function localLoopDeadMessage({ pendingIssues = 0 } = {}) {
  let rows;
  try {
    rows = readLedgerRows(DIGEST_LEDGER_PATH);
  } catch (err) {
    console.error(`[digest] WARN could not read local autofix ledger: ${String(err.message).slice(0, 120)}`);
    return null;
  }
  if (rows === null) return null; // ledger absent on this machine this run — unknown, not dead
  const r = assessAutofixEffectiveness(rows);
  if (r.status === 'error') return r.message;

  // BRO-3321. assessAutofixEffectiveness can only speak about dispatches that
  // HAPPENED — its window counts outcomes and launches. A loop that stopped
  // dispatching altogether produces neither, and reads as "not enough to
  // judge", i.e. silence. That is not hypothetical: this ledger has a
  // 2026-08-15..2026-09-13 hole with zero rows of any kind, a month in which
  // nothing alarmed at all. Quieting the false DEAD banner without covering
  // that hole would have traded a noisy wrong alarm for a quiet missing one.
  //
  // assessThroughputRow already detects it (ZERO_DISPATCH_ERROR_DAYS), but it
  // is only wired into health-check.js, which runs in GitHub Actions where
  // BOTH of these ledgers are per-machine and absent — so there it can only
  // ever say 'warn'. Same reasoning as the block above: this sender runs on
  // the machine that WRITES them, so it is the only place the row can be real.
  //
  // Scoped to the zero-DISPATCH arm deliberately. The zero-PASS arm is the
  // same question assessAutofixEffectiveness already answers above, and
  // surfacing both would double-fire one condition as two banners.
  // readLedgerRows, not a fourth reader: same null-means-absent contract
  // assessThroughputRow requires (null is "unreadable here", [] is "genuinely
  // empty" — it must never score a missing ledger as healthy).
  let backlogRows = null;
  try {
    backlogRows = readLedgerRows(BACKLOG_LEDGER_PATH);
  } catch (err) {
    console.error(`[digest] WARN could not read backlog-drain ledger: ${String(err.message).slice(0, 120)}`);
  }
  // The decision itself lives in autofix-canary.js as a pure function so it is
  // unit-testable — it gates a red banner in the owner's inbox, and this file
  // reads disk and sends mail, so nothing here can be tested directly.
  const t = assessThroughputRow({ digestLedgerEntries: rows, backlogLedgerEntries: backlogRows });
  return throughputDeathMessage(t, { pendingIssues });
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

// A delegated Linear agent that accepted work and is doing nothing is invisible
// on the board — it looks identical to one that is working. On 2026-08-16 ten
// issues sat that way and it surfaced only because the owner asked. Written by
// scripts/check-linear-delegations.js; this is the reader that closes the loop.
const LINEAR_DELEGATION_STATUS_PATH = path.join(
  process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus'),
  'linear-delegation-status.json'
);
function localLinearDelegationMessage() {
  let raw;
  try {
    raw = fs.readFileSync(LINEAR_DELEGATION_STATUS_PATH, 'utf8');
  } catch {
    return null; // never run on this machine — genuinely unknown, not an alarm
  }
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    // The file exists but cannot be read. That is a broken watchdog, and
    // staying quiet about it reproduces exactly the "looks like good news"
    // failure this alarm was built to end.
    return 'Linear agents: the delegation status file is unreadable, so nobody is watching whether delegated work is running.';
  }
  const ageH = (Date.now() - Date.parse(status.at)) / 3600000;
  if (!Number.isFinite(ageH)) {
    return 'Linear agents: the delegation status file has no usable timestamp, so its contents cannot be trusted.';
  }
  // 3h, not 26h. The checker runs every 30 min but this digest reads once a
  // day: at a 26h threshold a checker dying just after one morning's send is
  // still "fresh" at the next one, and its day-old alarm renders as current —
  // roughly 48h of real blindness.
  if (ageH > 3) {
    return `Linear agents: the delegation check has not run for ${Math.round(ageH)}h, so nobody is watching whether delegated work is actually running.`;
  }
  if (status.truncated) {
    return `${status.alarm ? `${status.alarm} ` : ''}Linear agents: the delegation check hit its page limit, so older sessions were not examined.`;
  }
  return status.alarm || null;
}

// Cyrus runner fleet health (BRO-380 Phase 2). Same reasoning as the relay
// above: the scheduler writes this status file on THIS machine, so CI health
// checks never see it. The two failure modes are runaway spend (a wedged
// runner blows the daily API cap) and silence (the scheduler dies and no
// runner fires) — both invisible until the bill or the stalled backlog shows
// up. This reader surfaces either in the daily digest. CYRUS_HOME override
// keeps the alerting path testable without touching the live status file.
const RUNNER_STATUS_PATH = path.join(
  process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus'),
  'runner-health.json'
);
// Loop 5: finished agent pull requests pile up unmerged because no actor decides,
// and until now nothing told the owner it was happening — four green PRs sat for a
// day and it surfaced only because someone went looking. scripts/pr-supervisor.js
// publishes its verdicts here on a schedule; this renders them. Same shape as the
// relay and delegation readers above: the file's absence is unknown, never an alarm.
const PR_SUPERVISOR_STATUS_PATH = path.join(
  process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus'),
  'pr-supervisor-status.json'
);
function localPrSupervisorMessage() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(PR_SUPERVISOR_STATUS_PATH, 'utf8'));
  } catch {
    return null; // never published on this machine — unknown, not an alarm
  }
  return assessSupervisorStatus(payload).message;
}

// BRO-2318: dispatch-watchdog.js writes its heartbeat (HEARTBEAT_PATH there)
// on THIS machine every sweep, including a `holds: string[]` field — the same
// strings that hold the crowned tab's dispatch budget. A leaky-launcher hold
// (~1-in-3 dispatches dying at cmux injection) can sit there indefinitely
// without ever escalating past the tab title if the owner isn't looking at
// cmux, so this surfaces it in the one channel read every day regardless.
// Same null-if-absent shape as the readers above: no watchdog on this
// machine, or a heartbeat not yet written, is unknown, not an alarm.
// 3h staleness bar matches localLinearDelegationMessage's above — a dead
// watchdog (crashed right after recording a leak) must not keep surfacing a
// stale "leaking" line forever with no way to tell it apart from a live one.
const WATCHDOG_HEARTBEAT_PATH = path.join(os.homedir(), '.claude', 'state', 'dispatch-watchdog.json');
const { LAUNCHER_LEAK_HOLD_PREFIX } = require('./lib/dispatch-watchdog-core.js');
function localDispatchWatchdogLeakMessage() {
  let hb;
  try {
    hb = JSON.parse(fs.readFileSync(WATCHDOG_HEARTBEAT_PATH, 'utf8'));
  } catch {
    return null; // no watchdog heartbeat on this machine yet — unknown, not dead
  }
  const ageH = (Date.now() - Date.parse(hb.ts)) / 3600000;
  if (!Number.isFinite(ageH) || ageH > 3) return null; // stale/unparseable heartbeat — unknown, not an alarm
  const holds = Array.isArray(hb.holds) ? hb.holds : [];
  return holds.find(h => String(h).startsWith(LAUNCHER_LEAK_HOLD_PREFIX)) || null;
}

function localRunnerHealthMessage() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(RUNNER_STATUS_PATH, 'utf8'));
  } catch {
    return null; // no runners on this machine, or file not written yet — unknown, not dead
  }
  return assessRunnerHealth(state).message;
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

// Task #1818: this job now runs even when sync-audit-checkout.sh refused
// (stale/dirty checkout, sections.syncRefused) — read-only reporting is safe
// on stale code, but runAutofix()/runAutofixCanary() are NOT: they file real
// Linear cards and can dispatch real headless fix sessions (dispatchDetached
// -> linear-next.js --headless, which answers only to LINEAR_NEXT_DISABLED —
// a switch this plist does NOT set; BSC_RUNNER_DISABLED only ever gated the
// legacy bsc-next.js routing path, per BRO-286). Force dryRun on both
// whenever the checkout is untrusted so a refusal can never cause
// card-filing/dispatch decisions to run off stale or half-written code —
// dryRun's row states (card-filed/dispatched) render identically to the real
// thing, so the email body is unaffected. Extracted (CLAUDE.md rule 15) so
// this safety property has a real regression test instead of living only as
// an inline `||`.
//
// BRO-3393: this used to be `!!dryRun || !!syncRefused`, and that single `||`
// cost the owner ~29 days of auto-fix. `readSyncRefused()` globs
// data/audit/sync-refused-*.json across EVERY launchd tag, while
// sync-audit-checkout.sh's clear_refused_snapshot() removes only its OWN
// tag's file. So one chronically-failing sibling job (linear-drain-parked,
// predispatch-queue-audit) left a snapshot on disk indefinitely and forced
// the digest into dry-run every morning - no cards filed, no dispatches -
// even on mornings the digest's own gate fast-forwarded cleanly. The ledger
// shows the damage: 6 auto-dispatch rows in 31 days, on 2 days.
//
// The property task #1818 actually wanted is "is THIS checkout trustworthy
// right now". Only the digest's OWN tag answers that, and it answers it
// well: the plist runs `SYNC_TAG=digest bash sync-audit-checkout.sh`
// seconds before this process starts, so sync-refused-digest.json is either
// freshly written or freshly deleted. A sibling's snapshot from 22:30 last
// night is strictly worse evidence about the tree this process is reading.
// Sibling refusals still render in the email (renderNamedDigestBlock below)
// - they are real alerts, they just must not disable auto-fix.
//
// ownTag is a CONSTANT, deliberately NOT process.env.SYNC_TAG (ship-check
// finding, BRO-3393). Reading it from the environment would make the answer
// to "is THIS checkout trustworthy" settable by anything that can set an env
// var - a manual invocation, a wrapper script, an inherited shell, the repo's
// own .env loader. `SYNC_TAG=shadow node scripts/send-morning-digest.js`
// would then ignore a real, live digest refusal and dispatch anyway. The
// no-drift property the plist gives us is preserved where it costs nothing:
// a test pins that the plist's exported SYNC_TAG equals this constant, so the
// two can never disagree without CI saying so.
const DIGEST_SYNC_TAG = 'digest';

// Fails CLOSED on ambiguity, which is the whole safety property:
//   * our tag among `unreadableTags` - a refusal snapshot named for US exists
//     but could not be parsed. It may say we refused. Dry-run.
//   * no `tags` array - a caller (or an older snapshot reader) that cannot say
//     whose refusal it is at all. Dry-run.
// It deliberately does NOT fail closed on a SIBLING's unreadable snapshot:
// only the owning job ever clears its own file, so one corrupt sibling file
// would otherwise suppress the digest's auto-fix forever - the exact bug this
// function is being changed to fix.
function autofixShouldDryRun({ dryRun = false, syncRefused = null, ownTag = DIGEST_SYNC_TAG } = {}) {
  if (dryRun) return true;
  if (!syncRefused) return false;
  const mine = (t) => String(t) === String(ownTag);
  if (Array.isArray(syncRefused.unreadableTags) && syncRefused.unreadableTags.some(mine)) return true;
  if (!Array.isArray(syncRefused.tags)) return true;
  return syncRefused.tags.some(mine);
}

// Subject contract: MUST match SCHEDULED_SENDERS['morning-digest'].pattern in
// scripts/lib/scheduled-email-count-rules.js — the one-email-per-day monitor
// classifies by this prefix, and the parity test in digest-snapshots.test.mjs
// enforces it. Never a count ("0 items" reads as broken, owner feedback
// 2026-07-27); the site-health escalation suffix is the only variable part.
function buildSubject({ health = null, autofixRows = null, awaitingOwner = null, now = new Date() } = {}) {
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
  // BRO-2425 (BRO-420 follow-up): a 48h+ stale awaiting-owner item is
  // otherwise invisible unless the owner opens the email and scrolls to that
  // block — the same "trains the eye to skip it" failure mode BRO-282/BRO-420
  // fix at the body level, one level up at the subject line. Additive to the
  // health suffix above (both can be true in the same digest) but PREPENDED,
  // not appended: mobile/notification previews truncate long subjects, and
  // this is the owner-actionable one — it must not be the part that gets cut
  // off behind a routine site-health count (ship-check review).
  const staleApprovals = Array.isArray(awaitingOwner?.items)
    ? awaitingOwner.items.filter((i) => i && i.stale).length
    : 0;
  if (staleApprovals) {
    suffix = ` · ⚠️ ${staleApprovals} approval${staleApprovals === 1 ? '' : 's'} waiting 48h+` + suffix;
  }
  return `Morning digest — ${dateLabel}${suffix}`;
}

// Sections render via the SAME exported block renderers the old email used —
// identical visual output for the parts the owner kept, none of the loop
// parts. `changes` is overnight-digest.js's pre-rendered HTML block (or null).
function buildHtml({ sections = {}, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, inflow = null, drainThroughputLine = null, now = new Date() } = {}) {
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
  const loopDeadMsg = localLoopDeadMessage({ pendingIssues: fixing }) || autofixLoopDeadMessage(sections.health);
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
  const delegationMsg = localLinearDelegationMessage();
  if (delegationMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(delegationMsg)}</p>`);
  }
  const cyrusMsg = localCyrusRelayMessage();
  if (cyrusMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(cyrusMsg)}</p>`);
  }
  const runnerMsg = localRunnerHealthMessage();
  if (runnerMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(runnerMsg)}</p>`);
  }
  const supervisorMsg = localPrSupervisorMessage();
  if (supervisorMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(supervisorMsg)}</p>`);
  }
  const watchdogLeakMsg = localDispatchWatchdogLeakMessage();
  if (watchdogLeakMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(watchdogLeakMsg)}</p>`);
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
  // Backlog inflow (BRO-3017). A STANDING line, same as the trunk row above
  // and for the same reason: this metric drifted to 3.3 issues filed per 1
  // closed with 1,074 open precisely because nothing ever reported the rate.
  // Rendered green when healthy rather than hidden — a row that only appears
  // when it is angry teaches the reader that silence means "fine", which is
  // indistinguishable from a dead collector. Colour by status; the verdict
  // itself is decided in lib/backlog-inflow-ratio.js, never here.
  if (inflow && inflow.message) {
    const colour = inflow.status === 'error' ? '#b91c1c' : inflow.status === 'watch' ? '#b45309' : inflow.status === 'unknown' ? '#666' : '#15803d';
    const prefix = inflow.status === 'error' || inflow.status === 'watch' ? '⚠️ ' : '';
    blocks.push(`<p style="font-size:12px;color:${colour};margin:0 0 12px;">${prefix}${esc(inflow.message)}</p>`);
  }
  // Linear drain throughput (BRO-3923 R6) — a STANDING line next to the
  // inflow row above, same reasoning: Done/day, watchdog-eligible queue
  // depth, and unarmed Urgent/High count are exactly the numbers that would
  // have caught "the drain hasn't moved in weeks" before it took a hand
  // audit (31 mis-filed trackers) to notice.
  if (drainThroughputLine) {
    blocks.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${esc(drainThroughputLine)}</p>`);
  }
  if (sections.needsYou) blocks.push(renderNamedDigestBlock('Needs your decision', sections.needsYou));
  // Waiting on your approval (BRO-282) — Linear issues carrying the
  // 'awaiting-owner' label (work finished, blocked on a plain-language yes,
  // e.g. the /visual-qa pre-push gate). Distinct from "Needs your decision"
  // above (session-scoped cmux state, dies with the tab): this is
  // issue-scoped and survives the originating session closing.
  if (sections.awaitingOwner) blocks.push(renderNamedDigestBlock('Waiting on your approval', sections.awaitingOwner));
  // Parked in review (BRO-282's residual half, BRO-3376) — Linear issues in
  // the `In Review` state, which is where linear-dispatch.js's seed prompt
  // tells every finished session to park. The two blocks above only fire when
  // a session opts in (a ❓ tab mark, an awaiting-owner label); this one needs
  // no opt-in, which is why it is the block that would have caught the actual
  // leak: 120 finished items, 100 of them 14+ days old, were sitting here
  // unread on 2026-09-15 — including BRO-282 itself, for 28 days.
  if (sections.inReviewBacklog) blocks.push(renderNamedDigestBlock('Review queue', sections.inReviewBacklog));
  if (sections.providerSpend) blocks.push(renderNamedDigestBlock('Scraping spend', sections.providerSpend));
  // Coverage Verdict (task #905) — same {generatedAt, bannerText, items,
  // moreCount} shape, no new render code.
  if (sections.coverageVerdict) blocks.push(renderNamedDigestBlock('Coverage verdict', sections.coverageVerdict));
  // P1 backlog relevance audit (task #1719) — same {generatedAt, bannerText,
  // items, moreCount} shape, no new render code. On-demand producer (not
  // cron-wired), so this only appears the mornings after someone runs
  // scripts/audit-card-relevance.js.
  if (sections.p1RelevanceAudit) blocks.push(renderNamedDigestBlock('P1 backlog relevance audit', sections.p1RelevanceAudit));
  // Predispatch queue backlog (task #1801) — same {generatedAt, bannerText,
  // items, moreCount} shape, no new render code. Cron'd Mac-locally before
  // this digest sends (com.broadwayscore.predispatch-queue-audit plist), so
  // unlike p1RelevanceAudit above this appears every morning, not only after
  // an on-demand run.
  if (sections.predispatchQueue) blocks.push(renderNamedDigestBlock('Predispatch queue backlog', sections.predispatchQueue));
  // Dispatch guard queue backlog (task #1802) — generalizes the block above
  // from predispatch-guard alone to all 8 sibling dispatch-guards.js
  // predicates. Same {generatedAt, bannerText, items, moreCount} shape, no
  // new render code. Same producer/plist as predispatchQueue, so it also
  // appears every morning.
  if (sections.dispatchGuardQueue) blocks.push(renderNamedDigestBlock('Dispatch guard queue backlog', sections.dispatchGuardQueue));
  // Done-evidence audit (BRO-3426) — scripts/audit-done-evidence.js re-proves
  // every Done(14d)/In Review/In Progress card's OWN claimed evidence against
  // a fresh origin/main and names what no longer holds. Same {generatedAt,
  // bannerText, items, moreCount} shape, no new render code. Placed after the
  // dispatch/queue blocks because it is about the board's own honesty rather
  // than about work waiting to start. SHADOW MODE: the producer never changes
  // a Linear state, so every row here is a report, not an action already taken.
  if (sections.doneEvidence) blocks.push(renderNamedDigestBlock('Done-evidence audit', sections.doneEvidence));
  // launchd blocked git syncs (task #1563) — same {generatedAt, bannerText,
  // items, moreCount} shape, no new render code. Only appears when a job's
  // sync actually got blocked (see readSyncRefused's header — not every
  // caller stops running when this happens, so "blocked" not "refused"
  // here) — silent on a normal morning, unlike the always-on blocks above.
  if (sections.syncRefused) blocks.push(renderNamedDigestBlock('Launchd sync blocked (stale checkout)', sections.syncRefused));
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
  sections, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, inflow = null, drainThroughputLine = null, now = new Date(),
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

  const subject = buildSubject({ health: sections.health, autofixRows, awaitingOwner: sections.awaitingOwner, now });
  const html = buildHtml({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, inflow, drainThroughputLine, now });
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

  // Task #1648: health-check.js's own "Digest: content-invariant check" row
  // (checkDigestInvariantFail(), scripts/lib/digest-invariant-fail-monitor.js)
  // can only see this ledger when IT runs on this same Mac. In the normal
  // case health-check.js runs in GitHub Actions (data-health-check.yml,
  // ubuntu-latest) — the gitignored, per-machine ledger doesn't exist there,
  // so that CI-produced row would always read 'warn' ("absent here"), never
  // 'error'. This is the exact cross-machine gap #1220/BRO-230 already
  // documented above for the autofix-loop-dead ledger (see
  // localLoopDeadMessage()) — this sender runs LOCALLY (launchd, the same
  // machine that just wrote the ledger a few lines up), so fold the local
  // read straight into sections.health.errors here, the one place every
  // downstream consumer (subject line, top verdict, autofix planning)
  // already reads from — instead of trusting the CI snapshot to ever carry it.
  try {
    const { assessDigestInvariantFailRow } = require('./lib/digest-invariant-fail-monitor.js');
    const ledgerPath = path.join(REPO, 'data', 'audit', 'digest-invariant-fail-ledger.jsonl');
    let entries = null;
    if (fs.existsSync(ledgerPath)) {
      entries = fs.readFileSync(ledgerPath, 'utf8').split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
    const row = assessDigestInvariantFailRow(entries);
    if (row.status === 'error') {
      if (!sections.health) sections.health = {};
      if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
      sections.health.errors.push({ name: row.name, message: row.message, hint: row.hint });
    }
  } catch (err) {
    console.error(`[digest] WARN could not read local digest-invariant-fail ledger: ${String(err.message).slice(0, 120)}`);
  }

  // BRO-467 follow-up: same cross-machine gap as the two folds above, for
  // health-check.js's "Autofix: daily canary" row. That CI row's own header
  // comment ("Tomorrow's health-check reads the ledger this writes" —
  // scripts/send-morning-digest.js:1132-1136 below) assumed data-health-
  // check.yml could see data/audit/autofix-canary-ledger.jsonl — it's
  // gitignored/Mac-local, so that assumption never held and the CI row could
  // only ever read 'warn' ("cannot measure here"), never the confirmed
  // 'error' a genuine end-to-end pipeline break produces. checkAutofixCanary
  // is now CI-skipped entirely (BRO-467) rather than emitting that
  // permanently-uninformative warn, so this local, live-data fold is what
  // keeps a REAL canary failure from going silent — same as task #1648 did
  // for the invariant-fail row just above.
  try {
    const { assessCanaryRow } = require('./lib/autofix-canary.js');
    const dispatchLedger = require('./lib/dispatch-ledger.js');
    const canaryLedgerPath = path.join(REPO, 'data', 'audit', 'autofix-canary-ledger.jsonl');
    let canaryLedgerEntries = null;
    if (fs.existsSync(canaryLedgerPath)) {
      canaryLedgerEntries = fs.readFileSync(canaryLedgerPath, 'utf8').split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
    let dispatchLedgerEntries = [];
    try { dispatchLedgerEntries = dispatchLedger.readEntries(); } catch { /* stage folding degrades to card-filed-only, same as checkAutofixCanary */ }
    const row = assessCanaryRow({ canaryLedgerEntries, dispatchLedgerEntries });
    if (row.status === 'error') {
      if (!sections.health) sections.health = {};
      if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
      sections.health.errors.push({ name: row.name, message: row.message, hint: row.hint });
    }
  } catch (err) {
    console.error(`[digest] WARN could not read local autofix-canary ledger: ${String(err.message).slice(0, 120)}`);
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

  // sync-audit-checkout.sh blocked-sync snapshots (task #1563) — a launchd
  // job whose git sync got blocked on stale/dirty code writes one of these;
  // presence is itself the alert (see readSyncRefused's header). Not pushed
  // to `problems` — that banner is for a producer that's supposed to run
  // and didn't; this is its own named block instead, same as backlogDrain.
  try {
    sections.syncRefused = readSyncRefused();
  } catch (err) {
    // Fail CLOSED (ship-check finding, BRO-3393). This catch used to leave
    // sections.syncRefused undefined, which autofixShouldDryRun reads as
    // "nobody refused" — so a thrown read, the single most ambiguous state
    // there is, was the one path that let real card filing and real headless
    // dispatch run without ANY freshness evidence. The sentinel's `tags: null`
    // is what makes the guard hold.
    console.error(`[digest] WARN sync-refused snapshot read failed — holding auto-fix in dry-run: ${String(err.message).slice(0, 120)}`);
    sections.syncRefused = SYNC_REFUSED_READ_FAILED;
  }

  const autofixDryRun = autofixShouldDryRun({ dryRun, syncRefused: sections.syncRefused });

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

  // Waiting on your approval (BRO-282) — Linear issues carrying the
  // 'awaiting-owner' label (see scripts/lib/owner-approval-channel.js for why
  // this is a distinct label from "In Review"). Live fetch, fail-soft: a
  // Linear outage must never block the digest. Raced against a 15s timeout
  // rather than relying on listOpenIssues()'s own retry budget (up to 5
  // attempts, each capable of a 60s backoff — fine for a human waiting on a
  // CLI list, but a degraded Linear API must not delay the whole 7:30am send
  // by minutes; ship-check finding, BRO-282). The race is local to this call
  // site, not a change to listOpenIssues()'s shared retry defaults, which
  // other callers (linear-next.js --list) still want in full.
  // Hoisted out of the try below so the "Parked in review" block can reuse
  // this exact fetch instead of making a second identical round trip —
  // buildOpenIssuesQuery() already returns state/priority/updatedAt/url, every
  // field in-review-backlog.js needs. Stays null if the fetch failed, and that
  // block then omits itself, same fail-soft contract as every other section.
  let openIssues = null;
  try {
    const linear = require('./lib/linear-client.js');
    const { buildAwaitingOwnerSection, isAwaitingOwner, enrichWithComments } = require('./lib/owner-approval-channel.js');
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
    const issues = await Promise.race([linear.listOpenIssues(), timeout(15_000)]);
    openIssues = issues;
    const awaiting = (issues || []).filter(isAwaitingOwner);
    // BRO-420: "waiting since" is derived from linear-attach-approval.js's
    // summary comment, not issue.updatedAt (see owner-approval-channel.js's
    // waitingSince() header for why), so re-fetch comments for just the
    // awaiting-owner subset via enrichWithComments (pure orchestration, unit
    // tested there — this call site is the only I/O: wiring linear.getIssue
    // in). Best-effort: enrichWithComments falls back to the un-enriched
    // issues on any per-issue error or a whole-batch timeout, so
    // buildAwaitingOwnerSection then just dates those rows off updatedAt
    // instead of losing the section.
    const enriched = await enrichWithComments(awaiting, {
      getIssue: (identifier) => linear.getIssue(identifier),
      onError: (issue, err) =>
        console.error(
          `[digest] WARN awaiting-owner comment enrichment failed${issue ? ` for ${issue.identifier}` : ''}, falling back to updatedAt: ${String(err.message).slice(0, 120)}`
        ),
    });
    // Re-check the label on the freshly re-fetched labels (enrichWithComments
    // refreshes them alongside comments): listOpenIssues() and the re-fetch
    // above are two separate round trips, so an owner who removed the
    // awaiting-owner label in that gap must not still show up as waiting
    // (ship-check finding, BRO-420).
    const section = buildAwaitingOwnerSection(enriched.filter(isAwaitingOwner));
    if (section) sections.awaitingOwner = section;
  } catch (err) {
    console.error(`[digest] WARN awaiting-owner section failed: ${String(err.message).slice(0, 120)}`);
  }

  // Parked in review (BRO-3376) — the passive half of BRO-282. See
  // scripts/lib/in-review-backlog.js's header for why this is a separate
  // block from the awaiting-owner one above rather than folded into it.
  // Pure shaping over the fetch already made above; fail-soft like every
  // other section, and it omits itself entirely when nothing has been
  // sitting past the idle threshold.
  try {
    if (openIssues && openIssues.length) {
      const { buildInReviewSection } = require('./lib/in-review-backlog.js');
      const section = buildInReviewSection(openIssues);
      if (section) sections.inReviewBacklog = section;
    }
  } catch (err) {
    console.error(`[digest] WARN in-review backlog section failed: ${String(err.message).slice(0, 120)}`);
  }

  // Board targeting (BRO-3423) — is the fleet's always-on automation actually
  // dispatching off the LIVE board, or off one we declared retired?
  //
  // WHY THIS IS FOLDED INTO sections.health.errors RATHER THAN GIVEN ITS OWN
  // DIGEST BLOCK. The failure it catches ran for two weeks unnoticed: the
  // crowned dispatch watchdog spent its entire day budget re-dispatching
  // retired-board Notion ids while 122 of 137 armed Linear issues had never
  // been touched. A quiet line in a block of its own would have reproduced
  // that exactly — `backlogDrain` is registered bannerOnly + optionalIfMissing
  // and its producer has been dead since 2026-08-31 without anyone noticing.
  // sections.health.errors is the one field the subject line and top verdict
  // both read, so a mis-targeted fleet is loud on the first morning.
  //
  // For the same reason there is no launchd plist and no snapshot file: a
  // separate Mac-local producer is one more thing that can die silently. The
  // digest reads the ledgers itself, here, at send time.
  //
  // Fail-soft like every other section — but note that "could not read the
  // ledger" comes back as status 'error' (blind), NOT as a pass. A check that
  // reports healthy because it cannot see its evidence is the exact failure
  // this card is about.
  try {
    const { readDispatchLedgers, fetchLiveBoardArmed } = require('./lib/board-targeting-sources.js');
    const { auditWriterBoards, auditLiveBoardCoverage, summarizeBoardTargeting } = require('./lib/board-targeting-audit.js');
    // `Date.now()` inline, NOT the `now` binding — that const is declared ~100
    // lines below this block (see the TDZ note in the inflow block above).
    const auditNow = Date.now();
    const { rows, everTouchedIds, blind, primaryLedger, primaryLastRowTs, problems } = readDispatchLedgers({});
    const writerAudit = auditWriterBoards({ rows, now: auditNow });
    const live = await fetchLiveBoardArmed({});
    const coverage = auditLiveBoardCoverage({
      eligibleIds: live.eligibleIds,
      everTouchedIds,
      ok: live.ok,
      reason: live.reason,
      // The eligible set comes from the dispatcher's OWN eligibility rules, so
      // a bug that collapsed it would shrink the denominator and silently
      // exonerate the fleet. openIssues is already fetched above; carrying the
      // raw count alongside makes that collapse a visible number.
      openIssueCount: openIssues ? openIssues.length : null,
    });
    const row = summarizeBoardTargeting({ writerAudit, coverage, now: auditNow, blind, primaryLedger, primaryLastRowTs });
    // An unreadable SECONDARY ledger shrinks everTouchedIds, which inflates the
    // coverage arm's never-touched count and can manufacture a false FAIL. Say
    // so in the row rather than letting it read as a clean measurement
    // (ship-check finding).
    if (problems.length && row.status === 'error') {
      row.message += ` (note: ${problems.join('; ')})`;
    }
    if (row.status === 'error') {
      if (!sections.health) sections.health = {};
      if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
      sections.health.errors.push({ name: row.name, message: row.message, hint: row.hint });
    }
    console.log(`[digest] board-targeting: ${row.status} — ${row.message}`);
  } catch (err) {
    console.error(`[digest] WARN board-targeting check failed: ${String(err.message).slice(0, 120)}`);
  }

  // Backlog inflow ratio (BRO-3017, owner decision 2026-09-08 "B then A").
  // Live fetch, fail-soft, raced against a 20s timeout — the same shape as the
  // awaiting-owner section above and for the same reason: a degraded Linear
  // API must not delay the 7:30am send. 20s rather than that block's 15s
  // because this walks four paginated counts, not one list; both are wrapped
  // locally rather than by changing listOpenIssues()'s shared retry defaults.
  let inflow = null;
  // Captured alongside `inflow` (BRO-3923 R6) so the drain-throughput block
  // just below can re-derive "Done/day" from the SAME completed/windowDays
  // pair rather than issuing a second live completedAt query for a number
  // this fetch already has.
  let inflowCounts = null;
  try {
    const { graphql } = require('./lib/linear-client.js');
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
    // `new Date()` inline, NOT the `now` binding — that const is declared ~140
    // lines below this block, so referencing it here is a TDZ ReferenceError
    // that the catch would swallow into one WARN line and a row that never
    // renders. Exactly the fail-soft-hides-breakage shape that let every
    // consumer of the Notion read-only flip report success while dead.
    const counts = await Promise.race([fetchInflowCounts({ graphql, now: new Date() }), timeout(20_000)]);
    inflow = assessInflowRatio(counts);
    inflowCounts = counts;
  } catch (err) {
    const why = String(err.message).slice(0, 120);
    console.error(`[digest] WARN backlog inflow ratio failed: ${why}`);
    // Say so IN THE EMAIL, do not leave the row out. A row that vanishes on
    // exactly the failure it exists to expose is the bug this whole metric was
    // built to end: silence then means "healthy" and "the collector is dead"
    // at the same time, and the owner cannot tell which. Same shape as
    // localLinearDelegationMessage's unreadable-file branch above.
    inflow = {
      status: 'unknown',
      ratio: null,
      message: `Backlog inflow: could not be measured this morning (${why}). This row is not "no news" — nobody is watching the create-to-close rate until it comes back.`,
    };
  }

  // Linear drain throughput (BRO-3923 R6): "Done/day" is re-derived from
  // inflowCounts above (no extra query — see linear-drain-throughput.js's
  // header for why job-done/Notion-mirror sources were rejected). The
  // watchdog's own eligible-queue count is read from its heartbeat file (the
  // live 👑 OWNER watchdog tab already computes it every ~90s), and the
  // unarmed Urgent/High count is the one NEW live query this block adds.
  // Fail-soft, same shape as inflow above — a degraded read must not block
  // the 7:30am send, and must not silently drop the line either.
  let drainThroughputLine = null;
  try {
    const { graphql } = require('./lib/linear-client.js');
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
    const unarmed = await Promise.race([fetchUnarmedUrgentHighCount({ graphql }), timeout(20_000)]);

    let eligible = null;
    let eligibleOk = false;
    try {
      const { HEARTBEAT_PATH } = require('./dispatch-watchdog.js');
      const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
      if (hb && hb.linearSource && hb.linearSource.ok && isHeartbeatFresh(hb.ts) && Number.isFinite(hb.linearSource.eligible)) {
        eligible = hb.linearSource.eligible;
        eligibleOk = true;
      }
    } catch { /* heartbeat missing/stale/unreadable — renders as n/a below, not a thrown error */ }

    drainThroughputLine = formatDrainThroughputLine({
      donePerDay: inflowCounts
        ? doneRatePerDay(inflowCounts.completed, inflowCounts.windowDays, {
            // A truncated `completed` count is a FLOOR (backlog-inflow-ratio.js's
            // fetchInflowCounts), not the real number — must render n/a, not an
            // understated rate presented as exact (ship-check/Codex finding).
            truncated: Array.isArray(inflowCounts.truncatedCounts) && inflowCounts.truncatedCounts.includes('completed'),
          })
        : null,
      windowDays: inflowCounts ? inflowCounts.windowDays : null,
      eligible,
      eligibleOk,
      unarmedCount: unarmed.ok ? unarmed.count : null,
    });
    console.log(`[digest] ${drainThroughputLine}`);
  } catch (err) {
    const why = String(err.message).slice(0, 120);
    console.error(`[digest] WARN linear drain throughput failed: ${why}`);
    drainThroughputLine = `Linear drain: could not be measured this morning (${why}).`;
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
    // BRO-3438 (owner-approved 2026-09-15, "A then B"): how many auto-fix
    // sessions this ONE dispatcher may have alive at once. It overrides
    // backlog-drain.js's shared DEFAULT_CONCURRENCY_CAP (2) for the digest path
    // only — raising that shared default would have moved every other drain's
    // ceiling too. The digest's real daily throughput is
    // min(DISPATCH_CAP, this - jobs still alive), so before this it was 2/day
    // (logged as "2 being worked" every morning) and it is now 3/day.
    //
    // Why 3 and not the 8 the card's title proposed: disk is NOT the binding
    // constraint (30 GiB free vs ~940 MB per job worktree), memory is. Measured
    // 2026-09-20 on the Mac Studio: swap 12.6 GB used of 14.3 GB (1.7 GB free),
    // load average 14. The other live dispatcher (linear-drain-parked, 2) shares
    // that machine, so 3 here means at most 5 concurrent headless sessions.
    // Raise it further only against a fresh `sysctl vm.swapusage` reading.
    const DIGEST_CONCURRENCY_CAP = 3;
    autofixRows = runAutofix({ plan: planAutofix({ health: sections.health, extraIssues, tasks, queued: queuedForAutofix }), dryRun: autofixDryRun, log: (m) => console.log(m), concurrencyCap: DIGEST_CONCURRENCY_CAP });
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
    runAutofixCanary({ dryRun: autofixDryRun, log: (m) => console.log(m) });
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
  const { subject, html } = composeDigestEmail({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, inflow, drainThroughputLine, now });

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

module.exports = { buildSubject, buildHtml, parseArgs, composeDigestEmail, autofixShouldDryRun, DIGEST_SYNC_TAG, localDispatchWatchdogLeakMessage };
