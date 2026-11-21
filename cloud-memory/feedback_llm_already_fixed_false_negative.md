---
name: feedback_llm_already_fixed_false_negative
description: "Claude falsely reports \"fix already implemented\" when given a file where only the prop is threaded, not the actual guard"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb2f6cad-5470-4818-b20f-fe0378fd797f
---

When Claude is given a file in the second-pass (file-read) prompt for auto-fix-friction-card.js, it may return canFix:false with reason "fix already present" even when the fix is NOT there.

**Observed case (2026-06-16):** TicketLink.tsx had `showStatus` accepted as a prop and passed through to analytics events. Claude saw this and concluded the closed-show guard (`if (showStatus === 'closed') return null`) was "already implemented at line ~130." It was not — only the prop threading existed.

**Why:** Claude conflates "the prop exists and is used" with "the feature is implemented." Passing `show_status` to PostHog is not the same as guarding the render.

**How to apply:** When the auto-fixer skips a card with "already implemented" reasoning, independently verify by grepping the target file for the actual guard string before accepting the skip. In production, monitor the first few CI runs of posthog-monday.yml friction-fixer job — if legitimate cards are being wrongly skipped at a rate >1 per run, tighten the prompt to include: "IMPORTANT: Passing a prop through to analytics tracking is NOT the same as implementing a guard. Only report canFix:false for 'already fixed' if the exact functional behavior described in the card is present."
