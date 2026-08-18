---
name: feedback_notion_verify_before_destructive_update
description: "Before any notion-brain.js update --status Done (or any destructive field overwrite), get the page id first and check the name matches — a single mistyped hex digit in the 32-char UUID silently targets a different card"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fe94a732-d04e-4fb7-8c38-3fcaa42578f6
  modified: 2026-08-18T21:20:56.608Z
---

On task #1790 (2026-08-18), I typed a Notion page id from memory (`3c0637c5-416f-8167-a96a-ddfbc3ac4e54`) instead of copying the exact id from the dispatch prompt's URL (`3c0637c5-416f-81f6-83f5-c6b76acb520f`) — a single 4-hex-char group differed. The mistyped id happened to be a real, unrelated P1 card ("push-with-retry.sh defaults to pushing stale local 'main'..."), so `notion-brain.js update <id> --status Done --outcome "..." --key-files "..."` succeeded silently against the wrong card: it flipped that card's Status to Done and its Key Files to my (wrong) value, and prepended my Outcome text ahead of whatever was already there.

**Why this is worse than it sounds:** `--status` and `--key-files` and `--completed-date` overwrite directly (no prepend, no undo). `--completed-date` in particular has no clear/unset path via this CLI at all — recovering it requires the Notion UI. `--outcome` prepends by default, so original content usually survives underneath, but only if the field wasn't empty to begin with (no way to tell without checking page history).

**How to apply:** Before any `notion-brain.js update <id> --status Done` (or any other field that overwrites rather than prepends), run `notion-brain.js get <id>` first in the same turn and read the `name` field back — confirm it matches the card you intend to close. This is cheap (one extra call) and catches exactly this class of typo before it writes. Doubly important when the id was typed/recalled rather than pasted verbatim from a URL or a prior tool result.

**If it happens anyway:** revert `--status` to its most likely prior value, use `--overwrite-outcome` to replace the wrong text with a clear correction note (don't leave it as your own erroneous content), and flag the `completedDate` field as needing manual UI cleanup since the CLI can't clear it. Then tell the user plainly — don't bury it in a wrap-up bullet.
