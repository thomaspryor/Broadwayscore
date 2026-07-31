'use strict';

/**
 * rescore-queue-depth.js — the concrete needsRescore fixture for
 * progress-watch.js (task #597). Computes the count of needsRescore-flagged
 * review files that are actually eligible to be picked up by the
 * --needs-rescore selector RIGHT NOW.
 *
 * "Unblocked" deliberately excludes two classes that legitimately hold
 * needsRescore=true forever without the queue being stuck:
 *   - not isScoreable(): the sibling audit-stuck-rescore-flags.js's
 *     isStuckRescoreFlag class (queued but the scorer would reject it outright)
 *   - isBlockedFromRescore(): scripts/lib/rescore-lifecycle.js's terminal
 *     text-gate stamp (task #655) — a file that failed a deterministic,
 *     text-driven scoring gate and will keep failing until fullText itself
 *     changes. These files are BY DESIGN left needsRescore=true so a later
 *     text recovery makes them eligible again automatically.
 *
 * A naive "needsRescore===true total" counter would count both of those
 * classes as "remaining work" and could never reach zero — flagging this
 * exact queue as permanently stalled the day this monitor ships (second-
 * opinion review finding, task #597, 2026-07-30). This function mirrors the
 * real selector filter (scripts/llm-scoring/index.ts's --needs-rescore
 * predicate) so it can never drift from what the scorer actually picks up
 * (memory/feedback_includability_predicates_must_be_canonical).
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./list-show-dirs');
const { isScoreable } = require('./is-scoreable');
const { isBlockedFromRescore } = require('./rescore-lifecycle');

/**
 * @param {string} reviewTextsDir - path to data/review-texts
 * @param {Map<string,string>} titleById - showId -> title, for isScoreable's wrongShow override
 * @returns {{totalFlagged:number, notScoreable:number, blocked:number, unblocked:number, byReasonUnblocked:Object<string,number>}}
 */
function computeRescoreQueueDepth(reviewTextsDir, titleById) {
  let totalFlagged = 0;
  let notScoreable = 0;
  let blocked = 0;
  let unblocked = 0;
  const byReasonUnblocked = {};

  const showDirs = listShowDirs(reviewTextsDir).filter((f) =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );
  for (const showDir of showDirs) {
    const showPath = path.join(reviewTextsDir, showDir);
    const files = fs
      .readdirSync(showPath)
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const fp = path.join(showPath, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        continue;
      }
      if (data.needsRescore !== true) continue;
      totalFlagged++;

      const show = titleById.get(showDir) ? { title: titleById.get(showDir) } : undefined;
      if (!isScoreable(data, show, fp)) {
        notScoreable++;
        continue;
      }
      if (isBlockedFromRescore(data)) {
        blocked++;
        continue;
      }
      unblocked++;
      const reason = data.rescoreReason || '(none)';
      byReasonUnblocked[reason] = (byReasonUnblocked[reason] || 0) + 1;
    }
  }

  return { totalFlagged, notScoreable, blocked, unblocked, byReasonUnblocked };
}

module.exports = { computeRescoreQueueDepth };
