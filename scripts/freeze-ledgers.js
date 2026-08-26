#!/usr/bin/env node
// scripts/freeze-ledgers.js — BRO-385 Phase 3 migration cleanup.
//
// Two independent actions, both scoped to the specific finding behind
// BRO-385 ("roughly a third of the open backlog is the system talking to
// itself"):
//
//   freeze                — writes ONE dated note declaring the fleet's own
//                            self-audit ledgers frozen for 30 days. Additive
//                            only: it does not touch the ledgers themselves
//                            or the scripts that write to them (rewiring
//                            health-check.js/dispatch-ledger.js to actually
//                            suppress new card creation is shared dispatch
//                            infra — CLAUDE.md rule 18 — and out of scope
//                            here; this just records the decision + window).
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

function closeCard(id, keptTitle, { dryRun }) {
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
  const [command, ...rest] = process.argv.slice(2);
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
      console.error(
        'Usage: node scripts/freeze-ledgers.js <freeze|list-self-referential|close-safe-duplicates> [--dry-run]'
      );
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
};
