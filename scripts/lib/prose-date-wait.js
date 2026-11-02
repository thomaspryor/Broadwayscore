'use strict';
/**
 * prose-date-wait.js (BRO-6857): a park reason that waits on TIME written in words
 * ("promote no earlier than 2026-11-13", "waits for 2 weeks of hit data", "needs about a week of
 * per-lane data"). Nothing resumes such a card: the nightly recheck reads only RECHECK-AFTER stamps.
 * A real block (key, money, the Mac) is not a time wait and never matches here.
 * Reuses ASYNC_WAIT_RES (headless-dispatchability.js) for "after <date>", "N clean runs", "next cron".
 */
const { ASYNC_WAIT_RES } = require('./headless-dispatchability.js');
const { parseRecheckAfter } = require('./recheck-stamp.js');

const NUM = '(?:\\d+|an?|one|two|three|four|five|six|seven|several|few)';
const UNIT = '(?:hours?|days?|nights?|weeks?|months?|runs?)';
const PROSE_DATE_WAIT_RES = [
  /\b(?:no earlier than|not before|earliest(?: on)?|until|on or after|from)\s+(?:\w+\s+)?\d{4}-\d{2}-\d{2}\b/i,
  new RegExp(`\\b(?:wait(?:s|ing)?|needs?|requires?|after|gives?|let it (?:run|bake|soak))\\b[^.\\n]{0,40}\\b(?:about |around |at least |another |roughly )?${NUM}\\s+${UNIT}\\b`, 'i'),
  new RegExp(`\\b(?:about |around )?${NUM}\\s+${UNIT}\\s+of\\s+\\w+`, 'i'),
  /\b(?:next|following)\s+(?:week|month|opening night|cron|nightly)\b/i,
];
// Everything in ASYNC_WAIT_RES except the stamp itself (a stamped card is handled by the recheck).
const ASYNC_TIME_RES = ASYNC_WAIT_RES.filter((re) => !/RECHECK/.test(re.source));

/** True when `text` waits on time in prose. A card or reason that carries a parseable RECHECK-AFTER stamp is never one. */
function proseDateWait(text) {
  const t = String(text || '');
  if (parseRecheckAfter(t) != null) return false;
  return PROSE_DATE_WAIT_RES.some((re) => re.test(t)) || ASYNC_TIME_RES.some((re) => re.test(t));
}

/** The one-line refusal printed by `linear-brain create --park`. */
const PROSE_WAIT_REFUSAL = 'PARK-REFUSED: the reason waits on time written in words, and nothing resumes a card that has no stamp. Put "RECHECK-AFTER: YYYY-MM-DD" (the day to look again) in the notes, or file --dispatch with a VERIFY (BRO-6857).';

module.exports = { proseDateWait, PROSE_WAIT_REFUSAL, PROSE_DATE_WAIT_RES };
