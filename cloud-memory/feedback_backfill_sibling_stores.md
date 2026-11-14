---
name: Backfill must rename in every sibling store + reference holder
description: Renaming a review-text file forces parallel updates in data/llm-scores/, duplicateTextOf pointers, BOTH repos (broadway-review-texts + data/review-texts), and any audit snapshots that grep by filename.
type: feedback
originSessionId: 025760e3-f28f-4371-ba24-b9ce9d7bf038
archived: true
---
When renaming a review-text file (e.g., `outlet--critic.json` → `outlet--corrected-critic.json`), the rename has to land in every store that holds the slug. Backfill scripts that only touch the source file leak inconsistencies that surface days later.

**Why:** Caught 2026-04-26 during ship-check on the BWW parser fix (Notion card 34e637c5-416f-8108-b2c5-c83aed57264a). I renamed 5 files in `~/broadway-review-texts/` but missed:
- `duplicateTextOf` references in 2 sibling files (`--the-globe-and-mail.json` outlet-fallback files pointed at the old slug — surfaced by `validate-data.js`).
- `data/llm-scores/the-prom-2018/the-globe-and-mail--kelly-nestruck.json` (separate per-show LLM score store, surfaced by Claude QA subagent).
- The local `data/review-texts/` copy in the main repo (separate git repo from `~/broadway-review-texts/`; CI's `checkout-review-texts` action would have synced eventually but local validators read the stale copy).

**How to apply:** Before running any review-text rename backfill:
1. `grep -rln "OLD_SLUG" data/ ~/broadway-review-texts/` to inventory every reference.
2. Specifically check: `data/llm-scores/<showId>/`, `duplicateTextOf` JSON fields, `data/audit/duplicate-review-files.json`, any per-show audit snapshots.
3. Apply renames in BOTH repos: `~/broadway-review-texts/` (canonical) AND `data/review-texts/` (local working copy in main repo).
4. After rename, re-grep for the OLD slug — if any hits remain in non-historical files, fix before ending the session.
5. Run `validate-data.js` and grep its output for the renamed slug — broken `duplicateTextOf` shows up as `points to non-existent file`.

The general lesson: **a slug is not a filename — it's an identity referenced by multiple stores.** Renaming the file alone is half the fix.
