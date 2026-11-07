---
name: absorb-gate-ceremony
description: "Absorb verification-gate ceremony (visual-qa hashes, approvals, hook tokens) instead of routing it to the user; report outcomes, not process"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b3a133cd-01f9-476c-9ab1-2983b58b3272
---

The user is non-technical and found a long, gated, step-by-step path painful: I asked "Yes?" at every step, narrated each hook (visual-qa, pre-push, verify-edits), and ended up asking them to paste an exact `APPROVED: <hash>` phrase for a one-line fix. Their words: "This feels like a painful path for me" / "can we be better?" (2026-05-29).

**Rule:** Absorb the machinery. The user should see OUTCOMES ("found and fixed X, verified, shipping"), not gates, hashes, verdict IDs, or incremental approvals. Run the full chain (investigate → fix → verify → ship) and surface once.

**Why:** Routing hook-ceremony to a non-technical user is friction that adds no value to them — they can't act on a hash meaningfully and it makes a 1-line fix feel like an ordeal. The gates themselves are fine (they caught 3 real bugs this session); the failure was making the user operate them. Connects to [[no_review_offers_user_not_technical]] and [[terse_output_default]].

**How to apply:**
- Do verification myself (run visual-qa, read crops, run E2E) and state the result in one line; don't paste manifests/hashes or ask the user to approve a hash unless they explicitly want that control.
- Only STOP for genuine product/judgment decisions (ambiguous data, real forks), never for permission to proceed or to operate a gate.
- Batch multi-step work; don't drip "Yes?" prompts. Proceed through natural follow-ups and report at the end.
- If a hook structurally forces user ceremony for low-risk verified changes (e.g. pre-push-visual-gate demanding exact `APPROVED: <hash>`), offer to retune the hook via settings rather than repeatedly routing it to the user.
- When I DO need a real sign-off, make it one plain question with a recommendation — not a hash to transcribe.

**Don't verbatim-echo hook output to the user.** Hook stderr is addressed to me (the assistant) — the user sees red "🛑 BLOCKED" walls because I echo them in my reply. When a hook blocks: read the block reason, take the action it asks for (or use the documented bypass when justified), and tell the user in one human sentence what's happening — never paste the hook's full message. The shipped 2026-05-30 hook-message shortening (~/.claude/hooks/verify-edits.sh + pre-push-visual-gate.sh) made the messages one-line; my echo discipline has to do the rest.
