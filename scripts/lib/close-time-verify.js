/**
 * close-time-verify.js — may this card move to Done right now?
 *
 * The question this asks is narrow on purpose: "is THIS card's own acceptance
 * command passing on origin/main?" Nothing else. Not "is trunk green", not
 * "who broke this test" — a card is answerable for the check it was dispatched
 * with, and for nothing anyone else pushed.
 *
 * Why (2026-08-04): notion-brain.js `update --status Done` is the single write
 * point that ever flips a card to Done, and it had no check at all.
 * notion-tasks-sync.js markCardDone calls it purely because the mirrored task
 * says completed — no commit SHA, no CI run, no verify result. Card #956
 * closed Done while the test it shipped (scripts/tests/tm-gap-links.test.mjs)
 * had failed 20 of the last 20 runs on main.
 *
 * The card's command is NOT inferred here — no git blame, no Notion Key Files
 * (presentation metadata that comes back empty from the API), no branch diff.
 * It is read from data/audit/dispatch-ledger.jsonl, where scripts/bsc-next.js
 * already records the verifyCmd it validated at dispatch and refuses to
 * dispatch without.
 *
 * Everything that is not a clean FAIL of the card's own command fails OPEN.
 * A card with no ledger entry, no verifyCmd, an owner-judgment card, an
 * unrunnable command, a timed-out check: warn, close. There are ~90 cards in
 * flight at any time; a check that blocks on ambiguity would deadlock all of
 * them, which is the failure mode this repo was actually in the day this was
 * written.
 *
 * What this does NOT prove (be honest about the ceiling): a passing command
 * means the card's acceptance PREDICATE holds on origin/main — not that this
 * card's branch is what made it hold. A card whose check passed before it
 * started still closes. The check catches the case that actually bit this
 * repo — a card closing while the test it shipped is red — and is not a
 * merge-verifier.
 *
 * Pure module — no fs, no exec, no network. The caller reads the ledger
 * (dispatch-ledger.js) and runs the command (acceptance-check-core.js); this
 * file only decides. CLAUDE.md §15: the test require()s these functions.
 */

'use strict';

// notion-brain.js exits with this when it refuses a close. Shared, not a
// literal in three files: automated closers (autonomous-merge.js,
// notion-tasks-sync.js) must be able to tell "the check said no" apart from
// "the Notion API broke", and handle only the former gracefully.
const CLOSE_REFUSED_EXIT_CODE = 5;

const VERDICTS = {
  DISABLED: 'disabled',
  BYPASSED: 'bypassed',
  NO_LEDGER_ENTRY: 'no-ledger-entry',
  NO_VERIFY_CMD: 'no-verify-cmd',
  OWNER_JUDGMENT: 'owner-judgment',
  NOT_RUN: 'check-not-run',
  PASS: 'own-verify-passed',
  UNVERIFIABLE: 'own-verify-unverifiable',
  FAIL: 'own-verify-failed',
};

/** Notion ids appear dashed and undashed; compare on the hex alone. */
function normalizeNotionId(id) {
  return String(id || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/**
 * The dispatch this card was launched with — LAST match wins, because a card
 * re-dispatched after a redraw carries a newer (possibly different) verifyCmd
 * and the stale first launch must not decide anything.
 *
 * notionId is matched first and alone when supplied: taskIds are recycled
 * across the shared task list, and a fallback that quietly matched a stranger's
 * task number would run somebody else's command against this card.
 *
 * @param {{entries:Array<object>, notionId?:string|null, taskId?:string|number|null}} o
 * @returns {{verifyCmd:string|null, allowUnverifiable:boolean, verifyReason:string|null,
 *   taskId:string|null, matchedBy:'notionId'|'taskId'|null, entry:object|null}}
 */
function findCardDispatch({ entries = [], notionId = null, taskId = null } = {}) {
  const none = { verifyCmd: null, allowUnverifiable: false, verifyReason: null, taskId: null, matchedBy: null, entry: null };
  const list = Array.isArray(entries) ? entries : [];
  const wantNotion = normalizeNotionId(notionId);
  const wantTask = taskId == null ? '' : String(taskId);

  const pick = (match) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e || e.event !== 'launch') continue;
      if (match(e)) return e;
    }
    return null;
  };

  let entry = null;
  let matchedBy = null;
  if (wantNotion) {
    entry = pick((e) => normalizeNotionId(e.notionId) === wantNotion);
    if (entry) matchedBy = 'notionId';
  }
  if (!entry && wantTask) {
    entry = pick((e) => String(e.taskId) === wantTask);
    if (entry) matchedBy = 'taskId';
  }
  if (!entry) return none;

  const cmd = typeof entry.verifyCmd === 'string' && entry.verifyCmd.trim() ? entry.verifyCmd.trim() : null;
  return {
    verifyCmd: cmd,
    allowUnverifiable: entry.allowUnverifiable === true,
    verifyReason: typeof entry.verifyReason === 'string' ? entry.verifyReason : null,
    taskId: entry.taskId != null ? String(entry.taskId) : null,
    matchedBy,
    entry,
  };
}

/**
 * The decision. Feed it the dispatch record (findCardDispatch) and, when there
 * was a command to run, the result of running it (acceptance-check-core
 * runVerify).
 *
 * @param {{dispatch?:object|null, verifyResult?:{status:string,detail?:string|null}|null,
 *   disabled?:boolean, bypassReason?:string|null}} o
 * @returns {{allowed:boolean, verdict:string, warn:boolean, message:string,
 *   verifyCmd:string|null}}
 */
function decideClose({ dispatch = null, verifyResult = null, disabled = false, bypassReason = null } = {}) {
  const cmd = dispatch && dispatch.verifyCmd ? dispatch.verifyCmd : null;
  const allow = (verdict, message, warn = false) => ({ allowed: true, verdict, warn, message, verifyCmd: cmd });

  if (disabled) return allow(VERDICTS.DISABLED, 'close-time verify disabled by env');
  if (bypassReason) return allow(VERDICTS.BYPASSED, `close-time verify bypassed: ${bypassReason}`, true);

  if (!dispatch || !dispatch.entry) {
    return allow(
      VERDICTS.NO_LEDGER_ENTRY,
      'no dispatch-ledger entry for this card — nothing to re-verify, closing without a check',
      true
    );
  }
  if (!cmd) {
    const why = dispatch.allowUnverifiable
      ? 'dispatched with --allow-unverifiable'
      : (dispatch.verifyReason || 'no acceptance command was captured at dispatch');
    return allow(
      VERDICTS.NO_VERIFY_CMD,
      `this card has no acceptance command in the dispatch ledger (${why}) — closing unchecked. ` +
      'Cards that name a safe-form command in their Acceptance criteria get re-run against origin/main here.',
      true
    );
  }
  if (!verifyResult || typeof verifyResult !== 'object') {
    return allow(VERDICTS.NOT_RUN, `could not run \`${cmd}\` — closing without a check`, true);
  }

  if (verifyResult.status === 'pass') {
    return allow(VERDICTS.PASS, `\`${cmd}\` passes on origin/main`);
  }
  if (verifyResult.status !== 'fail') {
    // 'unverifiable' — exit 3, an unrunnable/unsafe command, a timeout kill.
    // Evidence was unavailable; that is not proof the work is broken.
    return allow(
      VERDICTS.UNVERIFIABLE,
      `\`${cmd}\` could not be verified (${verifyResult.detail || 'no detail'}) — closing without a verdict`,
      true
    );
  }

  // "Could not find" is node --test's message for a path that isn't there —
  // the overwhelmingly common cause is a close attempted BEFORE the branch
  // merged, so the test the card wrote exists only in its worktree. Saying
  // "your test fails" there sends the next session hunting a bug that isn't
  // real; the actual instruction is "merge, then close".
  const notOnMain = /could not find|cannot find module|no such file or directory/i.test(String(verifyResult.detail || ''));
  return {
    allowed: false,
    verdict: VERDICTS.FAIL,
    warn: false,
    verifyCmd: cmd,
    notOnMain,
    message:
      `This card cannot close: its OWN acceptance command ${notOnMain ? 'cannot even run' : 'fails'} on a fresh checkout of origin/main.\n\n` +
      `  command: ${cmd}\n` +
      `  result:  ${notOnMain ? 'NOT ON MAIN — the path this command names is not on origin/main' : 'FAIL'}\n` +
      (verifyResult.detail ? `\n${String(verifyResult.detail).split('\n').map((l) => `  | ${l}`).join('\n')}\n` : '') +
      (notOnMain
        ? `\nMerge the branch first, then close the card. A card whose acceptance command exists only in\n` +
          `a worktree is exactly the "it shipped" claim this check is here to catch.`
        : `\nThis is the card's own check, captured when it was dispatched — not unrelated trunk redness,\n` +
          `which never blocks a close. Fix it on main, or leave the card open and hand it off.`),
  };
}

/**
 * Fold a report-only sweep (scripts/audit-close-time-verify.js) into the one
 * number that decides whether this check is safe to arm: how many in-flight
 * cards it would refuse to close right now.
 *
 * @param {Array<{cardId?:string, taskId?:string, subject?:string, decision:object}>} results
 */
function summarizeDryRun(results = []) {
  const rows = Array.isArray(results) ? results.filter(Boolean) : [];
  const counts = {};
  const blocked = [];
  for (const r of rows) {
    const v = (r.decision && r.decision.verdict) || VERDICTS.NOT_RUN;
    counts[v] = (counts[v] || 0) + 1;
    if (r.decision && r.decision.allowed === false) {
      blocked.push({
        cardId: r.cardId || null,
        taskId: r.taskId || null,
        subject: r.subject || null,
        verifyCmd: (r.decision && r.decision.verifyCmd) || null,
      });
    }
  }
  const total = rows.length;
  const withCmd = rows.filter((r) => r.decision && r.decision.verifyCmd).length;
  return {
    total,
    withVerifyCmd: withCmd,
    withoutVerifyCmd: total - withCmd,
    blocked: blocked.length,
    blockedPct: total ? Math.round((blocked.length / total) * 1000) / 10 : 0,
    counts,
    blockedCards: blocked,
    line: `close-time verify dry run: ${blocked.length}/${total} in-flight card(s) would be REFUSED ` +
      `(${withCmd} carry an acceptance command, ${total - withCmd} do not and are never blocked)`,
  };
}

module.exports = {
  CLOSE_REFUSED_EXIT_CODE, VERDICTS,
  normalizeNotionId, findCardDispatch, decideClose, summarizeDryRun,
};
