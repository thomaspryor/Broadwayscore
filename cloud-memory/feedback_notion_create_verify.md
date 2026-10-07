---
name: Verify Notion/Linear card creation succeeded (and never blind-retry create)
description: notion-brain.js create can silently fail validation (exit 2) — always check full output, never pipe through grep. linear-brain.js create's "card was still saved" validation warning means the card EXISTS — re-running create makes a duplicate, not a fix.
type: feedback
originSessionId: c0c2e372-eda9-4638-8608-ef04c7db6a63
modified: 2026-09-16T04:11:02.032Z
---
Always check the FULL output of `notion-brain.js create` — never pipe through `grep` or `tail`.

The script has validation hooks (INCOMPLETE_HANDOFF, EMPTY_NOTES) that reject cards with exit code 2 and a clear error message. But if you pipe the output (e.g., `| grep url`), the error is swallowed and the card silently doesn't get created.

**Why:** A Cats investigation session ran `notion-brain.js create ... 2>&1 | grep url` — the validation rejected the card for missing "Suggested approach", but grep found nothing and the session assumed success. The card was lost.

**How to apply:** After every `notion-brain.js create`, verify the output includes `"url":`. If it shows `❌ REJECTED`, fix the notes and retry. Never filter the output.

**Linear (`linear-brain.js create`) — opposite failure mode (2026-09-16, BRO-3535 session):** when the ratchet fires (e.g. "card has no acceptance-criteria section or VERIFY line"), the output explicitly says "The card was still saved." That means the card EXISTS in Linear already — the fix is `linear-brain.js update <BRO-N>` to add the missing VERIFY line, never re-running `create` with the same title. Re-running `create` mints a genuine duplicate issue (confirmed: a session did this, got BRO-3542 as a duplicate of BRO-3541, and had to manually mark it `--duplicate-of` + state Duplicate to clean up). **How to apply:** on any `linear-brain.js create` non-zero-exit or validation-warning output, run `linear-brain.js find "<title>"` first to check whether the card already landed before creating again.
