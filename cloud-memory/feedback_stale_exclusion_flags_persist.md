---
name: Stale exclusion flags from removed code persist on disk
description: When you remove a flag-setter code path, files set by old code keep the flag. Sweep + defensive gate override.
type: feedback
originSessionId: e29ab79b-3895-44e3-9331-3255dec6b39b
archived: true
---
When a code path that auto-sets exclusion flags (`isRoundupArticle`,
`wrongProduction`, `isNonReview`, etc.) on review-text files is later removed
or tightened, the flags persist on existing files. Future scoring + rebuild
can't tell "set by removed code" from "set by current code" — they just see
the flag and exclude.

**Real incidents:**
- `isRoundupUrl` once matched generic `/review-roundup/` URL patterns. Removed
  2026-04-01 in d7bf1603b8. By 2026-04-25, 175 files still carried the flag,
  39 of them clearly individual reviews.
- gather-reviews `KNOWN_ROUNDUP_OUTLETS` auto-tagged every file from
  the-clyde-fitch-report and the-interested-bystander, even individual blog
  posts on the outlets' own per-post URLs. Stuart King's John Proctor LBO
  review (3953-char fullText, individual URL) was silently dropped from
  scoring on every rebuild.

**Why:** A removed line of code is invisible at audit time. The data it wrote
is durable. `git blame` on the file shows nothing about why a flag is wrong.

**How to apply:**
- When removing/tightening a flag-setter, write a one-time sweep that clears
  the flag on files that no longer match the new criteria. Don't rely on
  "future scrapes will overwrite" — most files are never re-scraped.
- Add a defensive override at every gate site that reads the flag, with a
  whitelist-based predicate (`isLikelyStaleRoundupFlag`-style: substantial
  fullText + isFullReview + per-outlet individual-review URL pattern). The
  sweep + the gate override are belt-and-suspenders; both are needed because
  CI can re-set the flag on next gather/scrape if the producing code is still
  too eager.
- Whitelist-based, not blacklist-based: NYT/Playbill have multi-show roundup
  URLs that don't match `isRoundupUrl`; clearing on "URL is not on the
  roundup list" leaks roundup-as-review files into scoring. Per-outlet
  individual-post URL pattern (`clydefitchreport.com/YYYY/MM/{slug}/` etc.)
  is much safer.
- Update `scoring-delta.js` `guardsIdentical` check to include the new
  helper — otherwise Phase A skips replay even when your changes affect
  exclusion (memory `feedback_scoring_delta_blind_to_future_logic.md`).

See: scripts/lib/review-guards.js `isLikelyStaleRoundupFlag`,
scripts/clear-stale-roundup-flags.js, Notion 34e637c5-416f-817b.
