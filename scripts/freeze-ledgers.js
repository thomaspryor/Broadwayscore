#!/usr/bin/env node
// scripts/freeze-ledgers.js — BRO-385 Phase 3 migration cleanup.
//
// Two independent actions, both scoped to the specific finding behind
// BRO-385 ("roughly a third of the open backlog is the system talking to
// itself"):
//
//   freeze                — writes ONE dated note declaring the fleet's own
//                            self-audit ledgers frozen for 30 days. Additive
//                            only: it does not touch the ledgers themselves.
//                            Making producers actually RESPECT this record
//                            (rewiring health-check.js/dispatch-watchdog.js
//                            call sites to check it before filing a card) is
//                            BRO-2603 — see isFrozen()/isLedgerFrozenNow()
//                            below, the predicate those call sites use.
//   close-safe-duplicates — closes ONLY exact-title duplicates among the
//                            self-referential cards, and only the older
//                            copy of a pair where a newer, untouched copy of
//                            the identical alert is already open. See
//                            "WHY NOT A FULL BULK CLOSE" below for why this
//                            is deliberately narrower than "close ~90 cards".
//
// "Self-referential" reuses classifyNoise() from linear-import-rules.js (the
// Notion→Linear corpus classifier already in production for this same
// migration) rather than a new ad-hoc keyword list (CLAUDE.md rule 15).
// Deliberately narrower than classifyNoise's full noise set: `missing_show`
// and `rage_ux` are real product/data signals, not fleet self-talk, so they
// are excluded here even though the importer treats them the same way.
// `email_triage` looks self-referential (an `[em-...]` id prefix) but a spot
// check of the live board showed real user bug reports and feedback-form
// submissions filed under that prefix — so it is excluded too.
//
// WHY NOT A FULL BULK CLOSE (found while building this, 2026-08-26):
// classifyNoise() decides Notion→Linear IMPORT eligibility, not "safe to
// delete". Fetching full Notes/Outcome for the ~90 title-matched candidates
// showed roughly half carry either a RECHECK-AFTER stamp (a session's fix
// already shipped and is pending a data-driven verification — e.g. a P0
// "cmux dead-launch rate" card whose Outcome documented a merged fix with CI
// proof, only the post-fix metric recheck was still pending) or a
// substantial written Outcome (real investigation/triage, not an empty
// auto-generated stub). A live test of the naive "close everything
// title-matched" approach closed that exact pending-recheck P0 card before
// this was caught and reverted (status + Outcome restored). The remaining
// ~44 empty-Outcome candidates are mostly genuine, still-open reliability
// problems in the cmux/Notion dispatch fleet that is STILL the live board
// today (this very script was run from a session dispatched through it,
// and BRO-377/BRO-384 — the cutover phases that would make the fleet
// non-live — are still Backlog) — not noise, just backlog about a system
// the owner has already decided not to keep repairing (see
// memory/project_linear_migration_decision.md). Closing them with a
// "self-audit noise" Outcome would be a false statement, not cleanup. That
// bulk judgment call is left to the owner; see the BRO-385 comment.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyNoise } = require('./lib/linear-import-rules.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/freeze-ledgers.js <freeze|list-self-referential|close-safe-duplicates> [--dry-run]';

const REPO = path.join(__dirname, '..');
const NOTION_BRAIN = path.join(REPO, 'scripts', 'notion-brain.js');
const FREEZE_RECORD_PATH = path.join(REPO, 'data', 'audit', 'BRO-385-ledger-freeze.json');
const NOTION_TIMEOUT_MS = 30_000;
const FREEZE_DAYS = 30;
const RECHECK_RE = /RECHECK-AFTER/i;
// Above this length an Outcome is real written investigation, not an empty
// auto-generated stub — measured against the live board (2026-08-26): every
// untouched fleet/digest card had outcome_len === 0, every card with actual
// session work had outcome_len in the hundreds to low thousands.
const SUBSTANTIAL_OUTCOME_CHARS = 80;

const SELF_REFERENTIAL_NOISE_KEYS = ['fleet_selfref', 'bsc_daily'];

// The fleet's own self-audit ledgers — data ABOUT the dispatch/session/digest
// system's health, not about show/review content. These are what the daily
// health-check and dispatch-watchdog runs read to decide whether to open a
// new "BSC Daily: ..." / fleet-drift card.
const FROZEN_LEDGERS = [
  'data/audit/health-check-history.json',
  'data/audit/health-digest-snapshot.json',
  'data/audit/dispatch-ledger.jsonl',
  'data/audit/autonomous-ledger.jsonl',
  'data/audit/autonomous-recheck-ledger.jsonl',
  'data/audit/arm-yield-ledger.jsonl',
  'data/audit/digest-autofix-ledger.jsonl',
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Freeze-window predicate (BRO-2603) ---
//
// isFrozen is pure — no I/O, no Date.now() — so it's deterministically unit
// testable. `nowMs` is a REQUIRED epoch-ms number, never a Date, matching
// scripts/lib/dispatch-health.js's computeDeadRate convention: `frozenAt`/
// `thawAt` in the freeze record are plain "YYYY-MM-DD" strings, and comparing
// a Date object against those strings directly is a silent trap — JS's
// relational abstract-comparison converts the Date via valueOf() (a number)
// but converts the string via ToNumber("2026-09-25") -> NaN, and every
// comparison against NaN is false. That would make the freeze look
// permanently inert with no error, exactly the bug this predicate exists to
// avoid (plan-review finding, BRO-2603). Parsing both bounds to epoch ms once
// here, and requiring the caller's `now` to already be a number, closes it.
function isFrozen(ledgerName, nowMs, freezeRecord) {
  if (!freezeRecord || !Array.isArray(freezeRecord.ledgers)) return false;
  if (!freezeRecord.ledgers.includes(ledgerName)) return false;
  const frozenAtMs = Date.parse(`${freezeRecord.frozenAt}T00:00:00Z`);
  const thawAtMs = Date.parse(`${freezeRecord.thawAt}T00:00:00Z`);
  if (Number.isNaN(frozenAtMs) || Number.isNaN(thawAtMs)) return false;
  // Thaw boundary is EXCLUSIVE — the thaw date itself is no longer frozen,
  // matching the freeze record's own English ("thaw 2026-09-25").
  return nowMs >= frozenAtMs && nowMs < thawAtMs;
}

// I/O: reads + parses the freeze record. Returns null on missing/unparseable
// rather than throwing — fail-open, since the ABSENCE of a freeze record must
// never be mistaken for "everything is frozen" by a caller that forgets to
// null-check.
function readFreezeRecord(freezeRecordPath = FREEZE_RECORD_PATH) {
  try {
    return JSON.parse(fs.readFileSync(freezeRecordPath, 'utf8'));
  } catch {
    return null;
  }
}

// Convenience wrapper for real call sites: current time, current record, one
// ledger name. Re-reads the record on every call (a few-hundred-byte JSON
// file) instead of caching, so an owner edit mid-window (extend/shorten/
// cancel the freeze) takes effect on a producer's very next run without a
// process restart.
function isLedgerFrozenNow(ledgerName, freezeRecordPath = FREEZE_RECORD_PATH) {
  return isFrozen(ledgerName, Date.now(), readFreezeRecord(freezeRecordPath));
}

// Shared skip-log line so every gated call site prints the same shape instead
// of a bespoke string each (this predicate already has 3 call sites as of
// BRO-2603).
function freezeSkipMessage(ledgerName, freezeRecordPath = FREEZE_RECORD_PATH) {
  const record = readFreezeRecord(freezeRecordPath);
  return `BRO-385 freeze active until ${record && record.thawAt ? record.thawAt : '?'} (${ledgerName})`;
}

function runFreeze() {
  const frozenAt = todayIso();
  const thawAt = addDaysIso(frozenAt, FREEZE_DAYS);
  const record = {
    issue: 'BRO-385',
    frozenAt,
    thawAt,
    freezeDays: FREEZE_DAYS,
    note:
      `Fleet self-audit ledgers frozen ${frozenAt} for ${FREEZE_DAYS} days (thaw ${thawAt}) ` +
      `as part of BRO-385 Phase 3 (Notion→Linear cutover cleanup). These ledgers back the ` +
      `daily "BSC Daily" digest cards and fleet/dispatch drift cards that make up roughly a ` +
      `third of the open backlog — closing existing duplicate cards without freezing the ` +
      `source would just regenerate them tomorrow. This record is documentation of the ` +
      `decision and window; it does not itself change what health-check.js or the dispatch ` +
      `watchdogs do — wiring them to respect it is shared dispatch infra (CLAUDE.md rule 18) ` +
      `and needs its own reviewed change.`,
    ledgers: FROZEN_LEDGERS,
  };
  fs.mkdirSync(path.dirname(FREEZE_RECORD_PATH), { recursive: true });
  fs.writeFileSync(FREEZE_RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
  console.log(`Wrote freeze record: ${path.relative(REPO, FREEZE_RECORD_PATH)}`);
  console.log(`  frozen ${frozenAt} → thaw ${thawAt} (${FREEZE_DAYS}d)`);
  console.log(`  ${FROZEN_LEDGERS.length} ledgers listed`);
}

function listOpenCards() {
  const r = spawnSync(
    'node',
    [NOTION_BRAIN, 'list', '--limit=3000', '--status=Not started,Paused,In progress', '--include-notes'],
    { encoding: 'utf8', timeout: NOTION_TIMEOUT_MS * 4, maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error(`notion-brain list failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function isUntouched(card) {
  const notes = String(card.notes || '');
  const outcome = String(card.outcome || '').trim();
  if (RECHECK_RE.test(notes) || RECHECK_RE.test(outcome)) return false;
  if (outcome.length > SUBSTANTIAL_OUTCOME_CHARS) return false;
  return true;
}

function findSelfReferentialCards() {
  const cards = listOpenCards();
  return cards
    .map((c) => ({ card: c, noise: classifyNoise(c.name) }))
    .filter(({ noise }) => SELF_REFERENTIAL_NOISE_KEYS.includes(noise));
}

// Older copies of an exact-title pair where a newer copy is still open (so
// the alert keeps being tracked either way) AND the older copy itself has no
// work of its own (RECHECK-AFTER stamp or a real Outcome) to lose.
function findSafeDuplicates() {
  const matches = findSelfReferentialCards();
  const byTitle = new Map();
  for (const m of matches) {
    const list = byTitle.get(m.card.name) || [];
    list.push(m);
    byTitle.set(m.card.name, list);
  }

  const toClose = [];
  for (const [, group] of byTitle) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.card.ageDays ?? 0) - (b.card.ageDays ?? 0));
    // Newest copy always survives (it's what keeps tracking the alert), so
    // an older copy is safe to close whenever IT carries no work of its own
    // — whatever state the newest is in doesn't change what the older copy
    // has to lose.
    for (const older of sorted.slice(1)) {
      if (isUntouched(older.card)) toClose.push(older);
    }
  }
  return toClose;
}

function outcomeText(keptTitle) {
  const today = todayIso();
  return (
    `BRO-385 Phase 3 bulk close (${today}). Closed as a stale duplicate: an untouched, ` +
    `identically-titled "${keptTitle}" card is already open and remains open, so nothing ` +
    `about this alert stops being tracked. This is a recurring daily-digest re-create ` +
    `(fleet self-audit noise, not product/content work), part of the ~1/3-of-backlog ` +
    `"system talking to itself" pattern BRO-385 targets. Source ledgers frozen 30 days, see ` +
    `data/audit/BRO-385-ledger-freeze.json. Closed by scripts/freeze-ledgers.js.`
  );
}

// `list --include-notes` returns raw property previews capped at ~1800
// chars (notion-brain.js's own documented overflow gotcha) — a RECHECK-AFTER
// stamp or real writeup living past that cutoff would not show up there and
// could slip an untouched-looking card past isUntouched(). `get` stitches
// the full page-body overflow back in, so it is re-checked here, right
// before the write, on just the handful of candidates instead of on all
// ~2000 open cards (too slow to do universally).
function fetchFullCard(id) {
  const r = spawnSync('node', [NOTION_BRAIN, 'get', id], { encoding: 'utf8', timeout: NOTION_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`notion-brain get ${id} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function closeCard(id, keptTitle, { dryRun }) {
  const full = fetchFullCard(id);
  if (!isUntouched(full)) {
    return { id, status: 'skipped-on-full-recheck' };
  }
  if (dryRun) return { id, status: 'dry-run' };
  const r = spawnSync(
    'node',
    [
      NOTION_BRAIN,
      'update',
      id,
      '--status',
      'Done',
      '--outcome',
      outcomeText(keptTitle),
      '--force',
      'BRO-385 Phase 3: close stale duplicate, newer untouched copy stays open',
    ],
    { encoding: 'utf8', timeout: NOTION_TIMEOUT_MS }
  );
  if (r.status !== 0) {
    return { id, status: 'error', error: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  }
  return { id, status: 'closed' };
}

function runList() {
  const matches = findSelfReferentialCards();
  console.log(
    JSON.stringify(
      matches.map((m) => ({
        id: m.card.id,
        name: m.card.name,
        noise: m.noise,
        priority: m.card.priority,
        untouched: isUntouched(m.card),
      })),
      null,
      2
    )
  );
  const untouched = matches.filter((m) => isUntouched(m.card)).length;
  console.error(`\n${matches.length} self-referential card(s) found (${untouched} untouched, ${matches.length - untouched} carry real work/pending recheck — excluded from any close action).`);
}

function runCloseDuplicates({ dryRun }) {
  const toClose = findSafeDuplicates();
  console.error(`Found ${toClose.length} safe stale-duplicate card(s)${dryRun ? ' (dry run — no writes)' : ''}.`);
  const results = toClose.map(({ card }) => {
    const res = closeCard(card.id, card.name, { dryRun });
    console.error(`  [${res.status}] ${card.name}${res.error ? ` — ${res.error}` : ''}`);
    return { ...res, name: card.name };
  });
  const closed = results.filter((r) => r.status === 'closed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  console.log(JSON.stringify({ total: results.length, closed, errored, dryRun: !!dryRun, results }, null, 2));
  if (errored > 0) process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv.slice(0, 1))) { console.log(USAGE); return; }

  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');

  switch (command) {
    case 'freeze':
      runFreeze();
      break;
    case 'list-self-referential':
      runList();
      break;
    case 'close-safe-duplicates':
      runCloseDuplicates({ dryRun });
      break;
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  classifyNoise,
  SELF_REFERENTIAL_NOISE_KEYS,
  FROZEN_LEDGERS,
  addDaysIso,
  isUntouched,
  SUBSTANTIAL_OUTCOME_CHARS,
  FREEZE_RECORD_PATH,
  isFrozen,
  readFreezeRecord,
  isLedgerFrozenNow,
  freezeSkipMessage,
};
