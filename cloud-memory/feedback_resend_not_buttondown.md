---
name: Resend is the only active broadcast path; Buttondown is dead code
description: "All real broadcasts manually created in Resend by Tom; Buttondown is dead code."
type: feedback
archived: true
---

**THE ACTUAL FLOW (as of 2026-04-10):**

1. `opening-night-broadcast.yml` runs `send-opening-night-broadcast.js --send-to=$OWNER_EMAIL` → script sends a single transactional **preview email** to Tom's Gmail via Resend's `/emails` endpoint. That's the ONLY thing that fires automatically.
2. Tom reviews the preview in his Gmail inbox.
3. Tom **manually** creates the broadcast in the Resend dashboard (or via the Resend `/broadcasts` API), selects the General audience, and clicks Send himself. This step is NOT automated — it's a deliberate human-in-the-loop decision after a previous auto-send incident.

**The Buttondown else-branch in `send-opening-night-broadcast.js` is DEAD CODE.** It builds drafts against `api.buttondown.com` but nothing ever triggers the non-preview path in practice — every automated run uses `--send-to=$OWNER_EMAIL`. Buttondown is a pending migration target that has NOT been activated. Tom has said explicitly: "We don't use Buttondown yet! It's a pending migration. Still on Resend."

**Why:** Auto-send to subscribers caused incidents in the past (see `memory/email-broadcast-rules.md`). The current design is intentional: code only ever generates previews, Tom decides to send.

**How to apply:**
- When describing the broadcast flow, NEVER say "the script creates a Buttondown draft that's the real broadcast." It doesn't. Buttondown is not hooked up to an audience and nothing sends from it.
- When describing what automation does: "sends a preview email to Tom via Resend, full stop." The actual subscriber send is manual.
- When modifying the script: the only path that matters in practice is the `if (SEND_TO)` branch (preview via Resend transactional). The `else` branch (Buttondown) can be treated as unreachable but — per `feedback_broadcast_quality_bar.md` — don't rip it out without explicit approval. It's kept for the pending migration.
- When Tom says "I sent the broadcast," he means he clicked Send in the Resend dashboard, not that CI did it.
- Never call Resend's `/broadcasts/{id}/send` endpoint from a script. That's also a hard rule in `memory/email-broadcast-rules.md`.
