// NYC anchored-bands + V6 decompression rollout config (Linear BRO-24).
//
// Broadway + off-broadway markets on the V6 anchored-bands scoring path
// (see src/config/scoring.ts::ANCHORED_MARKETS and
// scripts/lib/star-reliability.js::shouldUseAnchoredMode for the read/write
// gates that consume this set). WE + Off-West-End were the earlier pilot
// markets and stay defined inline in scoring.ts.
//
// Rollout history (Notion cards 39a637c5416f8137a105f2c88ea166ee +
// 3a4637c5-416f-81fc-a0ef-edd95c4890a1, both Done):
//   2026-07-20: config shipped, 16,462 reviews flagged for rescore
//               (late-star-anchor + bw-v6-decompression drains).
//   2026-08-18: drain confirmed empty (needsRescore total = 0 across the
//               live corpus); rebuild + prod deploy happened automatically
//               on the standing cron, no manual trigger needed.
//
// Actual measured outcome (not the pre-rollout simulation): open-NYC mean
// composite delta +0.30 (simulation predicted +1.6). Hamilton 91 -> 91 —
// the ceiling fix did not move it, because a tier-weighted mean over 40+
// critics dilutes a single-show top-end change. Owner decision 2026-07-26
// (reconfirmed 2026-08-13): scores moved too little to justify a public
// explainer, so none was published — see
// ~/Documents/claude-outputs/nyc-rollout-explainer-draft-2026-07-26.md for
// the internal reference note with full numbers.
export const ANCHORED_MARKETS_NYC_V6: ReadonlySet<string> = new Set([
  'broadway',
  'off-broadway',
]);
