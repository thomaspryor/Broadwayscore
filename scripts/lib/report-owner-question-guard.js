'use strict';
/**
 * BRO-6402: a session report that says the owner must decide has to carry a real
 * "DECISION NEEDED:" block, or the question stays hidden in a comment the email and
 * the owner list never read (BRO-6128, BRO-5447). Pure decision function for
 * `linear-session.js report`; the CLI refuses before the comment posts.
 */
const { hasInlineDecision, stripCode } = require('./decision-card-parse.js');

// hasInlineDecision is case-insensitive, so "Owner decision needed: add X?" in prose passes it.
// A real block is the literal uppercase marker, so only those lines are handed to it.
function hasRealBlock(text) {
  const marked = stripCode(text).filter((l) => l.includes('DECISION NEEDED')).join('\n');
  return !!marked && hasInlineDecision(marked);
}

// Statuses where a report hands work back. A done report that mentions the owner is a finished job.
// Phrases namesOwnerHold misses: its negation window reads "without an owner call" as a negation.
const EXTRA_OWNER_ASK_RE = /\bquestions? for (?:the )?owner\b|\b(?:needs|must|should|to) (?:thomas|the owner) (?:to )?(?:decide|choose|pick|answer)\b|\bawaiting (?:the )?owner(?:'s)? (?:input|answer|reply)\b|\buntil (?:the owner|thomas) (?:decides|chooses|answers)\b|\bwithout an? owner (?:call|decision)\b|\bowner (?:must|should|has to|needs to) (?:decide|choose|pick|answer)\b/i;

const DENIAL_RE = /\b(?:no|(?:does not|doesn't|do not|don't|never) need|needs? no)\s+(?:an? |the |any )?(?:questions? for (?:the )?owner|owner (?:decision|call|approval|judg(?:e)?ment))\b/i;

const GUARDED_STATUSES = new Set(['paused', 'blocked', 'in-review']);

/**
 * @param {{status: string, summary?: string, verification?: string, description?: string}} p
 * @returns {{hidden: boolean, reason?: string}}
 */
function checkHiddenOwnerQuestion({ status, summary, verification, description } = {}) {
  if (process.env.OWNER_QUESTION_GUARD_DISABLED === '1') return { hidden: false }; // kill switch
  if (!GUARDED_STATUSES.has(status)) return { hidden: false };
  const { namesOwnerHold } = require('./cloud-worker-pick.js');
  // Code spans and fenced examples are quotes of the rule, not a hand-off. A sentence that
  // denies an owner ask ("no question for the owner", "doesn't need an owner call") is not one.
  const reportText = stripCode([summary, verification].filter(Boolean).join('\n'))
    .flatMap((l) => l.split(/(?<=[.!?;])\s+/))
    .filter((l) => !DENIAL_RE.test(l))
    .join('\n');
  if (!namesOwnerHold(reportText) && !EXTRA_OWNER_ASK_RE.test(reportText)) return { hidden: false };
  if (hasRealBlock(reportText) || hasRealBlock(description)) return { hidden: false };
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
