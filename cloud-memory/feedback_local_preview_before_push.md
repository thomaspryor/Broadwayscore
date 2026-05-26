---
name: local-preview-before-push
description: "For ANY UI change in Broadway Scorecard, run /visual-qa locally + share element-cropped screenshots with the user + wait for \"APPROVED: <verdictHash>\" reply BEFORE any push. The Stop hook (verify-edits.sh is_ui_edit branch) blocks visual-correctness claims without a fresh verdict; the pre-push hook (pre-push-visual-gate.sh) blocks `git push`/`gh pr merge` without an APPROVED hash. Hash-bound approval prevents stale \"looks good\" from unlocking unrelated future pushes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2fb98a03-86db-4013-a4fc-697f6958e83d
---

**Rule:** Any change touching `src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`, or `src/app/**` requires:
1. Run `node scripts/visual-qa.mjs --url http://localhost:3000 --paths <routes> --elements "<css-sel>" --refs <design-if-user-provided> [--ref-roles goal|before]`.
2. **Read every element crop the runner prints at FULL resolution** — not the full-page thumbnails. Reading thumbnails is the documented silent-PASS root cause.
3. Paste the manifest (screenshots + overflow report + LLM verdicts + contentHash) into your reply to the user.
4. Wait for explicit `APPROVED: <contentHash>` before any `git push` / `gh pr merge` / wrapped push script. The hook records the approval in a local ledger (`.claude/visual-qa/approvals.jsonl`, gitignored, 7-day TTL) so a later merge of the same commit into main is auto-allowed.

**v2 mechanic (2026-05-26):** four pain points fixed after /plan-review consensus —
- **Hash treadmill:** `contentHash` is content-equivalent (paths, widths, refsDigest, refRoles, geometry, screenshot/ref bytes, headSha, LLM verdicts, overallPass). Re-runs on identical pixels yield the same hash — text-only commits keep prior APPROVED valid. Lives in `scripts/lib/verdict-hash.mjs`; tests in `verdict-hash.test.mjs`.
- **Refs-direction false-fail:** new `--ref-roles goal|before` flag. `goal` (default) = impl must match the reference. `before` = impl must DIFFER from the reference (the diff is the user's requested change, not a regression). When the user attaches a screenshot and asks for a change, that attachment is a `before` ref — ask the user once if unclear.
- **NO-VERIFY in-flight:** the pre-push hook now reads NO-VERIFY from the assistant's IN-FLIGHT turn (the same message that contains the gated `git push` Bash call), not the prior turn. Powered by `messageId` grouping in `walkTranscript` and `--tool-use-id` arg on `queryVisualClaimLanguage`. Stale NO-VERIFY from earlier turns no longer bypasses.
- **Main-push re-block:** the local approval ledger walks `git log origin/main..HEAD`; if every UI-touching commit (or merge parent) carries a fresh ledger entry, the push is allowed without re-running /visual-qa. No git-notes, no remote state, no leakage to public repos.

**Stop hook tightening (2026-05-26):** `is_ui_edit` in `verify-edits.sh` now inspects the EDIT diff and ONLY fires when the change touches visual surface (className/style/CSS/JSX). String-array data edits, type-only changes, and import reorders no longer trigger the gate. A per-commit memo (`.claude/visual-qa/last-satisfied-sha`) skips delayed-echo re-fires when HEAD hasn't moved since the last satisfied check.

**Schema version bump:** v1 verdicts are rejected by both hooks with a "re-run /visual-qa" message. Existing branches need one fresh run after this lands.

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
  - `APPROVED: <verdictHash>` — hash-bound, single-use; stale tokens (mid-session "looks good" about an unrelated change) DON'T unlock the next push
  - `ship immediately for: <reason>` — one-shot override; consume marker at `/tmp/visual-qa-override-consumed-<session-id>` prevents re-use within the session
  - `NO-VERIFY: <reason>` — bypass any visual gate; user reads the message and reviews
- Kill switch: `VISUAL_QA_DISABLE=1` env. Disables the visual layer only; existing UNVERIFIED gate still applies to .tsx files.
- Cloud sessions: NO-VERIFY is the documented escape. Cloud sandboxes can't run Playwright, so the rule there is "don't ship UI changes from cloud."

**See also:** `.claude/skills/visual-qa/skill.md` (runbook), `scripts/visual-qa.mjs` (runner), `scripts/lib/transcript-scan.mjs` (helper), `sprint-plan-visual-qa-gate.md` (full design). Two-model rationale: [[feedback_two_model_ui_review]]. Tailwind JIT restart trap that screenshots-of-zero-px caught in the past: [[feedback_tailwind_jit_arbitrary_restart]].
