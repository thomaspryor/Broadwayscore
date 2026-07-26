// isFreshRecoupmentNews(entry, weekStartStr, weekEndStr) -> bool
//
// Shared gate for whether a commercial.json recoupment entry counts as NEWS
// for the weekly newsletter (both the body's Recoupment section and the
// subject/lede ranker input in scripts/newsletter/generate.mjs).
//
// Two conditions, both required:
//
// 1. The ANNOUNCEMENT is recent: recoupedDate (YYYY-MM monthly granularity)
//    must be the month of the issue week's start or end. `firstAdded` alone is
//    NOT recency — it records when OUR pipeline learned the fact, so a bulk
//    backfill of historical recoupments (2026-07-20: Moulin Rouge 2022-11,
//    & Juliet 2024-04, Oh Mary 2024-11, EBT 2026-05 all stamped firstAdded
//    that day) surfaced years-old news as "this week" (owner, 2026-07-26).
//
// 2. Once-only: firstAdded falls inside the issue week window, so a genuinely
//    fresh recoupment appears in exactly one issue (the Giant 8+-repeats fix).
//    Legacy entries without firstAdded pass on condition 1 alone — pre-2026
//    records lack the timestamp, and condition 1 already bounds them to the
//    announcement month.
function isFreshRecoupmentNews(entry, weekStartStr, weekEndStr) {
  if (!entry || !entry.recouped || !entry.recoupedDate) return false;
  if (!/^\d{4}-\d{2}$/.test(entry.recoupedDate)) return false;
  const weekMonths = [String(weekStartStr).slice(0, 7), String(weekEndStr).slice(0, 7)];
  if (!weekMonths.includes(entry.recoupedDate)) return false;
  if (entry.firstAdded) {
    const day = String(entry.firstAdded).slice(0, 10);
    if (day < weekStartStr || day > weekEndStr) return false;
  }
  return true;
}

module.exports = { isFreshRecoupmentNews };
