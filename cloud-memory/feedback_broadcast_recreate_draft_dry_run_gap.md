---
name: send-opening-night-broadcast --dry-run does NOT gate --recreate-draft
description: RECREATE_DRAFT DELETE runs before DRY_RUN early-exit; --dry-run --recreate-draft actually deletes the live Resend draft
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
In `scripts/send-opening-night-broadcast.js`, the `RECREATE_DRAFT` code block (DELETE call to Resend `/broadcasts/{id}`) runs BEFORE the `if (DRY_RUN) return` early-exit. Passing `--dry-run --recreate-draft` together will delete the existing Resend draft even though no new draft is created.

**Why:** Discovered 2026-04-21 during Schmigadoon 2026 broadcast refresh. Ran `--dry-run --recreate-draft` intending to preview the payload; the old draft (e21374b5) was deleted immediately with no confirmation. Recovered by running again without `--dry-run` to create a fresh draft. No email sent, but the dry-run flag implies "read-only" and it isn't.

**How to apply:**
- Treat `--recreate-draft` as write-path regardless of `--dry-run`. If you want to preview payload without touching Resend, use `--send-to=your@email.com` (transactional) or just read the script's computed JSON from stdout without any Resend flag.
- Fix: move the RECREATE_DRAFT DELETE block *after* the `if (DRY_RUN)` gate, OR add `if (DRY_RUN && RECREATE_DRAFT) { console.log('Would delete draft X'); process.exit(0); }` as an early guard.
- This is separate from the sync-to-origin gap (Notion card 349637c5-416f-81a5-bdb2-f0f379645e7d) — both live in the same script and should be fixed together.
