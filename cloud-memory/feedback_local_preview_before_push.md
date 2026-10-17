---
name: local-preview-before-push
description: "For ANY UI change in Broadway Scorecard, run /visual-qa locally + share element-cropped screenshots with the user + wait for a plain affirmative reply (yes/ship it/looks good) BEFORE any push. NEVER ask the user to copy a verdict hash — that friction was removed 2026-05-29. The Stop hook (verify-edits.sh is_ui_edit branch) blocks visual-correctness claims without a fresh verdict; the pre-push hook (pre-push-visual-gate.sh) blocks `git push`/`gh pr merge` until the last user message is a clean approval."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2fb98a03-86db-4013-a4fc-697f6958e83d
---

**Rule:** Any change touching `src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`, or `src/app/**` requires:
1. Run `node scripts/visual-qa.mjs --url http://localhost:3000 --paths <routes> --elements "<css-sel>" --refs <design-if-user-provided>`.
2. **Read every element crop the runner prints at FULL resolution** — not the full-page thumbnails. Reading thumbnails is the documented silent-PASS root cause.
3. Paste the manifest (screenshots + overflow report + LLM verdicts + verdictHash) into your reply to the user.
4. Wait for explicit `APPROVED: <verdictHash>` (hash-bound, single-use) before any `git push` / `gh pr merge` / wrapped push script.

**Why (FeaturedSpot incident, 2026-05-24):** A session was given two reference designs for a Tony Predictions card, ran for 8 minutes, declared "Live on production. ...gold split-card on desktop/tablet, compact stacked layout on mobile" — but the shipped version had:
- "ACCURACY" instead of the design's "HISTORICAL ACCURACY" (clipped to "HISTORICAL ACCURA" at narrow widths)
- lowercase "seasons / calls right" instead of design's UPPERCASE tracked "SEASONS / CALLS RIGHT"
- reduced gold glow on the pill
The agent never showed the user a screenshot. CLAUDE.md §5 already mandated 3-viewport screenshots but enforcement was advisory; sessions skipped it. The post-mortem also identified that even when screenshots WERE taken, agents read full-page PNGs at thumbnail size (where a gold pill is just a gold blob — clipping invisible) and inferred "looks correct" from element presence rather than legibility.

**How to apply:**
- The Stop hook (`.claude/hooks/verify-edits.sh` `is_ui_edit` branch) fires on `UNVERIFIED_VISUAL`, `UNVERIFIED_VISUAL_CLAIM`, or `UNVERIFIED_VISUAL_REF` when:
  - A UI file was edited AND no fresh `.claude/visual-qa/<branch>/verdict.json` exists, OR
  - Last assistant text uses claim language ("live on production", "looks correct", "matches the design", "ready to ship", etc.) without `NO-VERIFY:` in the same block, OR
  - A user message attached a design image AND the verdict.json has `verdicts: null` (no LLM diff was run)
- The pre-push hook (`.claude/hooks/pre-push-visual-gate.sh`) fires when `git diff origin/main...HEAD` has UI files AND the last user message lacks `APPROVED: <verdictHash>`.
- Approval mechanic:
  - **Plain affirmative is the norm (since 2026-05-29):** "yes" / "ship it" / "looks good" / "lgtm" / "go ahead" / "approved" in the user's most recent message unlocks the push (`PLAIN_APPROVAL_RE` in `transcript-scan.mjs`). Fails safe on negation/conditionals ("looks good but fix X", "yes, wait"). **NEVER ask the user to type or copy the verdict hash** — that friction was deliberately removed; reintroducing it in your phrasing is the regression. Keep the hash out of your reply. (User called the hash ceremony "annoying and unnecessary... not at all friendly" on 2026-06-01 after a session kept parroting `APPROVED: <hash>` though the hook no longer needed it. Root cause was the skill doc still instructing it; fixed 2026-06-01.)
  - `APPROVED: <verdictHash>` — still honored for back-compat, strict per-hash, but DON'T request it. `isPlainApproval` returns false when the message contains the explicit hash form, preserving per-hash scoping.
  - `ship immediately for: <reason>` — one-shot override; consume marker at `/tmp/visual-qa-override-consumed-<session-id>` prevents re-use within the session
  - `NO-VERIFY: <reason>` — bypass any visual gate; user reads the message and reviews
- Kill switch: `VISUAL_QA_DISABLE=1` env. Disables the visual layer only; existing UNVERIFIED gate still applies to .tsx files.
- Cloud sessions: NO-VERIFY is the documented escape. Cloud sandboxes can't run Playwright, so the rule there is "don't ship UI changes from cloud."

**See also:** `.claude/skills/visual-qa/skill.md` (runbook), `scripts/visual-qa.mjs` (runner), `scripts/lib/transcript-scan.mjs` (helper), `sprint-plan-visual-qa-gate.md` (full design). Two-model rationale: [[feedback_two_model_ui_review]]. Tailwind JIT restart trap that screenshots-of-zero-px caught in the past: [[feedback_tailwind_jit_arbitrary_restart]].
