#!/usr/bin/env node
/**
 * monitor-scheduled-email-count.js — card #510.
 *
 * Cards #364 and #497 both migrated standalone digest emails onto
 * autonomous-email.js's single merged morning email, driven by the owner's
 * explicit goal ("exactly 1 scheduled email/day"). Nothing verified that
 * goal keeps holding — a future PR could add a new standalone Resend send
 * (or half-revert one of those migrations) and nobody would notice until
 * the owner complains again, the same way #352/#409/#475 each had to
 * re-fight the same noise problem.
 *
 * This reads REAL Resend send history (GET /emails), not code comments —
 * during this card's own investigation, autonomous-email.js's comments
 * claimed #497 was already folded while send-daily-digest.js and
 * send-opening-digest.js were still confirmed (via direct grep) to POST to
 * Resend on their own cron. Classification rules + why each sender is
 * included: scripts/lib/scheduled-email-count-rules.js.
 *
 * BRO-1690 correction: the digest-cadence check above is only half the
 * "exactly 1 scheduled email/day" goal. The other half — senders that
 * bypass scripts/lib/owner-alert-router.js entirely (classification:
 * 'direct' in scripts/audit-alert-senders.js) — is invisible to it, because
 * those sends don't go through the digest/cooldown machinery this file
 * counts at all. checkAlertSenderInventory() re-runs audit-alert-senders.js
 * fresh every call (never trusts a stale data/audit/alert-sender-inventory
 * .json) and asserts against its own reviewed baseline
 * (scripts/.alert-sender-baseline.json) — that baseline IS the "explicit,
 * reviewed exemption list" this card asks for; today it holds exactly the
 * two CLAUDE.md rule-14 real-time-critical senders (opening-night-broadcast
 * .yml, opening-night-poller.js).
 *
 * Usage:
 *   node scripts/monitor-scheduled-email-count.js               # live: checks the last complete ET day, routeAlert() on >1 sender or a direct-sender bypass
 *   node scripts/monitor-scheduled-email-count.js --dry-run             # report the last 7 days, no alert, exit 0
 *   node scripts/monitor-scheduled-email-count.js --dry-run --days=14
 *
 * Env: RESEND_API_KEY, OWNER_EMAIL for the digest-cadence half. Live mode's
 * routeAlert('auto') dispatch (both halves) additionally needs
 * LINEAR_API_KEY (see scripts/lib/owner-alert-router.js) — fails open if
 * missing, so a misconfigured env degrades to a run failure, not a hang.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildDailyReport, decideDayViolation, dayKeyET } = require('./lib/scheduled-email-count-rules');
const { compareToBaseline } = require('./audit-alert-senders.js');

const REPO_ROOT = path.join(__dirname, '..');
const AUDIT_ALERT_SENDERS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-alert-senders.js');
const ALERT_SENDER_BASELINE_PATH = path.join(REPO_ROOT, 'scripts', '.alert-sender-baseline.json');

const USAGE = `Usage: node scripts/monitor-scheduled-email-count.js [--dry-run] [--days=N]

  --dry-run   report the last 7 days (or --days=N), no alert, exit 0
  --days=N    override the lookback window (default: 7 with --dry-run, 2 live)

Live mode (no flags) checks the last complete ET day and calls routeAlert()
when 2+ distinct scheduled digest senders fired, or when a new/grown
classification=direct alert sender is found (fresh scripts/audit-alert-senders.js
scan vs scripts/.alert-sender-baseline.json). Env: RESEND_API_KEY, OWNER_EMAIL.`;

const DRY_RUN = process.argv.includes('--dry-run');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
// Live mode looks back 2 days so a run anytime after midnight ET still sees
// the full previous day even though "today" is partial; only complete days
// (dayKey < today) are eligible to alert — see the filter in main().
const WINDOW_DAYS = daysArg ? Number(daysArg.split('=')[1]) : (DRY_RUN ? 7 : 2);
// Broadcast sends (newsletter blasts) pad the feed with hundreds of non-owner
// rows per send at limit=100/page — cap pagination so a big broadcast day
// can't turn this into a runaway API loop. 40 pages = 4,000 emails scanned,
// comfortably more than a multi-day window with the owner's send volume.
const MAX_PAGES = 40;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

function getEmailsPage(after) {
  return new Promise((resolve, reject) => {
    const path = '/emails?limit=100' + (after ? `&after=${after}` : '');
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        timeout: 20000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// Paginates GET /emails (newest-first per Resend's API) until the page's
// oldest row falls before sinceMs, filtering to rows addressed to OWNER_EMAIL.
async function getEmailsPageWithRetry(after, retries = 2) {
  try {
    return await getEmailsPage(after);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return getEmailsPageWithRetry(after, retries - 1);
  }
}

async function fetchOwnerEmailsSince(sinceMs) {
  const owner = OWNER_EMAIL.toLowerCase();
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await getEmailsPageWithRetry(after);
    const data = j.data || [];
    if (data.length === 0) break;
    for (const e of data) {
      const to = Array.isArray(e.to) ? e.to : [e.to];
      if (to.some((t) => String(t || '').toLowerCase() === owner)) rows.push(e);
    }
    const last = data[data.length - 1];
    const lastMs = new Date(String(last.created_at).replace(' ', 'T').replace(/\+00$/, 'Z')).getTime();
    if (lastMs < sinceMs || !j.has_more) break;
    after = last.id;
  }
  return rows;
}

// Part (a) of the "exactly 1 scheduled email/day" goal — see the header
// comment. Shells out once to `--json`, which regenerates
// data/audit/alert-sender-inventory.json AND prints its summary
// (counts.direct, senders[]) — a single cheap regex/fs scan of scripts/ +
// .github/workflows/. The direct-sender-vs-baseline comparison then reuses
// audit-alert-senders.js's OWN compareToBaseline()/loaded baseline, in
// process — deliberately NOT `--check`, which conflates this gate with the
// unrelated human-caller-ignores-digest gate (card #616) into one
// process.exitCode; folding both into "found a direct-sender bypass" filed a
// misleading Linear card when only the digest gate regressed (review
// finding, this card). A crash here (bad JSON, ENOENT, timeout) throws
// instead of being swallowed as "violation found" — main() lets it propagate
// so a real script failure surfaces as a run failure, not a false alert.
function checkAlertSenderInventory() {
  const jsonOut = execFileSync('node', [AUDIT_ALERT_SENDERS_SCRIPT, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000,
  });
  const summary = JSON.parse(jsonOut);
  const directCounts = {};
  for (const s of summary.senders) {
    if (s.classification !== 'direct') continue;
    directCounts[s.file] = (directCounts[s.file] || 0) + 1;
  }
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(ALERT_SENDER_BASELINE_PATH, 'utf8')); } catch { /* treat as empty baseline */ }
  const cmp = compareToBaseline(directCounts, baseline);

  return { directCount: summary.counts.direct, ok: cmp.ok, newFiles: cmp.newFiles, grown: cmp.grown };
}

async function main() {
  // --help/-h checked BEFORE any network work (cousin of #260/#263/#264/#266
  // — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const inventory = checkAlertSenderInventory();
  console.log(`Alert-sender inventory: ${inventory.directCount} classification=direct sender(s) (data/audit/alert-sender-inventory.json regenerated fresh this run).`);
  if (!inventory.ok) {
    for (const f of inventory.newFiles) console.log(`  NEW direct sender: ${f} — not in scripts/.alert-sender-baseline.json`);
    for (const g of inventory.grown) console.log(`  GROWN direct sender: ${g.file} — ${g.baseline} -> ${g.current}`);
  }

  // Independent of the Resend-history section below (needs neither
  // RESEND_API_KEY nor OWNER_EMAIL — routeAlert's disposition:'auto' only
  // needs LINEAR_API_KEY) and of DRY_RUN's early return, so a misconfigured
  // Resend env or a --dry-run invocation can't strand a real direct-sender
  // regression unalerted (review finding, this card). conditionKey is
  // deliberately NOT date-keyed — this tracks a persisting code-level
  // condition (a file needs fixing), not a daily event, so the default
  // 7-day routeAlert cooldown applies instead of re-filing once per day.
  if (!DRY_RUN && !inventory.ok) {
    const { routeAlert } = require('./lib/owner-alert-router');
    const result = await routeAlert({
      conditionKey: 'alert-sender-direct-bypass',
      title: `New/grown direct alert sender bypassing owner-alert-router (${inventory.directCount} total)`,
      description: `scripts/audit-alert-senders.js found a new or grown classification=direct sender not covered by scripts/.alert-sender-baseline.json:\n${inventory.newFiles.map((f) => `  NEW: ${f}`).join('\n')}${inventory.grown.map((g) => `\n  GROWN: ${g.file} (${g.baseline} -> ${g.current})`).join('')}`,
      hint: 'Route the alert through routeAlert() (scripts/lib/owner-alert-router.js) instead of calling sendAlert(email:true)/Resend directly. If genuinely real-time-critical (CLAUDE.md rule 14), get it reviewed and freeze it via `node scripts/audit-alert-senders.js --update-baseline`.',
      severity: 'warning',
      disposition: 'auto',
    });
    console.log(`alert-sender-direct-bypass: routeAlert -> ${result.action}${result.cardId ? ` (card ${result.cardId})` : ''}`);
  }

  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    console.error('ERROR: RESEND_API_KEY and OWNER_EMAIL must both be set');
    process.exit(1);
  }

  const sinceMs = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
  const rows = await fetchOwnerEmailsSince(sinceMs);
  const days = buildDailyReport(rows, OWNER_EMAIL);
  const todayKey = dayKeyET(new Date().toISOString());

  const sortedDays = [...days.keys()].sort();
  const violations = [];
  for (const dayKey of sortedDays) {
    const bucket = days.get(dayKey);
    const decision = decideDayViolation(bucket, dayKey);
    const senderList = decision.senders.map((s) => `${s.label} (${s.subjects.length}x)`).join(', ') || '(none)';
    const partial = dayKey === todayKey ? ' [in progress]' : '';
    console.log(`${dayKey}${partial}: ${decision.senderCount} scheduled sender${decision.senderCount === 1 ? '' : 's'} — ${senderList}${bucket.other.length ? ` [+${bucket.other.length} unclassified owner email(s)]` : ''}`);
    if (decision.violation) violations.push({ dayKey, decision });
  }

  if (DRY_RUN) {
    console.log(`\n${violations.length} of ${sortedDays.length} day(s) had an unexpected scheduled sender fire (outside the expected daily set).`);
    return;
  }

  // Only complete days are eligible to alert — "today" is still accumulating
  // and a partial-day sender count of 1 doesn't mean the day will stay that way.
  const completeViolations = violations.filter((v) => v.dayKey < todayKey);

  // Zero-send floor (loop-retirement plan review): a silently dead morning
  // digest produces NO bucket and used to read as "No violations" — the
  // owner's only daily email could vanish for days unnoticed (its launchd
  // deadman was retired with the loop; this CI check is the replacement and
  // runs regardless of the Mac's state). Checked for ET-yesterday, the most
  // recent complete day.
  const { decideDayMissing } = require('./lib/scheduled-email-count-rules');
  const yesterdayKey = dayKeyET(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const missingDecision = yesterdayKey < todayKey ? decideDayMissing(days.get(yesterdayKey), yesterdayKey) : { missing: false, missingExpected: [] };
  const missingExpected = missingDecision.missingExpected || [];

  if (completeViolations.length === 0 && missingExpected.length === 0) {
    console.log('No violations on complete days in window (and both expected senders fired yesterday).');
    return;
  }

  const { routeAlert } = require('./lib/owner-alert-router');

  // One alert per dead expected sender (morning-digest on launchd,
  // opening-digest on a CI cron since its 2026-07-30 restore) — either dying
  // silently is the exact failure this floor exists to catch.
  const SENDER_HINTS = {
    'morning-digest': {
      title: (day) => `Morning digest did not arrive on ${day}`,
      body: 'The owner\'s morning email (scripts/send-morning-digest.js, launchd com.broadwayscore.morning-digest at 07:30 ET) likely failed silently — Mac asleep, launchd job unloaded, missing env, or a send error.',
      hint: 'On the Mac Studio: launchctl print gui/501/com.broadwayscore.morning-digest (loaded?), then check /tmp/morning-digest-launchd.log, then `node scripts/send-morning-digest.js --send-to-owner` to send manually.',
    },
    'opening-digest': {
      title: (day) => `Opening digest did not arrive on ${day}`,
      body: 'The standalone opening-night radar email (scripts/send-opening-digest.js, opening-digest.yml cron at 11:00 UTC) did not send — cron silently disabled, RESEND_API_KEY problem, or the script crashed.',
      hint: 'Check the latest "Opening Digest Email" run in Actions, then `gh workflow run opening-digest.yml` to send manually.',
    },
  };
  for (const key of missingExpected) {
    const s = SENDER_HINTS[key] || {
      title: (day) => `Expected scheduled email "${key}" did not arrive on ${day}`,
      body: 'An expected daily sender did not fire.',
      hint: 'Check its schedule and last run.',
    };
    const others = missingDecision.senderCount || 0;
    const result = await routeAlert({
      conditionKey: `scheduled-email-missing:${key}:${yesterdayKey}`,
      title: s.title(yesterdayKey),
      description: `The ${key} sender did not fire on ${yesterdayKey} (ET)${others ? ` (${others} other scheduled sender(s) did)` : ''}. ${s.body}`,
      hint: s.hint,
      severity: 'warning',
      disposition: 'auto',
      cooldownHours: 24,
    });
    console.log(`${yesterdayKey}: missing ${key} — routeAlert -> ${result.action}${result.cardId ? ` (card ${result.cardId})` : ''}`);
  }
  for (const { dayKey, decision } of completeViolations) {
    const subjectLines = decision.senders.map((s) => `- ${s.label}: ${s.subjects.join('; ')}`).join('\n');
    const result = await routeAlert({
      conditionKey: `scheduled-email-count:${dayKey}`,
      title: [
        (decision.unexpectedKeys || []).length ? `Unexpected scheduled digest sender fired on ${dayKey}: ${decision.unexpectedKeys.join(', ')}` : null,
        (decision.duplicateKeys || []).length ? `Scheduled sender delivered MORE THAN ONCE on ${dayKey}: ${decision.duplicateKeys.join(', ')}` : null,
      ].filter(Boolean).join(' · '),
      description: `Scheduled-email policy violation on ${dayKey} (expected: each daily sender exactly once — morning-digest + opening-digest, cards #364/#497 + owner restore 2026-07-30):\n${subjectLines}${(decision.duplicateKeys || []).length ? `\nDuplicate sender(s): ${decision.duplicateKeys.join(', ')} — check for a manual/test send bypassing the send-once-per-day guard in send-morning-digest.js.` : ''}`,
      hint: 'Fold the extra sender(s) onto the autonomous-email.js snapshot pattern (see cards #364/#497/#511 for the established fix shape).',
      severity: 'warning',
      disposition: 'auto',
      fields: decision.senders.map((s) => ({ name: s.label, value: `${s.subjects.length}x` })),
      cooldownHours: 24,
    });
    console.log(`${dayKey}: routeAlert -> ${result.action}${result.cardId ? ` (card ${result.cardId})` : ''}`);
  }
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
