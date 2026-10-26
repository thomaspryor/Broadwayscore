'use strict';
/**
 * BRO-6402: a session report that says the owner must decide has to carry a real
 * "DECISION NEEDED:" block, or the question stays hidden in a comment the email and
 * the owner list never read (BRO-6128, BRO-5447). Pure decision function for
 * `linear-session.js report`; the CLI refuses before the comment posts.
 */
const { hasInlineDecision } = require('./decision-card-parse.js');

// Statuses where a report hands work back. A done report that mentions the owner is a finished job.
const GUARDED_STATUSES = new Set(['paused', 'blocked', 'in-review']);

/**
 * @param {{status: string, summary?: string, verification?: string, description?: string}} p
 * @returns {{hidden: boolean, reason?: string}}
 */
function checkHiddenOwnerQuestion({ status, summary, verification, description } = {}) {
  if (!GUARDED_STATUSES.has(status)) return { hidden: false };
  const { namesOwnerHold } = require('./cloud-worker-pick.js');
  const reportText = [summary, verification].filter(Boolean).join('\n');
  if (!namesOwnerHold(reportText)) return { hidden: false };
  if (hasInlineDecision(reportText) || hasInlineDecision(description)) return { hidden: false };
  return {
    hidden: true,
    reason:
      'This report says the owner must decide, but neither it nor the card has a "DECISION NEEDED:" block, ' +
      'so the question would never reach the owner email or list. Add to --summary, on separate lines:\n' +
      '  DECISION NEEDED: <what, one sentence, plain English>\n' +
      '  Why this is your call: <why>\n' +
      '  Option A - <name>: <upside> / <downside>\n' +
      '  Option B - <name>: <upside> / <downside>\n' +
      '  My recommendation: <X> because <Y>.\n' +
      '  Default: <what happens if they do not answer>.\n' +
      'If no owner decision is really needed, reword the report (e.g. "no owner decision needed").',
  };
}

module.exports = { checkHiddenOwnerQuestion, GUARDED_STATUSES };
