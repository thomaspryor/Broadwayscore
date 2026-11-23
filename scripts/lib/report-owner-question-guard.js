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

// BRO-8152: the guard above is satisfied by a block in the REPORT, but the report posts as a comment
// and the owner emailer (owner-decision-notify.js) reads only the description. Paused P1/P2 cards
// sat for days with their question unseen (BRO-7980 score gate, BRO-7976 spend) while the digest
// counted them as "has a fix ticket". So the report's block is copied to the top of the description.
const PROMOTED_MARKER = '<!-- decision-promoted-from-report -->';
const MAX_PROMOTED_CHARS = 2500;

/**
 * PURE. The description to write after a report, or null when nothing changes: only for a
 * paused/blocked/in-review report whose summary or verification carries a real
 * "DECISION NEEDED:" and whose description has none yet. Works on code-stripped text, so a
 * fenced or inline-code example is never promoted as the question.
 * @param {{status: string, summary?: string, verification?: string, description?: string}} p
 * @returns {string|null}
 */
function promotedDecisionDescription({ status, summary, verification, description } = {}) {
  if (process.env.DECISION_PROMOTE_DISABLED === '1') return null; // kill switch
  if (!GUARDED_STATUSES.has(status)) return null;
  const { findDecisionQuestion, SETTLED_RE } = require('./decision-card-parse.js');
  const desc = String(description || '').replace(/\r\n?/g, '\n');
  // Heading-form blocks ("## DECISION NEEDED" + question line) count too: the emailer reads them.
  if (hasRealBlock(desc) || findDecisionQuestion(desc)) return null;
  const text = [summary, verification].filter(Boolean).join('\n').replace(/\r\n?/g, '\n');
  if (!hasRealBlock(text)) return null;
  const lines = stripCode(text);
  let block;
  const found = findDecisionQuestion(lines.join('\n'));
  if (found) block = lines.slice(found.index).join('\n');
  else {
    // Inline in a paragraph ("Report. DECISION NEEDED - pick A?"): cut that line at the marker.
    const INLINE = /\**DECISION NEEDED\**(?:\s*\([^)]*\))?\s*[:\u2013\u2014-]\s*\S/;
    const i = lines.findIndex((l) => l.includes('DECISION NEEDED') && INLINE.test(l));
    if (i < 0) return null;
    const line = lines[i];
    block = [line.slice(line.search(INLINE)), ...lines.slice(i + 1)].join('\n');
  }
  // Dash form passes the guard; the emailer needs the colon.
  block = block.trim().replace(/^(\**DECISION NEEDED\**(?:\s*\([^)]*\))?)\s*[\u2013\u2014-]\s*/, '$1: ');
  if (block.length > MAX_PROMOTED_CHARS) block = `${block.slice(0, MAX_PROMOTED_CHARS - 1)}\u2026`;
  const q = findDecisionQuestion(block);
  if (!q) return null;
  // Never re-ask an answered question (BRO-6539 shape): only an answered/settled line on the card
  // that already holds this question suppresses it, never ordinary context.
  const { foldDiacritics } = require('./title-match');
  const norm = (t) => foldDiacritics(String(t).toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
  const nq = norm(q.question).slice(0, 80);
  if (nq.length >= 15 && desc.split('\n').some((l) => SETTLED_RE.test(l.replace(/^[\s>*#-]+/, '')) && norm(l).includes(nq))) return null;
  return `${block}\n\n${PROMOTED_MARKER}\n\n${desc}`;
}

module.exports = { checkHiddenOwnerQuestion, GUARDED_STATUSES, promotedDecisionDescription, PROMOTED_MARKER };
