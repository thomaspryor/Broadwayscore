/**
 * board-targeting-sources.js — the I/O half of the BRO-3423 board-targeting
 * check: read the fleet's dispatch ledgers off local disk, and read the armed
 * population off the live board.
 *
 * Split from board-targeting-audit.js (which is pure and holds every decision)
 * so both consumers share one collector rather than two drifting copies:
 *
 *   scripts/audit-board-targeting.js   on-demand CLI, prints + --json
 *   scripts/send-morning-digest.js     folds the verdict into sections.health.errors
 *
 * WHY THIS LIVES IN scripts/lib/ AND NOT IN THE CLI. test.yml's push-path
 * allow-list covers `scripts/lib/**` with a glob but NOT top-level `scripts/`
 * files, and the unit-test job globs `scripts/lib/*.test.mjs` at execution
 * time. Logic parked in the CLI would get ZERO CI on a solo edit — the exact
 * gap memory/feedback_test_yml_push_path_allowlist.md documents three separate
 * recurrences of. The CLI above is therefore argument parsing and printing and
 * nothing else.
 *
 * WHY ALL THREE LEDGERS. `drain-dispatch` — one of the dispatcher events most
 * worth auditing — is not written to dispatch-ledger.jsonl at all; it lives in
 * backlog-drain-ledger.jsonl and linear-drain-parked-ledger.jsonl. A collector
 * that read only the main ledger would report the drain as "no data" rather
 * than as 100% retired-board, which is what it actually measured on
 * 2026-09-15 (56 rows, all Notion). Reading two of the three was a
 * second-opinion review finding against the first draft of this card.
 *
 * Note backlog-drain-ledger.jsonl's last row is 2026-08-31: that producer is
 * dead. `lastRowTs` on every writer row is what makes that visible instead of
 * letting a dead producer read as a quiet, healthy one.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { isBoardTaskId } = require('./task-id-namespace.js');
const { LEDGER_PATH } = require('./dispatch-ledger.js');

// The repo root is taken from dispatch-ledger.js's own LEDGER_PATH rather than
// from `path.join(__dirname, '..', '..')`. That module hardcodes the main
// checkout on purpose (see its lines 28-38) because the ledgers are gitignored
// and exist ONLY there — a __dirname-relative root resolves to whatever
// worktree the caller happens to be running from, where the files are absent.
//
// This is not a hypothetical: the first run of this very audit, from a
// worktree, read zero rows from both Mac-local ledgers and cheerfully printed
// "OK — all writers targeting the live board". A check that reports healthy
// because it cannot see its own evidence is the exact failure BRO-3423 is
// about, so the path comes from the one module that already got this right,
// and PRIMARY_LEDGER below makes the blind case impossible to mistake for a
// pass.
const REPO = path.dirname(path.dirname(path.dirname(LEDGER_PATH)));

// dispatch-ledger.jsonl is the fleet's main dispatch record. If it cannot be
// read there is no audit — not a clean one.
const PRIMARY_LEDGER = 'data/audit/dispatch-ledger.jsonl';

// All three dispatch ledgers. dispatch-ledger.jsonl and
// backlog-drain-ledger.jsonl are gitignored and Mac-local (per-machine state
// that CI never sees — which is why this check cannot live in health-check.js,
// whose rows are produced on ubuntu-latest where these files do not exist).
const LEDGER_FILES = Object.freeze([
  PRIMARY_LEDGER,
  'data/audit/backlog-drain-ledger.jsonl',
  'data/audit/linear-drain-parked-ledger.jsonl',
]);

/**
 * Read every dispatch ledger into one row array, plus the set of every task id
 * that has EVER appeared in any of them.
 *
 * Fail-soft per file: a missing or unreadable ledger is reported in `problems`
 * and skipped, never thrown. A malformed line is skipped. Neither can be
 * allowed to take down the morning digest.
 */
function readDispatchLedgers(opts) {
  const { repo = REPO, files = LEDGER_FILES } = opts || {};
  const rows = [];
  const everTouchedIds = new Set();
  const problems = [];
  const sources = [];

  for (const rel of files) {
    const abs = path.join(repo, rel);
    let raw;
    try {
      if (!fs.existsSync(abs)) {
        problems.push(`${rel}: absent`);
        sources.push({ file: rel, rows: 0, present: false });
        continue;
      }
      raw = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      problems.push(`${rel}: unreadable (${String(err.message).slice(0, 80)})`);
      sources.push({ file: rel, rows: 0, present: false });
      continue;
    }

    let count = 0;
    let lastTs = null;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let row;
      try { row = JSON.parse(t); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      rows.push(row);
      count += 1;
      if (row.ts && (!lastTs || row.ts > lastTs)) lastTs = row.ts;
      const id = row.taskId != null ? row.taskId : row.id;
      if (id != null && isBoardTaskId(id)) everTouchedIds.add(String(id));
    }
    sources.push({ file: rel, rows: count, present: true, lastRowTs: lastTs });
  }

  // "Could not see the evidence" must never render as "everything is fine".
  // The primary ledger being absent or empty is a blind audit, and the caller
  // is expected to report it as unknown rather than pass.
  const primary = sources.find((s) => s.file === PRIMARY_LEDGER);
  const blind = !primary || !primary.present || primary.rows === 0;

  return { rows, everTouchedIds, problems, sources, blind, primaryLedger: PRIMARY_LEDGER };
}

/**
 * Fetch the armed/dispatchable population from the live board.
 *
 * Deliberately reuses linear-watchdog-source.js's own eligibility rather than
 * restating it: that module IS what the continuous dispatcher queues from, so
 * the audit and the dispatcher cannot disagree about who is eligible. The
 * known cost of that reuse (second-opinion finding) is that a bug shrinking
 * eligibility would shrink this denominator too — which is exactly why the
 * caller also reports the raw open-issue count beside it, so a collapse shows
 * up as a visible number instead of a silent PASS.
 *
 * Never throws: an outage, a page-cap truncation or a missing token all come
 * back as {ok:false, reason}, and the pure layer renders that as 'unknown'
 * rather than as a clean bill of health.
 */
async function fetchLiveBoardArmed(opts) {
  const { timeoutMs = 20_000, client = null, source = null } = opts || {};
  let src = source;
  let linear = client;
  try {
    if (!src) src = require('./linear-watchdog-source.js');
    if (!linear) linear = require('./linear-client.js');
  } catch (err) {
    return { ok: false, reason: `module load failed: ${String(err.message).slice(0, 120)}`, eligibleIds: [] };
  }

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs));
    const res = await Promise.race([src.fetchLinearWatchdogTasks(linear, {}), timeout]);
    if (!res || !res.ok) {
      return { ok: false, reason: (res && res.reason) || 'live-board fetch returned no result', eligibleIds: [] };
    }
    // fetchLinearWatchdogTasks returns `tasks` as a Map keyed by taskId.
    const eligibleIds = res.tasks instanceof Map ? [...res.tasks.keys()] : [];
    return { ok: true, reason: null, eligibleIds, scanned: res.scanned };
  } catch (err) {
    return { ok: false, reason: String(err.message).slice(0, 120), eligibleIds: [] };
  }
}

module.exports = {
  LEDGER_FILES,
  PRIMARY_LEDGER,
  REPO,
  readDispatchLedgers,
  fetchLiveBoardArmed,
};
