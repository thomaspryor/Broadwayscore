---
name: Verify Notion card creation succeeded
description: notion-brain.js create can silently fail validation (exit 2) — always check full output, never pipe through grep
type: feedback
originSessionId: c0c2e372-eda9-4638-8608-ef04c7db6a63
---
Always check the FULL output of `notion-brain.js create` — never pipe through `grep` or `tail`.

The script has validation hooks (INCOMPLETE_HANDOFF, EMPTY_NOTES) that reject cards with exit code 2 and a clear error message. But if you pipe the output (e.g., `| grep url`), the error is swallowed and the card silently doesn't get created.

**Why:** A Cats investigation session ran `notion-brain.js create ... 2>&1 | grep url` — the validation rejected the card for missing "Suggested approach", but grep found nothing and the session assumed success. The card was lost.

**How to apply:** After every `notion-brain.js create`, verify the output includes `"url":`. If it shows `❌ REJECTED`, fix the notes and retry. Never filter the output.
