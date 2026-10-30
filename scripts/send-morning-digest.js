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
 * Off the Mac (BRO-6230, .github/workflows/morning-digest-action.yml) add
 * --no-autofix --skip-mac-local --resend-sent-guard; see USAGE below.
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
const { MAIN_REPO_ROOT } = require('./lib/repo-root');
const { withTimeout } = require('./lib/with-timeout');

const REPO = path.join(__dirname, '..');

// .env preamble (same pattern as the other launchd-run senders — launchd
// does not inherit shell env, so keys must come from the repo's .env).
for (const envPath of [path.join(REPO, '.env'), path.join(MAIN_REPO_ROOT, '.env')]) {
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

const { readAllSnapshots, describeProblems, readFreshnessReport, summarizeFreshnessHighSeverity, readSyncRefused, SYNC_REFUSED_READ_FAILED } = require('./lib/digest-snapshots.js');
const { renderTrunkDigestLine } = require('./lib/trunk-status.js');
const {
  esc,
  renderHealthDigestBlock,
  renderDailyDigestBlock,
  renderRedditDigestBlock,
  renderNamedDigestBlock,
  autofixLoopDeadMessage,
  renderNeedsAttentionBlock,
  buildOwnerView,
  visitorProblemNames,
  renderOwnerTopBlock,
  renderTechnicalDetailsHeading,
} = require('./lib/autonomous-email-render.js');
const { localLoopDeadMessage } = require('./lib/digest-loop-health.js');
const { renderNewShowTypesBlock } = require('./lib/new-show-types.js');
const { renderPressNightBlock } = require('./lib/press-night-digest.js');
const { fetchPipelineIssues } = require('./lib/autofix-canary.js');
const { assessCyrusRelay } = require('./lib/cyrus-relay-health.js');
const { assessRunnerHealth } = require('./lib/cyrus-runner-health.js');
const { assessSupervisorStatus } = require('./lib/pr-supervisor-core.js');
const { fetchInflowCounts, assessInflowRatio } = require('./lib/backlog-inflow-ratio.js');
const { doneRatePerDay, fetchUnarmedUrgentHighCount, formatDrainThroughputLine, isHeartbeatFresh } = require('./lib/linear-drain-throughput.js');
const { readBoardGateFailopen } = require('./lib/summarize-board-gate-failopen.js');
const { collectCmuxTriage, renderCmuxTriageLine } = require('./lib/cmux-triage-digest.js');
const { codexLineFromStatus } = require('./lib/codex-status-line.js');
const { collectMoneySignups, renderMoneySignups } = require('./lib/money-signups-digest.js');

// Task #1220/BRO-230: data/audit/digest-autofix-ledger.jsonl is git-tracked,
// but CI's snapshot of it can lag the dispatch host by days, so health-check.js
// skips its "Autofix: jobs actually succeeding" row in CI (BRO-6468: the stale
// snapshot produced false "stalled" banners). This sender runs locally
// (launchd, the same machine that writes the ledger); read it directly here
// so the digest judges current host activity.
// Reconciliation and the --skip-mac-local guard live in lib/digest-loop-health.js.

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
// BRO-6110: the owner retired Cyrus. A retired Mac job stops writing its status file, which the
// two readers below would report as "has not checked in" every morning, so they stay silent for
// a label listed in config/mac-retired.json (the entry names these readers as its watchers).
function macLabelRetired(label, file = path.join(REPO, 'config', 'mac-retired.json')) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
    return Array.isArray(entries) && entries.some((e) => e && e.label === label);
  } catch {
    return false; // unreadable list: keep alerting rather than hide a real outage
  }
}

// BRO-6216: sync-refusal snapshot tags (SYNC_TAG = the label's last segment) of retired jobs.
// Only the owning job clears its snapshot, so a retired job's last one would show every morning.
function retiredSyncTags(file = path.join(REPO, 'config', 'mac-retired.json')) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
    return Array.isArray(entries) ? entries.filter((e) => e && typeof e.label === 'string').map((e) => e.label.split('.').pop()) : [];
  } catch {
    return [];
  }
}

function localCyrusRelayMessage() {
  if (macLabelRetired('com.broadwayscore.cyrus-webhook-drain')) return null;
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
function localCodexConnectionLine() {
  if (macLabelRetired('com.broadwayscore.linear-delegation-check')) return null;
  try {
    return codexLineFromStatus(JSON.parse(fs.readFileSync(LINEAR_DELEGATION_STATUS_PATH, 'utf8')));
  } catch {
    return null; // missing or unreadable: localLinearDelegationMessage already reports that
  }
}
function localLinearDelegationMessage() {
  if (macLabelRetired('com.broadwayscore.linear-delegation-check')) return null;
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
  if (macLabelRetired('com.broadwayscore.cyrus-runner')) return null;
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

// BRO-6230: what --skip-mac-local leaves out, plus the Mac heartbeat. Pure.
const MAC_LOCAL_SECTIONS = 'dispatch watchdog, dispatch and canary ledgers, board targeting, auto-fix sessions, cmux tabs, shared-checkout depth';
function macLocalSkippedLine(alive) {
  const mac = alive.state === 'alive' ? `Mac: ${alive.reason}.`
    : alive.state === 'dead' ? `Mac: ${alive.reason}. It is probably off or logged out, or its code sync is stuck.`
      : `Mac: could not tell (${alive.reason}).`;
  return { text: `Sent from GitHub, not the Mac. Not in this email (Mac-only): ${MAC_LOCAL_SECTIONS}. ${mac}`, alarm: alive.state !== 'alive' };
}

// BRO-6230: Resend-backed sent-today check. 'send' | 'already-sent' | 'cannot-tell'.
// Fails closed: anything short of a complete read is 'cannot-tell', never 'send'.
async function resendSentToday({ apiKey, recipient, now = new Date(), fetchEmails = null }) {
  if (!apiKey || !recipient) return { verdict: 'cannot-tell', reason: 'RESEND_API_KEY and a recipient are both required' };
  const { dayKeyET } = require('./lib/scheduled-email-count-rules');
  const { decideMorningDigest } = require('./lib/morning-digest-liveness.js');
  const dateET = dayKeyET(now.toISOString());
  const sinceMs = new Date(`${dateET}T00:00:00Z`).getTime() - 24 * 3600 * 1000;
  let emails = null;
  let apiError = null;
  try {
    const fetcher = fetchEmails || require('./lib/resend-owner-emails.js').fetchOwnerEmailsSince;
    emails = await fetcher({ apiKey, ownerEmail: recipient, sinceMs, strict: true });
  } catch (err) {
    apiError = String(err.message).slice(0, 160);
  }
  const d = decideMorningDigest({ emails, ownerEmail: recipient, dateET, apiError });
  if (d.action === 'ok') return { verdict: 'already-sent', reason: d.reason };
  if (d.action === 'page') return { verdict: 'send', reason: `no digest to the recipient yet on ${dateET} (ET)` };
  return { verdict: 'cannot-tell', reason: d.reason };
}

const USAGE = `send-morning-digest.js — the owner's single scheduled morning email.

Usage:
  node scripts/send-morning-digest.js --send-to <address>   send (rule 17: one explicit recipient)
  node scripts/send-morning-digest.js --send-to-owner       send to OWNER_EMAIL (from .env)
  node scripts/send-morning-digest.js --dry-run             write HTML preview, no send
  --force      bypass the send-once-per-ET-day guard (deliberate re-send only)
  --no-autofix          skip auto-fix planning, dispatch and the canary (no dispatch fleet here)
  --skip-mac-local      skip the readers of Mac-only state (cmux, dispatch ledgers, the shared
                        checkout) and print one line naming them plus the Mac's heartbeat age
                        (needs GH_TOKEN)
  --resend-sent-guard   also refuse a send when Resend already shows today's digest to the
                        recipient (needs a full-access RESEND_API_KEY; unreadable = refuse).
                        With --dry-run it reports what the guard would do.
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

// BRO-3444: one "Needs your decision" section from the Mac's cmux tabs and
// Linear's DECISION NEEDED cards. Either may be null.
function mergeNeedsYouSections(cmux, linear) {
  if (!cmux) return linear;
  if (!linear) return cmux;
  return {
    generatedAt: linear.generatedAt,
    bannerText: `${cmux.bannerText}; ${linear.bannerText}`,
    items: [...(cmux.items || []), ...(linear.items || [])],
    moreCount: (Number(cmux.moreCount) || 0) + (Number(linear.moreCount) || 0),
    // Keep every decision card url (shown or not) so buildOwnerView can drop the
    // same card from the Review queue instead of counting it twice.
    cardUrls: [...(cmux.cardUrls || []), ...(linear.cardUrls || [])],
  };
}

// Subject contract: MUST match SCHEDULED_SENDERS['morning-digest'].pattern in
// scripts/lib/scheduled-email-count-rules.js — the one-email-per-day monitor
// classifies by this prefix, and the parity test in digest-snapshots.test.mjs
// enforces it. Never a count of "items" ("0 items" reads as broken, owner
// feedback 2026-07-27).
//
// 2026-09-24 rework (owner: "confusing and un-actionable and annoying"): the
// subject answers the owner's two questions in plain English, and nothing
// else. "Site OK" / "⚠️ visitors affected: <name>" comes ONLY from
// visitor-facing health rows (lib/digest-audience.js; unknown checks count as
// visitor-facing), then "N decisions for you" / "nothing needs you". The old
// "⛔ site health: 69 known/managed, 14 new/regressing" suffix counted the
// automation's own machinery (CI, dispatch, cmux ...) the owner can neither
// see nor act on; those counts now live in the email's Technical details.
// BRO-6235: one signed link to the private list page of every open decision
// (answer buttons live there). Omitted without a signing secret.
function decisionsListLinkHtml(needsYou, secret = process.env.APPROVAL_HMAC_SECRET) {
  // A dry run writes a tracked preview file, so it must never embed a live token.
  if (process.env.DIGEST_NO_LIST_TOKEN || !secret || !needsYou || !Array.isArray(needsYou.items) || !needsYou.items.length) return '';
  try {
    const { listUrl } = require('./lib/owner-decision-email.js');
    const href = listUrl(secret).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<p style="margin:8px 0 14px;"><a href="${href}" style="font-weight:700;">See and answer every decision in one place</a></p>`;
  } catch { return ''; }
}

const SUBJECT_NAME_MAX = 42;
const SUBJECT_LIMIT = 120; // digest-content-invariants.js: subject must be < 120 chars
function buildSubject({ health = null, autofixRows = null, awaitingOwner = null, needsYou = null, inReviewBacklog = null, loopDead = false, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(now);
  // loopDead must match buildHtml's (composeDigestEmail computes it once):
  // it decides which visitor rows count as handled (BRO-5430).
  const view = buildOwnerView({ health, autofixRows, needsYou, awaitingOwner, inReviewBacklog, loopDead });
  let site;
  if (view.siteState === 'affected') {
    const names = visitorProblemNames(view);
    const first = names[0] || 'site problem';
    const clipped = first.length > SUBJECT_NAME_MAX ? `${first.slice(0, SUBJECT_NAME_MAX - 1).trimEnd()}…` : first;
    site = `⚠️ visitors affected: ${clipped}${names.length > 1 ? ` (+${names.length - 1} more)` : ''}`;
  } else if (view.siteState === 'minor') {
    // Visitor warnings are never an all-clear (some hide content from
    // visitors), but they are not an outage either.
    const n = view.visitorItems.length;
    site = `site mostly OK · ${n} minor visitor issue${n === 1 ? '' : 's'}`;
  } else if (view.siteState === 'handled') {
    // BRO-5430: visitor rows exist but the automation owns every one.
    site = `site: ${view.visitorHandled} issue${view.visitorHandled === 1 ? '' : 's'}, all with automation`;
  } else if (view.siteState === 'ok') {
    site = 'Site OK';
  } else {
    site = 'site check missing';
  }
  const ask = view.decisions ? `${view.decisions} decision${view.decisions === 1 ? '' : 's'} for you` : 'nothing needs you';
  // BRO-2425 (BRO-420 follow-up): a 48h+ stale awaiting-owner item is
  // PREPENDED, not appended — mobile/notification previews truncate long
  // subjects, and this is the owner-actionable part that must not be cut off.
  const stale = view.staleApprovals
    ? ` · ⚠️ ${view.staleApprovals} approval${view.staleApprovals === 1 ? '' : 's'} waiting 48h+`
    : '';
  // BRO-4141: digest-content-invariants requires < SUBJECT_LIMIT chars; a
  // stale-approval prefix + long visitor-problem name + big decision count
  // reached 128 and the invariant failed daily. Try progressively terser
  // wordings of the least actionable parts; never drop the date or the ask.
  const compose = (st, si) => `Morning digest — ${dateLabel}${st} · ${si} · ${ask}`;
  let subject = compose(stale, site);
  if (subject.length >= SUBJECT_LIMIT && view.siteState === 'affected') {
    const names = visitorProblemNames(view);
    const first = names[0] || 'site problem';
    const more = names.length > 1 ? ` (+${names.length - 1} more)` : '';
    const shown = Math.min(first.length, SUBJECT_NAME_MAX); // what the first pass rendered
    const room = shown - (subject.length - (SUBJECT_LIMIT - 1));
    if (room >= 8) subject = compose(stale, `⚠️ visitors affected: ${first.slice(0, room - 1).trimEnd()}…${more}`);
  }
  const terseSite = view.siteState === 'affected'
    ? `⚠️ visitors affected (${Math.max(1, visitorProblemNames(view).length)})`
    : view.siteState === 'minor' ? 'site mostly OK' : site;
  const terseStale = view.staleApprovals ? ` · ⚠️ ${view.staleApprovals} waiting 48h+` : '';
  for (const [st, si] of [[stale, terseSite], [terseStale, terseSite]]) {
    if (subject.length < SUBJECT_LIMIT) break;
    subject = compose(st, si);
  }
  return subject;
}

// Issues the automation is tracking this morning (the technical "N issues
// detected" count). BRO-3697: both rollups are core health rows now, so the
// snapshot's warns usually already carry them; count each only when it is
// not there (stale snapshot, or the Mac-only stuck signals CI cannot see).
function pendingIssueCount({ sections = {}, autofixRows = null, stuckCount = 0 } = {}) {
  if (Array.isArray(autofixRows)) return autofixRows.filter((r) => r && r.state !== 'info').length;
  const errs = sections.health ? (sections.health.errors?.length || 0) : 0;
  const warns = sections.health ? (sections.health.warns?.length || 0) : 0;
  const freshnessCount = sections.freshness?.count || 0;
  const rollupExtra = require('./lib/digest-autofix.js')
    .localRollupIssues({ health: sections.health, freshnessCount, stuckCount }).length;
  return errs + warns + rollupExtra;
}

// The dead-loop verdict, computed once per email so the subject and the top
// block agree on which visitor rows are handled (BRO-5430).
function digestLoopDeadMessage({ sections = {}, autofixRows = null, stuckCount = 0, pipelineIssues = null, skipMacLocal = false, now = new Date() } = {}) {
  const pendingIssues = pendingIssueCount({ sections, autofixRows, stuckCount });
  return localLoopDeadMessage({ pendingIssues, pipelineIssues, skipMacLocal, now }) || autofixLoopDeadMessage(sections.health) || null;
}

// Sections render via the SAME exported block renderers the old email used —
// identical visual output for the parts the owner kept, none of the loop
// parts. `changes` is overnight-digest.js's pre-rendered HTML block (or null).
function buildHtml({ sections = {}, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, inflow = null, drainThroughputLine = null, pipelineIssues = null, boardNumbersData = null, boardReport = undefined, boardReportPrev = null, loopDeadMsg: givenLoopDeadMsg, reportOnly = false, skipMacLocal = false, now = new Date() } = {}) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
  }).format(now);
  // 2026-09-24 rework: the email is two layers. `head` is the owner-first
  // top (site status for visitors, decisions, what the automation did, one
  // "Behind the scenes" line; see renderOwnerTopBlock). `parts` below is the
  // full technical report, unchanged in content, rendered under a "Technical
  // details" heading so nothing is lost for debugging. Internal-machinery
  // alarms (trunk red, dead loop, PR supervisor, Cyrus, runners, watchdog)
  // all live in `parts` now: the owner can neither see nor act on them.
  const head = [];
  let boardNumbersTableHtml = '';
  head.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);
  head.push(`<p style="font-size:15px;font-weight:700;margin:0 0 12px;">Morning digest · ${esc(dateLabel)}</p>`);
  const parts = [];

  // Trunk status (task #1003) — a standing line, always rendered when the
  // snapshot exists, so aggregate CI redness can never again sit unnoticed
  // for days (2026-08-04: red on ~96% of main runs, four separate causes).
  // Past 24h red it takes the headline slot of the TECHNICAL report (the
  // 2026-09-24 rework moved it out of the owner-first top: CI red does not
  // by itself affect visitors; "Deploy: production freshness" does, and that
  // row is classified visitor-facing).
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
  // Health snapshot items are {name, message} objects; tolerate bare strings.
  const errNames = (sections.health?.errors || []).filter(Boolean)
    .map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean);
  // Issues the automation is tracking (never claimed as being fixed: the
  // dead-loop check below and each row's own state decide that).
  const fixing = pendingIssueCount({ sections, autofixRows, stuckCount });
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
  const loopDeadMsg = givenLoopDeadMsg !== undefined ? givenLoopDeadMsg
    : digestLoopDeadMessage({ sections, autofixRows, stuckCount, pipelineIssues, skipMacLocal, now });
  // Owner-first top block (2026-09-24 rework). Decisions render here, at the
  // top, with their one-click action links intact (owner mandate
  // 2026-08-02); everything else follows under "Technical details".
  const view = buildOwnerView({
    health: sections.health, autofixRows, needsYou: sections.needsYou, awaitingOwner: sections.awaitingOwner,
    inReviewBacklog: sections.inReviewBacklog, loopDead: !!loopDeadMsg,
  });
  // Without autofix rows the fallback count also folds freshness/stuck in,
  // exactly like the technical "issues detected" line below.
  if (!Array.isArray(autofixRows)) view.tracked = fixing;
  const decisionBlocksHtml = [
    renderNeedsAttentionBlock(view.decisionQueued),
    // "Needs You" tab triage (card #870) — the owner's own pending decisions.
    sections.needsYou ? renderNamedDigestBlock('Decisions waiting on you', sections.needsYou, { actionCards: true }) : '',
    decisionsListLinkHtml(sections.needsYou),
    // Waiting on your approval (BRO-282) — Linear issues carrying the
    // 'awaiting-owner' label (work finished, blocked on a plain-language yes,
    // e.g. the /visual-qa pre-push gate). Distinct from "Needs your decision"
    // above (session-scoped cmux state, dies with the tab): this is
    // issue-scoped and survives the originating session closing.
    sections.awaitingOwner ? renderNamedDigestBlock('Waiting on your approval', sections.awaitingOwner, { actionCards: true, showBanner: true }) : '',
    // Parked in review (BRO-3376) — finished work waiting on the owner with
    // no opt-in marker; de-duplicated against awaitingOwner in buildOwnerView.
    view.reviewQueue ? renderNamedDigestBlock('Review queue', view.reviewQueue, { actionCards: true, showBanner: true }) : '',
  ].filter(Boolean).join('\n');
  head.push(renderOwnerTopBlock(view, { decisionBlocksHtml, overnightLine }));
  // Last night's openings (BRO-6645): one grade per press night, reviews live
  // and opening-night emails ready. Nights with no openings render nothing.
  try {
    head.push(renderPressNightBlock(sections.pressNight, { esc, nowMs: now.getTime() }));
  } catch (err) {
    console.error(`[digest] WARN press-night block failed: ${String(err.message).slice(0, 120)}`);
  }
  // New tour / pre-Broadway / UK regional shows with suggested Reddit posts
  // (BRO-6542). Quiet days render nothing; a stale snapshot is flagged by the
  // freshness banner like every other digest snapshot.
  try {
    head.push(renderNewShowTypesBlock(sections.newShowTypes, { esc, now }));
  } catch (err) {
    console.error(`[digest] WARN new-show-types block failed: ${String(err.message).slice(0, 120)}`);
  }
  // Board numbers (BRO-5482). `waiting` and `stuck` are the SAME numbers the sections
  // above/below use (view.decisions, stuckCount): never a second definition.
  if (boardNumbersData) {
    try {
      const bn = require('./lib/board-numbers.js');
      const m = bn.buildBoardNumbers({ data: boardNumbersData, waiting: sections.boardWaitingUnknown ? null : view.decisions, stuck: sections.boardStuckUnknown ? null : stuckCount, technicalInReview: sections.inReviewTechnicalCount });
      // BRO-6081: the owner reads a verdict, a 7-day chart and four tiles; the
      // full numbers table moves under Technical details.
      boardNumbersTableHtml = bn.renderBoardNumbersHtml(m, esc);
      head.push(require('./lib/board-summary.js').renderBoardSummaryHtml(m, m.daily, esc, { partial: m.daily ? m.dailyTruncated : m.floors }));
    } catch (err) {
      console.error(`[digest] WARN board numbers block failed: ${String(err.message).slice(0, 120)}`);
    }
  }
  // BRO-6442: every open card in one category, the same table board-report.js
  // prints. undefined = not fetched (kill switch, tests): no block. null = the
  // fetch failed: a visible "unavailable" line, never a silent gap.
  if (boardReport !== undefined) {
    try {
      head.push(require('./lib/board-summary.js').renderBoardCategoriesHtml(boardReport, boardReportPrev, esc));
    } catch (err) {
      console.error(`[digest] WARN board category table failed: ${String(err.message).slice(0, 120)}`);
    }
  }

  head.push(renderMoneySignups(sections.moneySignups));

  // Technical report starts here. The raw error names stay (debugging), but
  // are no longer called "site errors": most are the automation's own
  // machinery, and the visitor-facing ones are already named in plain
  // English at the top.
  if (errs) {
    parts.push(`<p style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 6px;">${esc(`${errs} health-check error${errs === 1 ? '' : 's'}: ${errNames.slice(0, 3).join('; ')}${errNames.length > 3 ? ` (+${errNames.length - 3} more)` : ''}`)}</p>`);
  }
  if (loopDeadMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(fixing)} issue${fixing === 1 ? '' : 's'} detected, but the auto-fix loop looks DEAD — don't count on these getting fixed automatically. ${esc(loopDeadMsg)}</p>`);
  } else if (fixing && reportOnly) {
    // BRO-6230: --no-autofix builds a report-only plan; nothing was queued, so say so.
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${fixing} issue${fixing === 1 ? '' : 's'} detected. This digest only reports them; it did not start any automatic fix. Details below.</p>`);
  } else if (fixing) {
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${fixing} issue${fixing === 1 ? '' : 's'} detected — ${working ? `${working} being fixed by automated sessions right now, the rest queued` : 'all queued for automated fix sessions'}. Details below.</p>`);
  }
  if (sections.inReviewTechnicalCount) {
    const n = sections.inReviewTechnicalCount;
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${n} finished technical card${n === 1 ? '' : 's'} idle in review 3d+. Not for you: the daily closer closes each one it can verify; the rest wait for a worker.</p>`);
  }
  const delegationMsg = localLinearDelegationMessage();
  if (delegationMsg) {
    parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(delegationMsg)}</p>`);
  }
  const codexLine = localCodexConnectionLine();
  if (codexLine) {
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${esc(codexLine)}</p>`);
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
  const boardGate = readBoardGateFailopen({ now });
  if (boardGate) {
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 12px;">${esc(boardGate.line)}</p>`);
    if (boardGate.alert) {
      parts.push(`<p style="font-size:12px;color:#b91c1c;margin:0 0 12px;">⚠️ ${esc(boardGate.alert)}</p>`);
    }
  }
  // BRO-6230: --skip-mac-local names what this email leaves out, so nothing vanishes silently.
  if (sections.macLocalSkipped) {
    const ms = sections.macLocalSkipped;
    parts.push(`<p style="font-size:12px;color:${ms.alarm ? '#b91c1c' : '#666'};margin:0 0 12px;">${ms.alarm ? '⚠️ ' : ''}${esc(ms.text)}</p>`);
  }
  // Dead cmux tab triage (BRO-3050): rendered only when main() collected it.
  // The line itself (incl. "no verdict" for degraded/unavailable runs) is
  // decided in lib/cmux-triage-digest.js, never here.
  if (sections.cmuxTriage) {
    const ct = renderCmuxTriageLine(sections.cmuxTriage);
    const colour = ct.level === 'watch' ? '#b45309' : ct.level === 'ok' ? '#15803d' : '#666';
    parts.push(`<p style="font-size:12px;color:${colour};margin:0 0 12px;">${esc(ct.text)}</p>`);
  }
  if (problemsNote) {
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(problemsNote)}</p>`);
  }

  // Section order (fresh-eyes review): "is the site okay?" first, then what
  // changed, then scores/Reddit. The opening-night radar left this email
  // 2026-07-30 — it's a standalone daily send again (send-opening-digest.js).
  const blocks = [];
  // omitQueued: owner decisions already rendered at the top. Any non-decision
  // queued rows (only when autofix failed before compose) stay here.
  if (sections.health) {
    blocks.push(renderHealthDigestBlock(sections.health, autofixRows, loopDeadMsg, { omitQueued: true })
      + renderNeedsAttentionBlock(view.otherQueued));
  }
  // Data freshness (task #689) — high-severity data gaps (missing poster,
  // missing tickets on open shows) that used to be computed daily and thrown
  // away. Same {generatedAt, bannerText, items, moreCount} shape as
  // backlogDrain/providerSpend below, so it reuses renderNamedDigestBlock.
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
  // "Needs your decision", "Waiting on your approval" and "Review queue"
  // moved to the owner-first top block (2026-09-24 rework) — see
  // decisionBlocksHtml above. The Review queue (BRO-282's residual half,
  // BRO-3376) is Linear issues in the `In Review` state, which is where
  // linear-dispatch.js's seed prompt tells every finished session to park.
  // It needs no opt-in, which is why it is the block that would have caught
  // the actual leak: 120 finished items, 100 of them 14+ days old, were
  // sitting unread on 2026-09-15 — including BRO-282 itself, for 28 days.
  // It must therefore count toward the subject's "N decisions for you".
  if (sections.providerSpend) blocks.push(renderNamedDigestBlock('Scraping spend', sections.providerSpend));
  // Spend guard audit (BRO-3011) — same {bannerText, items} shape.
  if (sections.guardAudit) blocks.push(renderNamedDigestBlock('Spend guards (last 7 days)', sections.guardAudit));
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
  // commit messages, slugs, counters — is gone. One plain sentence remains,
  // and since the 2026-09-24 rework it sits in the owner-first top block
  // ("what the automation did"), not down here.

  if (blocks.length) {
    parts.push(blocks.join('\n'));
  } else if (!overnightLine) {
    head.push(`<p style="font-size:13px;color:#666;margin:0 0 12px;">All quiet — no overnight changes to report.</p>`);
  }
  if (boardNumbersTableHtml) parts.push(boardNumbersTableHtml);
  if (parts.length) {
    head.push(renderTechnicalDetailsHeading());
    head.push(...parts);
  }

  head.push(`<p style="color:#999;font-size:11px;margin-top:16px;text-align:center;">Broadway Scorecard morning digest</p>`);
  head.push(`</div>`);
  return head.join('\n');
}

// Composes the subject+html the SAME way the real send does: attach Fix-this
// links, then build subject/html — pulled out of main() (CLAUDE.md §15) so
// digest-content-invariants.test.mjs exercises this real caller-to-renderer
// wire. (v2's attachHealthFixUrls call lived here; Digest v3 removed all
// root cause — a test that reconstructs this logic instead of calling it
// would not have caught that, which is exactly what happened (renderer unit
// buttons per the 2026-08-02 owner mandate — autofix runs in main().)
function composeDigestEmail({
  sections, problemsNote = null, changesHtml = null, stuckCount = 0, autofixRows = null, overnightLine = null, inflow = null, drainThroughputLine = null, pipelineIssues = null, boardNumbersData = null, boardReport = undefined, boardReportPrev = null, reportOnly = false, skipMacLocal = false, now = new Date(),
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
        // Receipts (BRO-5481) get no Dispatch-a-fix button.
        if (!q || !q.title || q.actionUrl || (q.info === true && q.decision !== true)) continue;
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

  const loopDeadMsg = digestLoopDeadMessage({ sections, autofixRows, stuckCount, pipelineIssues, skipMacLocal, now });
  const subject = buildSubject({ health: sections.health, autofixRows, awaitingOwner: sections.awaitingOwner, needsYou: sections.needsYou, inReviewBacklog: sections.inReviewBacklog, loopDead: !!loopDeadMsg, now });
  const html = buildHtml({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, inflow, drainThroughputLine, pipelineIssues, boardNumbersData, boardReport, boardReportPrev, loopDeadMsg, reportOnly, skipMacLocal, now });
  return { subject, html };
}

const BOARD_TABLE_SNAPSHOT = path.join(REPO, 'data', 'audit', 'board-report-snapshot.json');

/**
 * BRO-6442: the board category report plus yesterday's snapshot. Never throws:
 * report undefined = kill switch (no block), null = Linear failed (the email
 * says the table is unavailable).
 */
async function fetchBoardTable({ now = new Date(), graphql = null, snapshotPath = BOARD_TABLE_SNAPSHOT } = {}) {
  if (/^(1|true)$/i.test(String(process.env.DIGEST_BOARD_TABLE_DISABLED || ''))) return { report: undefined, prev: null };
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { /* first run, or no snapshot on this machine */ }
  try {
    const bc = require('./lib/board-categories.js');
    const gql = graphql || require('./lib/linear-client.js').graphql;
    const issues = await withTimeout(bc.fetchOpenBoard({ graphql: gql }), 60_000, { message: 'timed out after 60000ms' });
    return { report: bc.categorizeBoard(issues, { now, secret: process.env.APPROVAL_HMAC_SECRET || null }), prev };
  } catch (err) {
    console.error(`[digest] WARN board category table failed: ${String(err.message).slice(0, 120)}`);
    return { report: null, prev };
  }
}

/** Counts only (no titles), gitignored, per machine: same convention as linear-drain-throughput-snapshot.json. */
function saveBoardTableSnapshot(report, snapshotPath = BOARD_TABLE_SNAPSHOT) {
  if (!report) return;
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(require('./lib/board-categories.js').snapshotOf(report), null, 2) + '\n');
  } catch (err) {
    console.error(`[digest] WARN could not write board-report-snapshot.json (non-fatal): ${err.message}`);
  }
}

async function main() {
  // --help must never fall through to a real send (bug class #260/#263/#264).
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  if (dryRun) process.env.DIGEST_NO_LIST_TOKEN = '1';
  const noAutofix = !!args['no-autofix'];
  const skipMacLocal = !!args['skip-mac-local'];
  const resendSentGuard = !!args['resend-sent-guard'];
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
  sections.moneySignups = await collectMoneySignups();

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
  if (!skipMacLocal) try {
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
  if (!skipMacLocal) try {
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

  // BRO-2199: same cross-machine gap for health-check.js's two "Dispatch:"
  // rows (checkDispatchHealth). data/audit/dispatch-ledger.jsonl is
  // gitignored/Mac-local, so in CI those rows are always the suffixed
  // "(unmeasurable here)" warn and the real 'error' (dead-launch or headless
  // success rate past its floor) can never reach the owner. This sender runs
  // on the machine that writes the ledger, so evaluate it here.
  if (!skipMacLocal) try {
    const dispatchLedger = require('./lib/dispatch-ledger.js');
    const { computeDispatchHealthDigest, computeHeadlessDispatchDigest } = require('./lib/dispatch-health.js');
    const dispatchEntries = dispatchLedger.readEntries();
    const nowMs = Date.now();
    for (const row of [
      computeDispatchHealthDigest({ entries: dispatchEntries, nowMs }),
      computeHeadlessDispatchDigest({ entries: dispatchEntries, nowMs }),
    ]) {
      if (row.status === 'error') {
        if (!sections.health) sections.health = {};
        if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
        sections.health.errors.push({ name: row.name, message: row.message, hint: row.hint });
      }
    }
  } catch (err) {
    console.error(`[digest] WARN could not evaluate local dispatch-health ledger: ${String(err.message).slice(0, 120)}`);
  }

  // BRO-2049: the shared checkout going shallow (a --shallow-since fetch) silently broke every session's
  // did-it-land proof for ~3 weeks. health-check.js cannot measure it (GitHub Actions only, and CI checkouts
  // are shallow by design), so this sender, which runs on the Mac that owns ~/Broadwayscore, evaluates it.
  // A warn is pushed into health.errors so the verdict line NAMES it instead of counting it as a routine warn.
  if (!skipMacLocal) try {
    const { shallowDigestRow } = require('./lib/shared-checkout-shallow.js');
    const shallowRow = shallowDigestRow({ fromDir: REPO });
    if (shallowRow.status === 'warn') {
      if (!sections.health) sections.health = {};
      if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
      sections.health.errors.push({ name: shallowRow.name, message: shallowRow.message, hint: shallowRow.hint });
    }
  } catch (err) {
    console.error(`[digest] WARN could not evaluate shared-checkout depth: ${String(err.message).slice(0, 120)}`);
  }

  // BRO-3050: cmux-triage.js (is the work behind each dead cmux tab done?)
  // had no caller. Shell its real CLI; collectCmuxTriage never throws and
  // reports cmux-absent / degraded runs as "no verdict", never as zeros.
  if (!skipMacLocal) try {
    sections.cmuxTriage = collectCmuxTriage({ cwd: REPO });
    console.log(`[digest] ${renderCmuxTriageLine(sections.cmuxTriage).text}`);
  } catch (err) {
    console.error(`[digest] WARN cmux triage failed: ${String(err.message).slice(0, 120)}`);
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
    sections.syncRefused = readSyncRefused({ ignoreTags: retiredSyncTags().filter((t) => t !== DIGEST_SYNC_TAG) });
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
  if (!skipMacLocal) try {
    const { buildNeedsYouSnapshot } = require('./lib/needs-you-snapshot.js');
    const snap = buildNeedsYouSnapshot();
    if (snap && snap.items.length) sections.needsYou = snap;
  } catch (err) {
    console.error(`[digest] WARN needs-you snapshot failed: ${String(err.message).slice(0, 120)}`);
  }
  // BRO-3444: the cmux tabs above exist only on the Mac. Linear cards with a
  // "DECISION NEEDED:" line are the owner's decisions wherever the digest
  // runs, so they join the same section (and so the subject's "N decisions
  // for you"). Started now, awaited after the awaiting-owner fetch below so
  // the two Linear round trips overlap; fail-soft and time-boxed like it.
  const linearDecisionsPromise = (async () => {
    const { fetchOpenIssues, attachDecisionComments } = require('./notify-owner-decisions.js');
    const { buildDecisionsSection } = require('./lib/owner-decision-notify.js');
    // BRO-6266: comments for the decision cards only, so the digest applies the
    // same already-answered test as the decision email.
    const issues = await withTimeout(fetchOpenIssues().then(attachDecisionComments), 15_000, { message: 'timed out after 15000ms' });
    return buildDecisionsSection(issues);
  })();
  linearDecisionsPromise.catch(() => {}); // handled where awaited

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
    const issues = await withTimeout(linear.listOpenIssues(), 15_000, { message: 'timed out after 15000ms' });
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
    // BRO-6539: an owner who answered (Owner decision / Approve) without removing the label is not still waiting.
    const section = buildAwaitingOwnerSection(enriched.filter(isAwaitingOwner).filter((i) => !require('./lib/decision-restate.js').isIssueAnswered(i)));
    if (section) sections.awaitingOwner = section;
  } catch (err) {
    sections.boardWaitingUnknown = true; // Board numbers shows n/a, not 0 (BRO-5482)
    console.error(`[digest] WARN awaiting-owner section failed: ${String(err.message).slice(0, 120)}`);
  }

  try {
    const linearDecisions = await linearDecisionsPromise;
    if (linearDecisions) sections.needsYou = mergeNeedsYouSections(sections.needsYou, linearDecisions);
  } catch (err) {
    console.error(`[digest] WARN Linear decisions section failed: ${String(err.message).slice(0, 120)}`);
  }

  // Parked in review (BRO-3376) — the passive half of BRO-282. See
  // scripts/lib/in-review-backlog.js's header for why this is a separate
  // block from the awaiting-owner one above rather than folded into it.
  // Pure shaping over the fetch already made above; fail-soft like every
  // other section, and it omits itself entirely when nothing has been
  // sitting past the idle threshold.
  try {
    if (openIssues && openIssues.length) {
      const { buildInReviewSection, countTechnicalInReview, enrichForOwnerMarkers } = require('./lib/in-review-backlog.js');
      // Read body + comments of the idle unmarked cards so a DECISION NEEDED
      // that is not in the title still reaches the owner (unreadable = shown).
      await enrichForOwnerMarkers(openIssues, require('./lib/linear-client.js').graphql);
      // Owner-marked cards only (BRO-5433): technical cards a worker parked
      // In Review are not owner decisions. stuck-card-closer closes or
      // bounces them; the count below keeps them visible under Technical
      // details so hiding them cannot rebuild the BRO-3376 pile unseen.
      const section = buildInReviewSection(openIssues, { ownerOnly: true });
      if (section) sections.inReviewBacklog = section;
      const technicalCount = countTechnicalInReview(openIssues);
      if (technicalCount) sections.inReviewTechnicalCount = technicalCount;
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
  // this card is about. --skip-mac-local: the ledgers are Mac-only, so off the
  // Mac this would always be 'blind' (BRO-6230); the footer line names it instead.
  if (!skipMacLocal) try {
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

  // BRO-5669: owner-login-dependent sources (Mezzanine token, Theatr token,
  // outlet cookies) that stopped updating. Visitors-affected, never "handled".
  try {
    const { findFrozenLoginSources, ghFetchRuns, injectLoginRows } = require('./lib/login-sources.js');
    const { rows, errors } = findFrozenLoginSources({ fetchRuns: ghFetchRuns, now: new Date() });
    injectLoginRows(sections, rows);
    for (const e of errors) console.error(`[digest] WARN login-source check: ${e}`);
    console.log(`[digest] login-sources: ${rows.length ? rows.map((r) => r.name).join('; ') : 'none frozen'}`);
  } catch (err) {
    console.error(`[digest] WARN login-sources check failed: ${String(err.message).slice(0, 120)}`);
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
    // `new Date()` inline, NOT the `now` binding — that const is declared ~140
    // lines below this block, so referencing it here is a TDZ ReferenceError
    // that the catch would swallow into one WARN line and a row that never
    // renders. Exactly the fail-soft-hides-breakage shape that let every
    // consumer of the Notion read-only flip report success while dead.
    const counts = await withTimeout(fetchInflowCounts({ graphql, now: new Date() }), 20_000, { message: 'timed out after 20000ms' });
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
    const unarmed = await withTimeout(fetchUnarmedUrgentHighCount({ graphql }), 20_000, { message: 'timed out after 20000ms' });

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

    const donePerDay = inflowCounts
      ? doneRatePerDay(inflowCounts.completed, inflowCounts.windowDays, {
          // A truncated `completed` count is a FLOOR (backlog-inflow-ratio.js's
          // fetchInflowCounts), not the real number — must render n/a, not an
          // understated rate presented as exact (ship-check/Codex finding).
          truncated: Array.isArray(inflowCounts.truncatedCounts) && inflowCounts.truncatedCounts.includes('completed'),
        })
      : null;
    drainThroughputLine = formatDrainThroughputLine({
      donePerDay,
      windowDays: inflowCounts ? inflowCounts.windowDays : null,
      eligible,
      eligibleOk,
      unarmedCount: unarmed.ok ? unarmed.count : null,
    });
    console.log(`[digest] ${drainThroughputLine}`);

    // BRO-4135: persist the one number this block already computed daily so
    // scripts/check-linear-drain-throughput.js (the RECHECK command on
    // BRO-3913) can read it instead of issuing its OWN live Linear query —
    // linear-drain-throughput.js's own header explicitly rejected a second
    // live source for this exact number ("reusing that avoids a THIRD live
    // Linear query for a number that process already computes"). Per-machine
    // only (this script is launchd-scheduled, not CI — see
    // com.broadwayscore.morning-digest.plist) — gitignored, same convention
    // as the dispatch-watchdog heartbeat and predispatch-queue-audit
    // snapshot files.
    try {
      fs.mkdirSync(path.join(REPO, 'data', 'audit'), { recursive: true });
      fs.writeFileSync(
        path.join(REPO, 'data', 'audit', 'linear-drain-throughput-snapshot.json'),
        JSON.stringify({ computedAt: new Date().toISOString(), donePerDay, windowDays: inflowCounts ? inflowCounts.windowDays : null }, null, 2) + '\n',
      );
    } catch (snapshotErr) {
      console.error(`[digest] WARN could not write linear-drain-throughput-snapshot.json (non-fatal): ${snapshotErr.message}`);
    }
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
  let stuckKnown = false; // false when the overnight collector failed: Board numbers shows n/a, not 0
  try {
    const { gatherDigest, renderDigestBlock, countStuckSignals } = require('./lib/overnight-digest.js');
    const digest = gatherDigest({ repo: REPO });
    if (digest) {
      changesHtml = renderDigestBlock(digest);
      stuckCount = countStuckSignals(digest);
      stuckKnown = true;
    }
  } catch (err) {
    console.error(`[digest] WARN overnight-changes gathering failed: ${String(err.message).slice(0, 120)}`);
  }

  // Digest v3 auto-fix (owner mandate 2026-08-02): every named health issue
  // gets its card filed and the oldest few dispatched as headless fix
  // sessions — the email then REPORTS, never asks.
  // BRO-3697: the freshness/stuck rollups are core health-check.js rows now
  // ("Data freshness: shows missing poster/synopsis/tickets" via
  // checkDataFreshnessGaps, "Stuck pipeline items" via
  // checkStuckPipelineItems), so they normally reach planAutofix through
  // sections.health.warns from the snapshot. localRollupIssues folds the
  // local counts in only when the snapshot lacks that row (a stale snapshot,
  // or stuck signals only this machine can see), never as a duplicate.
  // Fail-soft: any error here degrades to un-annotated rows, never blocks the send.
  let autofixRows = null;
  // --no-autofix (BRO-6230, the Action): plan only, no card filing or
  // dispatch, and no Mac task dir. Rows with an open Linear card read
  // 'tracked' so the email matches the Mac's "already has a fix ticket".
  if (noAutofix) try {
    const { planAutofix, markTrackedReportOnly, keepDecisionQueued, localRollupIssues } = require('./lib/digest-autofix.js');
    const openTitles = Array.isArray(openIssues) ? new Set(openIssues.map((i) => i && i.title).filter(Boolean)) : null;
    const queued = Array.isArray(sections.health?.queued) ? sections.health.queued : [];
    autofixRows = markTrackedReportOnly(planAutofix({ health: sections.health, extraIssues: localRollupIssues({ health: sections.health, freshnessCount: sections.freshness?.count || 0, freshnessItems: sections.freshness?.items, stuckCount }), tasks: [], queued }), openTitles);
    if (sections.health && Array.isArray(sections.health.queued)) sections.health.queued = keepDecisionQueued(sections.health.queued, autofixRows);
    const tracked = autofixRows.filter((r) => r.state === 'tracked').length;
    console.log(`[digest] --no-autofix: report only, nothing filed or dispatched; ${tracked} of ${autofixRows.length} row(s) already have an open card${openTitles ? '' : ' (Linear unreadable)'}`);
  } catch (err) {
    console.error(`[digest] WARN report-only autofix failed (email still sends): ${String(err.message).slice(0, 160)}`);
  }
  else try {
    const { planAutofix, runAutofix, keepDecisionQueued, localRollupIssues } = require('./lib/digest-autofix.js');
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
    // BRO-5430: planAutofix's tracked check reads only the retired Notion
    // mirror, so a row whose Linear card was already open sat in the 72h gate
    // labelled 'watching' (11 of 27 rows on 2026-10-16). Reuses the open-board
    // fetch above; null (that fetch failed) keeps the gate as before.
    const openLinearTitles = Array.isArray(openIssues)
      ? new Set(openIssues.map((i) => i && i.title).filter(Boolean))
      : null;
    autofixRows = runAutofix({ plan: planAutofix({ health: sections.health, extraIssues: localRollupIssues({ health: sections.health, freshnessCount: sections.freshness?.count || 0, freshnessItems: sections.freshness?.items, stuckCount }), tasks, queued: queuedForAutofix }), dryRun: autofixDryRun, log: (m) => console.log(m), concurrencyCap: DIGEST_CONCURRENCY_CAP, openLinearTitles });
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
      sections.health.queued = keepDecisionQueued(sections.health.queued, autofixRows);
    }
    const d = autofixRows.filter(r => r.state === 'dispatched' || r.state === 'in-progress').length;
    const decisions = autofixRows.filter(r => r.state === 'decision').length;
    const infos = autofixRows.filter(r => r.state === 'info').length;
    console.log(`[digest] autofix: ${autofixRows.length - infos} issue(s) — ${d} being worked, ${autofixRows.length - infos - d - decisions} queued, ${decisions} decision(s) left for the owner, ${infos} receipt(s)`);
  } catch (err) {
    console.error(`[digest] WARN autofix failed (email still sends): ${String(err.message).slice(0, 160)}`);
  }

  // Digest-autofix S6 (task #1225, owner mandate 2026-08-10): daily
  // end-to-end canary — resolves yesterday's synthetic dispatch-pipeline
  // probe and files/dispatches today's, through the REAL pipeline (card
  // filing -> notion-tasks-sync -> bsc-next --headless -> verify gate ->
  // completion). Tomorrow's health-check reads the ledger this writes.
  // Fail-soft: never blocks the digest send.
  if (!noAutofix) try {
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
  // BRO-5168: Linear's view of automated-fix throughput for the stalled banner.
  let pipelineIssues = null;
  try {
    pipelineIssues = await fetchPipelineIssues();
  } catch (err) {
    console.error(`[digest] WARN could not read pipeline cards from Linear: ${String(err.message).slice(0, 120)}`);
  }
  if (!stuckKnown) sections.boardStuckUnknown = true;
  // Board numbers (BRO-5482): fail-soft, each piece degrades to "n/a" on its own.
  let boardNumbersData = null;
  try {
    boardNumbersData = await withTimeout(require('./lib/board-numbers.js').fetchBoardNumbersData({ graphql: require('./lib/linear-client.js').graphql, now, cwd: REPO }), 330_000, { message: 'timed out after 330000ms' });
  } catch (err) {
    console.error(`[digest] WARN board numbers failed: ${String(err.message).slice(0, 120)}`);
  }
  // BRO-6442: the board category table, fail-soft. DIGEST_BOARD_TABLE_DISABLED=1 drops the block.
  const boardTable = await fetchBoardTable({ now });
  if (skipMacLocal) {
    const { readMacAlive } = require('./lib/mac-applied-heartbeat.js');
    sections.macLocalSkipped = macLocalSkippedLine(await readMacAlive({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN }));
    console.log(`[digest] ${sections.macLocalSkipped.text}`);
  }
  const { subject, html } = composeDigestEmail({ sections, problemsNote, changesHtml, stuckCount, autofixRows, overnightLine, inflow, drainThroughputLine, pipelineIssues, boardNumbersData, boardReport: boardTable.report, boardReportPrev: boardTable.prev, reportOnly: noAutofix, skipMacLocal, now });

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

  // BRO-6230: the ~/.broadwayscore-state guard below lives on one machine. A
  // second sender (the GitHub Action) cannot see it, so it asks Resend instead.
  let resendGuard = null;
  if (resendSentGuard) {
    const recipient = sendTo || process.env.OWNER_EMAIL || null;
    resendGuard = await resendSentToday({ apiKey: process.env.RESEND_API_KEY, recipient });
    console.log(`[digest] Resend sent-today guard: ${resendGuard.verdict} — ${resendGuard.reason}`);
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

  if (resendGuard && !args.force && resendGuard.verdict !== 'send') {
    console.error(`[digest] refusing to send: Resend guard says ${resendGuard.verdict} (${resendGuard.reason}).`);
    process.exit(resendGuard.verdict === 'already-sent' ? 1 : 2);
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
  // Tomorrow's "change since yesterday" reads this; a dry run never writes it.
  // The snapshot is the owner's baseline for the (+N) deltas: a test send to
  // another address must not move it.
  if (process.env.OWNER_EMAIL && sendTo === process.env.OWNER_EMAIL) saveBoardTableSnapshot(boardTable.report);
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

module.exports = { decisionsListLinkHtml, buildSubject, buildHtml, parseArgs, composeDigestEmail, mergeNeedsYouSections, macLabelRetired, localCyrusRelayMessage, localRunnerHealthMessage, localLinearDelegationMessage, localCodexConnectionLine, retiredSyncTags, autofixShouldDryRun, DIGEST_SYNC_TAG, localDispatchWatchdogLeakMessage, macLocalSkippedLine, resendSentToday, fetchBoardTable, saveBoardTableSnapshot };
