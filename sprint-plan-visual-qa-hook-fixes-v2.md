# Sprint Plan: Visual-QA Hook Fixes v2

## Overview
Fix the four pain points in the visual-QA pre-push gate (re-run treadmill, refs-direction false-fail, NO-VERIFY in-flight gap, main-push re-block) plus fold in `verify-edits.sh` `is_ui_edit` over-triggering. Driven by /plan-review consensus (6 reviewers); see prior conversation for full critique.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 0      | Foundation: extract hash to lib + schema version | 3 | 3S |
| 1      | Hash semantics + Stop-hook unification + is_ui_edit tightening | 10 | 7S, 3M |
| 2      | Local approval ledger replaces git-notes idea | 5 | 4S, 1M |
| 3      | In-flight transcript scan for NO-VERIFY | 5 | 3S, 2M |
| 4      | Per-ref roles (goal vs before) | 4 | 4S |
| 5      | Docs + memory + end-to-end manual test | 3 | 3S |

## Sprint 0: Foundation (lib extraction + schema versioning)
**Goal:** verdict-hash logic lives in testable lib; both hooks reject pre-v2 verdicts cleanly.
**Risks:** breaking existing verdict.json consumers in cloud-memory feedback.
**MODEL:** Sonnet

### S0-T1: Extract computeContentHash to scripts/lib/verdict-hash.mjs
- Complexity: S
- Files: scripts/lib/verdict-hash.mjs (new), scripts/visual-qa.mjs (modify)
- VERIFY: `grep "import.*verdict-hash" scripts/visual-qa.mjs` returns a line; running `/visual-qa` still writes a verdict.json identical to before (no behaviour change yet).

### S0-T2: Add verdictSchemaVersion=2 and hook rejection of v1
- Complexity: S
- Files: scripts/visual-qa.mjs, .claude/hooks/pre-push-visual-gate.sh, .claude/hooks/verify-edits.sh
- VERIFY: Manually create `.claude/visual-qa/test/verdict.json` with no schema version; run hook with synthetic push command; expect BLOCKED + "re-run /visual-qa" message.

### S0-T3: Unit tests in scripts/lib/verdict-hash.test.mjs
- Complexity: S
- Files: scripts/lib/verdict-hash.test.mjs (new), test.yml (register if not auto-picked-up)
- VERIFY: `node --test scripts/lib/verdict-hash.test.mjs` exits 0 with ≥3 test cases (same pixels = same hash, different geometry = different hash, missing fields = throw).

---

## Sprint 1: Pain #1 (hash semantics) + Stop-hook unification + is_ui_edit tightening
**Goal:** Same pixels across re-runs → same contentHash → existing APPROVED keeps working; Stop hook agrees with push hook; `verify-edits.sh` stops false-positive-firing on string-array edits.
**Risks:** Stop hook coupling; non-deterministic PNG bytes on macOS.
**MODEL:** Opus (semantic change, multi-file touch)

### S1-T1: Drop `timestamp` from hash inputs
- Complexity: S
- Files: scripts/lib/verdict-hash.mjs
- VERIFY: Re-run `/visual-qa` twice on same pixels → identical contentHash. Measured churn drop logged.

### S1-T2: Add element-geometry digest (selector/width/height/x/y, no file paths or text)
- Complexity: S
- Files: scripts/lib/verdict-hash.mjs, scripts/visual-qa.mjs (capture geometry in elementCrops)
- VERIFY: Synthetic test: change one element's height in fixture → hash rotates.

### S1-T3: Hash `refs` by sha256(refBytes), not path
- Complexity: S
- Files: scripts/lib/verdict-hash.mjs
- VERIFY: Synthetic: two identical PNGs with different clipboard names → identical hash.

### S1-T4: Exclude `textPreview` from overflowReport in hash (keep on disk for debug)
- Complexity: S
- Files: scripts/lib/verdict-hash.mjs
- VERIFY: Synthetic: same overflow with different textPreview → identical hash.

### S1-T5: Bind hash to `git rev-parse HEAD` at screenshot time
- Complexity: S
- Files: scripts/visual-qa.mjs, scripts/lib/verdict-hash.mjs
- VERIFY: Verdict.json includes new `headSha` field; hash includes it.

### S1-T6: Rename `verdictHash` → `contentHash`; keep `runId` (uuid) and `timestamp` separate
- Complexity: M
- Files: scripts/visual-qa.mjs, .claude/hooks/pre-push-visual-gate.sh, scripts/lib/transcript-scan.mjs (approvalRe), scripts/lib/verdict-hash.mjs
- VERIFY: Push hook reads `contentHash`; transcript scan reads `APPROVED: <contentHash>`; existing transcript-scan tests still pass.

### S1-T7: Patch verify-edits.sh — use contentHash freshness + import VISUAL_CLAIM_RE
- Complexity: M
- Files: .claude/hooks/verify-edits.sh, scripts/lib/transcript-scan.mjs (export VISUAL_CLAIM_RE)
- VERIFY: Stop hook no longer fires when a verdict.json exists with current HEAD's contentHash; manual UI edit + fresh /visual-qa cycle → Stop hook silent.

### S1-T8: Skip verdict.json rewrite if computed contentHash matches existing file
- Complexity: S
- Files: scripts/visual-qa.mjs
- VERIFY: Two consecutive `/visual-qa` runs on identical pixels — mtime of verdict.json is preserved between runs.

### S1-T9: Tighten `is_ui_edit` — content-aware diff inspection
- Complexity: M
- Files: .claude/hooks/verify-edits.sh
- VERIFY: Add string to an existing array in BeatTheCriticsClient.tsx → Stop hook does NOT fire. Change a className value → Stop hook DOES fire.

### S1-T10: Per-commit memo — skip `verify-edits.sh` if HEAD hasn't moved since last satisfied check
- Complexity: S
- Files: .claude/hooks/verify-edits.sh, .claude/visual-qa/last-satisfied-sha (new gitignored marker file)
- VERIFY: Trigger Stop hook once, satisfy it; trigger another Stop event on unchanged HEAD → no fire.

---

## Sprint 2: Local approval ledger (Pain #4)
**Goal:** Merge-to-main inherits approval from worktree-branch's approved commits; zero git-notes; zero remote state.
**Risks:** ledger format drift; new clone has no ledger.
**MODEL:** Sonnet

### S2-T1: Define ledger format + write on APPROVED detection
- Complexity: S
- Files: .claude/hooks/pre-push-visual-gate.sh, scripts/lib/visual-qa-ledger.mjs (new)
- VERIFY: Approve a push → `.claude/visual-qa/approvals.jsonl` has new line with `{ts, sessionId, branch, commitSha, contentHash}`.

### S2-T2: Hook walks `git log origin/main..HEAD` and consults ledger
- Complexity: M
- Files: .claude/hooks/pre-push-visual-gate.sh, scripts/lib/visual-qa-ledger.mjs
- VERIFY: Worktree branch with approved commits → merge to main → `git push origin main` allowed without re-running /visual-qa.

### S2-T3: Merge-commit inheritance (all non-merge parents must carry ledger entry)
- Complexity: S
- Files: scripts/lib/visual-qa-ledger.mjs
- VERIFY: Synthetic merge commit with one parent approved + one not → push BLOCKED.

### S2-T4: 7-day TTL on ledger entries
- Complexity: S
- Files: scripts/lib/visual-qa-ledger.mjs
- VERIFY: Synthetic entry with ts 8 days ago → walker treats commit as un-approved.

### S2-T5: Clear failure messages distinguishing "no ledger entry" vs "ledger says different hash"
- Complexity: S
- Files: .claude/hooks/pre-push-visual-gate.sh
- VERIFY: Manually clear ledger → push fails with explicit "no ledger entries found — re-run /visual-qa" message.

---

## Sprint 3: In-flight transcript scan (Pain #3)
**Goal:** Fix the actual bug — NO-VERIFY in current assistant turn works; no env-var bypass channel; no soft-approve.
**Risks:** transcript message-id grouping may not be reliable.
**MODEL:** Opus (transcript-walker mechanic is subtle)

### S3-T1: Extend walkTranscript to track message_id / parent assistant turn for each event
- Complexity: M
- Files: scripts/lib/transcript-scan.mjs
- VERIFY: New unit test: events from same JSONL line share a `messageId` field; tool_use events know their parent text block.

### S3-T2: queryVisualClaimLanguage accepts --tool-use-id and walks back from there
- Complexity: M
- Files: scripts/lib/transcript-scan.mjs
- VERIFY: Test fixture with prior turn's NO-VERIFY but current turn's bash call → reports hasNoVerify=false. Same fixture with NO-VERIFY in same turn as bash call → hasNoVerify=true.

### S3-T3: Hook passes tool_use_id to the query
- Complexity: S
- Files: .claude/hooks/pre-push-visual-gate.sh
- VERIFY: Real session reproduction — emit NO-VERIFY + git push in same message → push allowed.

### S3-T4: Delete soft-approve / env-var bypass / no-verify.log scaffolding (none exists yet; ensure none added)
- Complexity: S
- Files: (none — verification task)
- VERIFY: `grep -r VISUAL_QA_NO_VERIFY scripts/ .claude/hooks/` returns 0 hits; `grep -r "soft-approve\|softApprove" scripts/ .claude/hooks/` returns 0 hits.

### S3-T5: End-to-end integration test for in-flight NO-VERIFY
- Complexity: S
- Files: scripts/lib/transcript-scan.test.mjs
- VERIFY: Test case added asserting in-flight bypass works AND prior-turn-only NO-VERIFY does NOT bypass.

---

## Sprint 4: Per-ref roles (Pain #2)
**Goal:** User can attach a "before" reference image without the gate marking it as a regression.
**Risks:** prompt-engineering for two-model review.
**MODEL:** Sonnet

### S4-T1: `--ref-role=goal|before` flag plumbing (repeatable, aligned with --refs)
- Complexity: S
- Files: scripts/visual-qa.mjs
- VERIFY: `node scripts/visual-qa.mjs --refs a.png --ref-role=before --refs b.png --ref-role=goal ...` parses correctly.

### S4-T2: Prompt branching by role in reviewWithOpenAI/Gemini
- Complexity: S
- Files: scripts/visual-qa.mjs
- VERIFY: With one `before` ref + intentional diff, both models return PASS (current behaviour returns FAIL).

### S4-T3: Store refRoles[] in verdict.json so it's part of contentHash
- Complexity: S
- Files: scripts/visual-qa.mjs, scripts/lib/verdict-hash.mjs
- VERIFY: Flip a role between two runs → contentHash differs.

### S4-T4: Update .claude/skills/visual-qa/skill.md runbook — assistant asks once on attachment with no role
- Complexity: S
- Files: .claude/skills/visual-qa/skill.md
- VERIFY: Runbook contains explicit "if user attached a reference image and no --ref-role passed, ASK first" instruction.

---

## Sprint 5: Cleanup + docs + manual e2e
**Goal:** Memory and CLAUDE.md reflect new mechanic; one manual end-to-end run on a real branch.
**MODEL:** Sonnet

### S5-T1: Update cloud-memory/feedback_local_preview_before_push.md
- Complexity: S
- Files: cloud-memory/feedback_local_preview_before_push.md
- VERIFY: File mentions contentHash, local ledger, in-flight NO-VERIFY, per-ref roles.

### S5-T2: Update CLAUDE.md §5 visual-qa section (rule rewording only — keep ≤150 lines)
- Complexity: S
- Files: CLAUDE.md
- VERIFY: `wc -l CLAUDE.md` ≤ 150; new mechanic mentioned.

### S5-T3: Manual end-to-end: small UI edit → /visual-qa → APPROVED → push → merge to main → push origin main
- Complexity: S
- Files: (none — verification task)
- VERIFY: Both pushes succeed without re-running /visual-qa on main.

---

## Dependencies Graph
S0-T1 → S0-T2 → S0-T3
S0-* → S1-T1..T10 (S1-T7 specifically needs S1-T6 done first)
S0-* → S3-T1..T5 (independent of S1, different file: transcript-scan.mjs)
S1-T6 → S2-T1..T5 (ledger uses contentHash naming)
S1-T6 → S4-T3 (hash inclusion)
S1..S4 → S5-T1..T3

## Subagent Execution Map (one /execute-plan session)
Track A (visual-qa.mjs / hooks):  S0-T1 → S0-T2 → S1-T1..T8 → S1-T9..T10 → S2-T1..T5 → S4-T1..T4 → S5-T1..T3
Track B (transcript-scan.mjs):           S0-T3 → S3-T1..T5
Sync points:                                                                ──after S1── ──after all──

Since this is one continuous autonomous session tonight, I'll run sequentially and commit per task — no actual subagent dispatch. Tracks are documented for future re-execution.

**Critical path:** S0 → S1 → S2 → S5. ~5–7h serial.

## Known Edge Cases
- macOS Playwright PNG non-determinism: defer raw-pixel sha until S1-T1 measurement shows it's needed.
- Fresh clone has no `.claude/visual-qa/approvals.jsonl` → fail-closed with clear "re-run /visual-qa" message.
- Merge commits in S2-T3: inheritance only — direct UI edits on a merge commit (octopus merge with conflicts resolved manually) need their own ledger entry.
- Long-lived branches: 7-day ledger TTL means re-approval required after a week. Acceptable — also forces revisiting stale work.

## Key Risks
1. **Stop hook coupling** — S1-T7 must land same sprint as the rename or hooks disagree mid-flight. Mitigation: commit S1-T6 + S1-T7 as a pair.
2. **transcript-scan.mjs API contract change** — both hooks call it; S3-T2 changes the visual-claim-language query signature. Mitigation: keep old query mode working via optional `--tool-use-id` arg.
3. **Hook fail-open on parse errors** — the existing hook fails open if it can't read the transcript. New ledger logic must preserve this contract — never fail-closed on environmental issues, only on policy violations.
