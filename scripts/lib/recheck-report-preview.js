'use strict';
/**
 * BRO-7622: when `linear-session.js report` stamps RECHECK-AFTER, say which
 * command the nightly recheck will actually run on that date, using the
 * recheck's own selection (selectRecheckTargets over mapIssueToCard and the
 * dispatch ledger). Same selector, but not identical inputs: it reads this
 * machine's dispatch ledger (absent in cloud) and getIssue()'s comment page,
 * and the nightly run also skips claimed or over-budget cards. Advisory text
 * says "set to run", never a promise.
 *
 * BRO-6794 is the case it exists for: the report named the real probe, but
 * (a) the probe was not a registered safe form and (b) its VERIFY sat
 * mid-sentence, so the recheck kept running the dispatch-ledger snapshot
 * (`verify-data-backfill --show=broadway,...`), which could never pass. The
 * session saw nothing. Advisory only (CLAUDE.md §19): it prints, never blocks.
 */
const { mapIssueToCard } = require('./linear-recheck-source.js');
const { selectRecheckTargets } = require('./autonomous-recheck-core.js');
const { parseRecheckAfter } = require('./recheck-stamp.js');

// A VERIFY directive, not NO-VERIFY:/VERIFY-ONLY prose (ship-check finding).
const VERIFY_DIRECTIVE_RE = /(?<![-\w])VERIFY(?:[ \t]*\(correction\))?:/;
const squash = (s) => String(s || '').replace(/`/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` names exactly `cmd` (whitespace-insensitive, whole tokens: --max=10 is not --max=100). */
function namesCommand(text, cmd) {
  return new RegExp(`(?:^|[\\s(:'"])${escapeRe(squash(cmd))}(?=$|[\\s.,;:)'"])`).test(squash(text));
}

/**
 * @param {object} o
 * @param {object} o.issue      linear-client getIssue() result (identifier, description, state, comments.nodes)
 * @param {string} o.reportBody the outcome comment about to be posted
 * @param {object[]} [o.launchEntries] dispatch-ledger entries
 * @param {string} [o.now]      ISO time the report is posted (the new comment's createdAt)
 * @returns {null | {warn: boolean, cmd: string|null, message: string}}
 *   null when the report carries no RECHECK-AFTER stamp.
 */
function previewRecheckCommand({ issue, reportBody, launchEntries = [], now = new Date().toISOString() }) {
  const stampAt = parseRecheckAfter(reportBody);
  if (stampAt == null || !issue) return null;
  const nodes = ((issue.comments && issue.comments.nodes) || []).concat([{ body: String(reportBody), createdAt: now }]);
  const card = mapIssueToCard({ ...issue, comments: { nodes } });
  if (!card) return null;
  // Due on the stamped day; nobody holds the card then.
  const [target] = selectRecheckTargets({
    doneCards: [card], launchEntries, now: stampAt + 3600e3, isClaimed: () => false,
  });
  const cmd = target && target.verifyCmd ? target.verifyCmd : null;
  // The report names a VERIFY but the recheck picked something else (an older
  // dispatch snapshot, or a description command): the BRO-6794 shape.
  const mismatch = !!cmd && VERIFY_DIRECTIVE_RE.test(String(reportBody)) && !namesCommand(reportBody, cmd);
  if (cmd && mismatch) {
    return {
      warn: true,
      cmd,
      message: `This report names a VERIFY, but on ${new Date(stampAt).toISOString().slice(0, 10)} the nightly recheck is set to run a different command: ${cmd}\n`
        + 'Put the intended check on a line of its own: VERIFY (correction): <safe-form command> '
        + '(it must also be a safe form in scripts/lib/check-paths.js SAFE_CHECK_FORMS).',
    };
  }
  // BRO-7994: a recheck whose command only shows a file exists (test -f, ls) passes whatever happens live. The
  // incident card (Google One Tap) rechecked `test -f src/lib/google-one-tap.ts` while 14 of 14 real attempts failed.
  if (cmd && !require('./outside-setting.js').acceptanceIsReal(cmd)) {
    return {
      warn: true,
      cmd,
      message: `RECHECK-AFTER preview: on ${new Date(stampAt).toISOString().slice(0, 10)} the nightly recheck will run ${cmd}, which only shows a file exists and passes whatever happens live.\n`
        + 'If the point of the recheck is a live effect, post VERIFY (correction): <safe-form command that reads the live result>.',
    };
  }
  if (cmd) {
    return {
      warn: false,
      cmd,
      message: `RECHECK-AFTER preview: on ${new Date(stampAt).toISOString().slice(0, 10)} the nightly recheck is set to run: ${cmd}\n`
        + 'If that is not the check you mean, post a line of its own: VERIFY (correction): <safe-form command>',
    };
  }
  const why = (target && (target.reason || target.skip)) || 'no acceptance command arms on this card';
  return {
    warn: true,
    cmd: null,
    message: `RECHECK-AFTER is stamped but the nightly recheck will have NO command to run (${why}).\n`
      + 'Put the check on a line of its own (VERIFY: <cmd>), and make sure it is a safe form '
      + '(scripts/lib/check-paths.js SAFE_CHECK_FORMS; register a new read-only probe there).',
  };
}

module.exports = { previewRecheckCommand, namesCommand, VERIFY_DIRECTIVE_RE };
