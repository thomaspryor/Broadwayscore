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
const UNIT = '(?:days?|nights?|weeks?|months?)';
const PROSE_DATE_WAIT_RES = [
  /\b(?:no earlier than|not before|earliest(?: on)?|until|on or after)\s+(?:\w+\s+)?\d{4}-\d{2}-\d{2}\b/i,
  new RegExp(`\\b(?:wait(?:s|ing)?|needs?|requires?|after|gives?|let it (?:run|bake|soak))\\b[^.\\n]{0,40}\\b(?:about |around |at least |another |roughly )?${NUM}\\s+${UNIT}\\b`, 'i'),
  new RegExp(`\\b(?:about |around )?${NUM}\\s+${UNIT}\\s+of\\s+\\w+`, 'i'),
  /\b(?:next|following)\s+(?:week|month|opening night|cron|nightly)\b/i,
];
// A real block (credential, money, the Mac, an owner call) is never a time wait, even when a duration appears next to it.
const BLOCK_RE = /\b(?:api[- ]?keys?|tokens?|credentials?|creds|spend(?:ing)?|credits?|budget|mac|launchd|iphone|simulator|owner|decision|approv\w*|go-ahead|private[- ]repo)\b|\$\d/i;
// Everything in ASYNC_WAIT_RES except the stamp itself (a stamped card is handled by the recheck).
const ASYNC_TIME_RES = ASYNC_WAIT_RES.filter((re) => !/RECHECK/.test(re.source));

/** True when `text` waits on time in prose. A card or reason that carries a parseable RECHECK-AFTER stamp is never one. */
function proseDateWait(text) {
  const t = String(text || '');
  if (parseRecheckAfter(t) != null) return false;
  if (BLOCK_RE.test(t)) return false;
  return PROSE_DATE_WAIT_RES.some((re) => re.test(t)) || ASYNC_TIME_RES.some((re) => re.test(t));
}

/** True when `linear-brain create` must refuse this park: a session filer (no --source, not a workflow) whose reason is a prose wait and whose notes carry no stamp. */
function parkRefusedForProse({ park, source, notes, env }) {
  if (typeof park !== 'string' || typeof source === 'string' || (env && env.GITHUB_WORKFLOW)) return false;
  return proseDateWait(park) && parseRecheckAfter(notes || '') == null;
}

/** The one-line refusal printed by `linear-brain create --park`. */
const PROSE_WAIT_REFUSAL = 'PARK-REFUSED: the reason waits on time written in words, and nothing resumes a card that has no stamp. Put "RECHECK-AFTER: YYYY-MM-DD" (the day to look again) in the notes, or file --dispatch with a VERIFY (BRO-6857).';

module.exports = { proseDateWait, parkRefusedForProse, PROSE_WAIT_REFUSAL, PROSE_DATE_WAIT_RES };
