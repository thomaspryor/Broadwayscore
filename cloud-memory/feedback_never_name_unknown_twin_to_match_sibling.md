---
name: feedback_never_name_unknown_twin_to_match_sibling
description: Never set an outlet--unknown.json criticName to match a same-URL sibling — the rebuild rename/dedup deletes the scored twin and drops the review
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 71eaba5c-b9bb-4562-beba-3e630b35852a
---

Setting a review-text file's `criticName` to a value that a **same-canonical-URL sibling** (same show+outlet) already carries turns the pair into a same-name + same-URL duplicate. The rebuild's rename/dedup helper then **DELETES one of the two files**, and when the survivor is the flagged twin (wrongProduction / contentTier=invalid), the scored review is **dropped entirely** from reviews.json — not just re-bylined.

**Incident (2026-07-14, card #27):** a byline-recovery pass copied the extracted name from `outlet--<critic>.json` onto its scored `outlet--unknown.json` twin to fix "Unknown" bylines. The rebuild deleted the scored `--unknown.json` twins; 34 shows lost their scored review (giant-2026/wsj lost Charles Isherwood). Caught by the /wrap-up async-gate prod check, then fully reverted from the pre-session baseline commit and rebuilt. `scripts/recover-unknown-bylines.js --apply` is hard-disabled.

**Why:** the deletion is irreversible via a `criticName` reset — once the scored `--unknown.json` is gone, restoring it needs `git checkout <pre-change-commit> -- <file>`, not a field edit.

**How to apply:** to attach a byline to a scored `outlet--unknown.json`, do NOT rename/re-critic it to match a sibling. Either (a) clear the false wrongProduction/invalid flag on the correctly-bylined sibling so IT becomes the scored copy, or (b) fix the rebuild's same-(outlet,canonicalUrl) dedup to prefer a real name AND keep the *scoreable* member. Redesign carded (Notion 39e637c5-416f-81bc). Related: [[feedback_safewrite_temporal_guard_needs_date]], [[feedback_outlet_merge_no_flag_and_keep]].
