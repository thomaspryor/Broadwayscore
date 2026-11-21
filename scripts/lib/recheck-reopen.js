'use strict';
/**
 * recheck-reopen.js (BRO-7697). A Done card whose own VERIFY command FAILS on
 * fresh main, twice in a row (runVerify already retries once), is no longer
 * Done. This moves it Done -> Todo with an evidence comment (command, commit,
 * output tail, run URL) so the normal worker queue picks it up. Before this,
 * the failure was only reported (ledger, morning email) or batched into one
 * route card (BRO-7138) while the original stayed Done on the board.
 *
 * Reverses the shadow-mode rule "failures are only reported" (owner brief,
 * 2026-11-17). Guard rails, in the order they matter:
 *   - ENFORCEMENT BAR: live only when enforcementState() (config
 *     recheckEnforcement + shouldExitShadow) says so. Otherwise 'shadow': the
 *     ledger gets a 'would-reopen' row and nothing is written to Linear.
 *   - KILL SWITCH: RECHECK_REOPEN=off (repo variable), no code change.
 *   - CAP: at most REOPEN_CAP_PER_NIGHT live reopens per rolling 20h, counted
 *     from the ledger so a manual --backlog run cannot double the night.
 *     Overflow stays Done and is picked up on a later night by the existing
 *     rewatch (recheck-route.js selectRewatchTargets), oldest first.
 *   - MAX_REOPENS: a card reopened twice that fails a third time is PARKED
 *     (Paused + plain-English owner note), never reopened again.
 *   - Never reopens: could-not-run (envCause) rows, unverifiable rows, skipped
 *     rows, or a card an open card already names (coverIndex): that card has an
 *     owner and the BRO-7138 batch body says "do not reopen the originals".
 *
 * decideReopen / reopenMode / counters are pure. reopenCard / parkCard are the
 * I/O half, shaped like recheck-handoff.js handoffCard (re-read, state guard,
 * linear-brain update, exit trapped, 30s bound).
 */

const { recheckVerdict } = require('./check-env-cause.js');
const { ExitTrap } = require('./recheck-autoclose.js');
const { quietAlertHours } = require('./recheck-route.js');

const RECHECK_REOPEN_MARKER = 'RECHECK-REOPENED:';
const RECHECK_PARK_MARKER = 'RECHECK-PARKED:';
const REOPEN_CAP_PER_NIGHT = 5;
const MAX_REOPENS = 2;
const CAP_WINDOW_HOURS = 20;

/** PURE. 'off' (kill switch) | 'shadow' (bar not cleared / not requested) | 'live'. */
function reopenMode({ env = process.env, enforcement = null } = {}) {
  if (String(env.RECHECK_REOPEN || '').toLowerCase() === 'off') return { mode: 'off', why: 'RECHECK_REOPEN=off' };
  // Live writes come from CI only: a laptop or container without the core data files would fail checks for the
  // wrong reason (missing data/*.json) and reopen cards for it. RECHECK_REOPEN_LOCAL=1 overrides for a drill.
  if (enforcement && enforcement.enforcing && String(env.GITHUB_ACTIONS) !== 'true' && !env.RECHECK_REOPEN_LOCAL) return { mode: 'shadow', why: 'not running in CI (set RECHECK_REOPEN_LOCAL=1 to drill)' };
  if (enforcement && enforcement.enforcing) return { mode: 'live', why: enforcement.reason };
  return { mode: 'shadow', why: enforcement ? enforcement.reason : 'enforcement state unavailable' };
}

/** Nightly cap, overridable without a code change (RECHECK_REOPEN_CAP). */
function reopenCap(env = process.env) {
  const n = Number(env.RECHECK_REOPEN_CAP);
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : REOPEN_CAP_PER_NIGHT;
}

const isLiveRow = (e, action) => e && e.event === 'recheck-reopen' && e.action === action && e.mode === 'live' && e.ok === true;

/** PURE. Live reopens per card (a queued or shadow row is not a reopen). */
function reopenCounts(entries) {
  const m = new Map();
  for (const e of entries || []) if (isLiveRow(e, 'reopened')) m.set(e.cardId, (m.get(e.cardId) || 0) + 1);
  return m;
}

/** PURE. Cards parked after MAX_REOPENS: never touched again. */
function parkedIds(entries) {
  const s = new Set();
  for (const e of entries || []) if (isLiveRow(e, 'parked')) s.add(e.cardId);
  return s;
}

/** PURE. Live reopens inside the rolling window: what is already spent of tonight's cap. */
function reopenedWithin(entries, { now = Date.now(), hours = CAP_WINDOW_HOURS } = {}) {
  const since = now - hours * 3600000;
  let n = 0;
  for (const e of entries || []) {
    if (!isLiveRow(e, 'reopened')) continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t >= since) n++;
  }
  return n;
}

/**
 * PURE.
 * @param {{row:object, reopenCount?:number, parked?:boolean, covered?:string|null, tsxTests?:Set<string>}} o
 *   row: this run's result (or its ledger row): status/skip/envCause/cardId/verifyCmd
 * @returns {{action:'reopen'|'park'|'none', reason:string}}
 */
function decideReopen({ row, reopenCount = 0, parked = false, covered = null, tsxTests } = {}) {
  const none = (reason) => ({ action: 'none', reason });
  if (!row || !row.cardId) return none('no row');
  if (row.skip) return none('skipped: someone is working it');
  const v = recheckVerdict(row, { tsxTests });
  if (v.status !== 'fail') return none(v.envCause ? 'could not run on the recheck machine' : `verdict is ${v.status || 'none'}, not fail`);
  if (!row.verifyCmd) return none('no runnable command');
  // A check that cannot load a core data file is a machine without the data, not a regression.
  if (/Cannot find module '[^']*\/data\/[^']+\.json'/.test(String(row.detail || row.note || ''))) return none('could not run: core data file missing on the recheck machine');
  if (parked) return none('already parked');
  if (covered) return none(`an open card already names it (${covered})`);
  if (reopenCount >= MAX_REOPENS) return { action: 'park', reason: `failed again after ${reopenCount} reopens` };
  return { action: 'reopen', reason: `its own check failed on fresh main (reopen ${reopenCount + 1} of ${MAX_REOPENS})` };
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tail = (s) => { const t = oneLine(s); return t.length > 400 ? `...${t.slice(-400)}` : t; };

function buildReopenComment({ row, sha = null, runUrl = null, reopenCount = 0, now = new Date() } = {}) {
  // An alert-absent check keeps failing for days after the alert stopped (quiet window); say so (BRO-7138).
  const quiet = quietAlertHours(row);
  return [
    RECHECK_REOPEN_MARKER,
    `Reopened by the nightly acceptance re-check (BRO-7697) on ${now.toISOString().slice(0, 10)}: this card was Done, but its own check fails on fresh main (reopen ${reopenCount + 1} of ${MAX_REOPENS}).`,
    `- command: \`${row.verifyCmd}\``,
    `- commit: ${sha ? String(sha).slice(0, 12) : 'unknown'}`,
    `- output tail: ${tail(row.detail || row.note) || '(no output kept)'}`,
    `- run: ${runUrl || 'n/a'}`,
    ...(quiet === null ? [] : [`- note: the alert last fired ${Math.round(quiet)}h ago and this check still counts it until its quiet window ends. Look at data/audit/alert-ledger.json first; if it has not fired since the card closed, confirm the condition itself is gone before closing.`]),
    'Worker: reproduce on main, then fix the regression, or (if the VERIFY went stale) rewrite it into a real check and say why. Close it again through the Done gate with evidence.',
  ].join('\n');
}

function buildParkComment({ row, sha = null, runUrl = null, now = new Date() } = {}) {
  return [
    RECHECK_PARK_MARKER,
    `Parked by the nightly acceptance re-check on ${now.toISOString().slice(0, 10)}.`,
    `This card was marked Done ${MAX_REOPENS + 1} times and its own check failed on fresh main each time (latest: \`${row.verifyCmd}\`, commit ${sha ? String(sha).slice(0, 12) : 'unknown'}, run ${runUrl || 'n/a'}). Two automatic reopens did not make the fix hold, so it will not be reopened again.`,
    'The owner needs to decide: keep working it, rewrite the check so it tests the real claim, or drop the claim.',
    `- output tail: ${tail(row.detail || row.note) || '(no output kept)'}`,
  ].join('\n');
}

/** Shared I/O shell: re-read, guard on state 'Done', run linear-brain update with exit trapped, bounded. */
async function moveDoneCard({ identifier, state, comment, linearBrainMain, getIssue, updateIssue } = {}) {
  const main = linearBrainMain || require('../linear-brain.js').main;
  const realExit = process.exit;
  let firstCode = null;
  let unpark = null;
  process.exit = (code) => {
    if (firstCode === null) firstCode = code == null ? 0 : code;
    throw new ExitTrap(firstCode);
  };
  try {
    const read = getIssue || require('./linear-client').getIssue;
    const issue = await read(identifier);
    const name = issue && issue.state && issue.state.name;
    // The run can take minutes after the fetch: never move a card that someone has already reopened.
    if (name !== 'Done') return { moved: false, error: `card is ${name || 'unknown'} now, not Done`, comment };
    // A closed card may carry the filer's machine PARKED line; cleared AFTER the move like handoffCard.
    if (state === 'Todo') {
      const hd = require('./headless-dispatchability.js');
      if (issue && issue.id && hd.hasOnlyMachinePark(issue.description)) {
        const write = updateIssue || require('./linear-client').updateIssue;
        unpark = async () => {
          const fresh = await read(identifier);
          if (!fresh || !hd.hasOnlyMachinePark(fresh.description)) return;
          const { unparkDescription } = require('./linear-drain-parked.js');
          await write(fresh.id || issue.id, { description: unparkDescription(fresh.description, 'BRO-7697 recheck reopen') });
        };
      }
    }
    await Promise.race([
      main(['update', identifier, '--state', state, '--comment', comment]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('reopen timed out after 30s')), 30000).unref()),
    ]);
    let unparkError = null;
    if (unpark) { try { await unpark(); } catch (e) { unparkError = String((e && e.message) || e).slice(0, 200); } }
    return { moved: true, error: null, comment, unparkError };
  } catch (err) {
    if (err instanceof ExitTrap) {
      if (err.exitCode === 0 && unpark) { try { await unpark(); } catch { /* best effort */ } }
      return err.exitCode === 0
        ? { moved: true, error: null, comment }
        : { moved: false, error: `linear-brain update exited ${err.exitCode}`, comment };
    }
    // A timeout can fire after the state change landed; count it as moved so the cap and MAX_REOPENS stay honest.
    try {
      const after = await (getIssue || require('./linear-client').getIssue)(identifier);
      const n = after && after.state && after.state.name;
      if (n && n !== 'Done' && n === (state === 'Todo' ? 'Todo' : 'Paused')) return { moved: true, error: null, comment, note: 'state change confirmed on re-read after an error' };
    } catch { /* fall through */ }
    return { moved: false, error: String((err && err.message) || err).slice(0, 200), comment };
  } finally {
    process.exit = realExit;
  }
}

const reopenCard = (o = {}) => moveDoneCard({ ...o, state: 'Todo' });
const parkCard = (o = {}) => moveDoneCard({ ...o, state: 'Paused' });

module.exports = {
  RECHECK_REOPEN_MARKER, RECHECK_PARK_MARKER, REOPEN_CAP_PER_NIGHT, MAX_REOPENS, CAP_WINDOW_HOURS,
  reopenMode, reopenCap, reopenCounts, parkedIds, reopenedWithin, decideReopen,
  buildReopenComment, buildParkComment, reopenCard, parkCard,
};
