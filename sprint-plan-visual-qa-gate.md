# Sprint Plan: Visual-QA Gate (worktree-visual-qa-gate)

## Overview

Build a forcing-function system that prevents Claude Code sessions from claiming UI work is "done" without (1) actually verifying it themselves at full resolution + multiple widths, and (2) explicitly showing the result to the user for hash-bound approval before any push reaches main. Triggered by recurring FeaturedSpot-class incidents where agents read thumbnail-sized PNGs, missed clipping/overflow, and declared "Live on production" with shipped UI diverging from reference designs.

## Sprint Summary

| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1 | Runner + skill foundation (capture, overflow report, crops, LLM review) | 7 | 5S, 2M |
| 2 | Transcript helper with all query modes + unit tests | 5 | 4S, 1M |
| 3 | Hooks: Stop merge, pre-push, lint, settings wiring | 7 | 4S, 3M |
| 4 | Docs, memory, self-test, ship | 5 | 5S |

Total: 24 tasks (18S / 6M / 0L). Single session via `/execute-plan` with 2 subagent tracks within each sprint.

---

## Sprint 1: Runner + skill foundation

**Demo:** `node scripts/visual-qa.mjs --url http://localhost:3000 --paths "/" --elements ".tony-card" --refs ./design.png` produces 5 full-page screenshots, element-cropped legibility shots, a structural overflow report, and `.claude/visual-qa/<branch>/verdict.json` with `verdictHash`. LLM review runs against the reference and returns PASS/FAIL.

**Risks:** Playwright `waitForLoadState('load')` timing; dev server not running silently producing blank-page PASS; LLM JSON malformed; clipboard refs missing.

**MODEL:** Opus — net-new architecture + Playwright timing tuning + LLM fail-closed shape that downstream hooks depend on.

### Task S1-T1: Create `scripts/visual-qa.mjs` skeleton with dev-server health check
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/visual-qa.mjs` (new)
- **Description:** CLI skeleton with `--url`, `--paths`, `--branch`, `--refs`, `--elements`, `--out` flags. Validates URL is localhost. Performs `fetch(url)` health check before launching Playwright; if response <1KB or non-200 → exit 2 with "start dev server first (`npm run dev`)" message.
- **Acceptance criteria:**
  - VERIFY: `node scripts/visual-qa.mjs --url https://example.com --paths /` exits 2 with "localhost-only" error
  - VERIFY: `node scripts/visual-qa.mjs --url http://localhost:9999 --paths /` exits 2 with "dev server not reachable" message
  - VERIFY: `node scripts/visual-qa.mjs --help` prints all flags

### Task S1-T2: Add multi-width Playwright capture
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No (same file)
- **Files:** `scripts/visual-qa.mjs` (modify)
- **Description:** For each path × each width in [360, 414, 768, 1024, 1440]: viewport set, `page.goto(url+path, {waitUntil: 'load'})`, additional `await page.waitForTimeout(2000)`, full-page screenshot to `.claude/visual-qa/<branch>/<path-slug>/<width>.png`. Retry once on Playwright error. No `networkidle`.
- **Acceptance criteria:**
  - VERIFY: Run against running localhost:3000, produces 5 PNGs per path under `.claude/visual-qa/worktree-visual-qa-gate/_/`
  - VERIFY: Output files are valid PNGs (`file <path>` reports "PNG image data")
  - VERIFY: Captures complete in <30s for 1 path × 5 widths

### Task S1-T3: Add structural overflow report
- **Complexity:** S
- **Depends on:** S1-T2
- **Parallel:** No
- **Files:** `scripts/visual-qa.mjs` (modify)
- **Description:** After each viewport's screenshot, run `page.evaluate()` that walks all descendants and reports any where `scrollWidth > clientWidth + 1` or `scrollHeight > clientHeight + 1` (with `overflow: hidden` parent context). Collect into `verdict.json#overflowReport[{viewport, selector, dims}]`. Catches clipped pills, horizontal scroll, overflowed text — the FeaturedSpot "HISTORICAL ACCURA" silent failure.
- **Acceptance criteria:**
  - VERIFY: Synthetic test page with deliberately-overflowed div reports the selector in verdict.json
  - VERIFY: Clean page reports `overflowReport: []`
  - VERIFY: Overflow check runs in <500ms per viewport

### Task S1-T4: Add element-crop mode for legibility
- **Complexity:** S
- **Depends on:** S1-T2
- **Parallel:** Yes (different code path)
- **Files:** `scripts/visual-qa.mjs` (modify)
- **Description:** When `--elements <css-selector,css-selector>` provided, for each selector × each viewport: locate, `boundingBox()`, screenshot tightly cropped, save to `.claude/visual-qa/<branch>/<path-slug>/<width>/<sluggified-selector>.png`. Emit these paths in `verdict.json#elementCrops` so agent must Read them at full size (not thumbnail).
- **Acceptance criteria:**
  - VERIFY: `--elements "h1,.btn"` produces 2 cropped PNGs per viewport per path
  - VERIFY: Crops are tighter than full-page (`identify` reports smaller dims)
  - VERIFY: Skipped selectors that don't match emit warning, don't crash

### Task S1-T5: Add LLM review (GPT-4o + Gemini, parallel, fail-closed)
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes (different code path)
- **Files:** `scripts/visual-qa.mjs` (modify)
- **Description:** When `--refs <paths>` provided, in parallel call OpenAI gpt-4o-mini (vision) + Gemini 2.5 Pro with each ref + representative subset of screenshots (390 + 768 + 1440 viewports) + inline checklist prompt. Each must return `{verdict: "PASS"|"FAIL", issues: string[]}` with schema validation. Fail-closed: malformed JSON, timeout, rate limit, or one-provider down → `overallPass: false` with explicit `error` field. Load API keys from `.env` via `dotenv`.
- **Acceptance criteria:**
  - VERIFY: With valid refs and screenshots, both verdicts present in verdict.json
  - VERIFY: With `OPENAI_API_KEY=invalid` env, exits with verdict.json containing `verdicts.openai.error` and `overallPass: false`
  - VERIFY: With `--refs none` or no flag, runs without LLM call, verdict.json has `verdicts: null` and `overallPass: true` (no-refs mode = structural-only)

### Task S1-T6: Add verdict.json output + verdictHash + prune
- **Complexity:** S
- **Depends on:** S1-T3, S1-T4, S1-T5
- **Parallel:** No (final assembly)
- **Files:** `scripts/visual-qa.mjs` (modify), `.gitignore` (modify)
- **Description:** Assemble `verdict.json` with `{branch, url, paths, widths, screenshots[], elementCrops[], refs[], overflowReport[], verdicts: {openai, gemini}, overallPass, timestamp, verdictHash}`. `verdictHash = sha256(JSON.stringify(content without hash))`. After write, prune any `.claude/visual-qa/<other-branch>/` directory with newest-file mtime >48h old. Add `.claude/visual-qa/` to `.gitignore`.
- **Acceptance criteria:**
  - VERIFY: verdict.json contains all fields including hash; `sha256` of content-without-hash matches `verdictHash`
  - VERIFY: `.gitignore` includes `.claude/visual-qa/`; `git status` shows the dir is ignored
  - VERIFY: Pre-seeded stale `.claude/visual-qa/old-branch/` with old mtime gets pruned

### Task S1-T7: Rewrite skill as pure markdown runbook
- **Complexity:** S
- **Depends on:** S1-T1 (runner CLI surface defined)
- **Parallel:** Yes (independent file)
- **Files:** `.claude/skills/visual-qa/skill.md` (REWRITE — existing file in worktree assumes executable lives in skill dir), DELETE `.claude/skills/visual-qa/references/checklist.md` (content moves into runner LLM prompt)
- **Description:** Pure markdown runbook calling `node scripts/visual-qa.mjs ...`. Mirrors `verify-scores/skill.md` and `verify-opening-night/skill.md`. Documents the flow: start dev server → run skill → Read element crops at full size (not thumbnail) → paste manifest to user → wait for `APPROVED: <hash>` reply.
- **Acceptance criteria:**
  - VERIFY: `references/checklist.md` deleted; checklist content present inline in runner's LLM prompt
  - VERIFY: skill.md contains no inline executable Node/bash logic — only `node scripts/visual-qa.mjs` invocations
  - VERIFY: Frontmatter matches `verify-scores/skill.md` structure

---

## Sprint 2: Transcript helper

**Demo:** `node scripts/lib/transcript-scan.mjs --transcript <path> --query <mode>` returns correct JSON for each query mode against a synthetic fixture transcript. `node --test scripts/lib/transcript-scan.test.mjs` reports 0 failures across 10+ cases.

**Risks:** JSONL edge cases (truncated lines, mixed message shapes); transcript path resolution differs on cloud sandbox; query parser missing edge cases.

**MODEL:** Opus — public surface that BOTH `verify-edits.sh` AND `pre-push-visual-gate.sh` consume; design errors are expensive to fix later.

### Task S2-T1: Create `scripts/lib/transcript-scan.mjs` skeleton + JSONL walker
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/transcript-scan.mjs` (new)
- **Description:** CLI with `--transcript=<path>`, `--query=<mode>`. JSONL streaming walker that yields `(messageType, content)` events. Handles truncated final line, missing fields, mixed shapes. Exit 0 with JSON to stdout on success; exit 1 on bad args; exit 2 on transcript-not-found.
- **Acceptance criteria:**
  - VERIFY: Against a 100-line fixture transcript, walker yields expected count of assistant/user/tool_result events
  - VERIFY: Truncated final line doesn't crash
  - VERIFY: `--help` prints all 5 query modes

### Task S2-T2: Add `ui-edits-without-verdict` query
- **Complexity:** S
- **Depends on:** S2-T1
- **Parallel:** Yes
- **Files:** `scripts/lib/transcript-scan.mjs` (modify)
- **Description:** Walks Edit/Write tool_uses for `file_path` matching UI patterns (`src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`, `src/app/**`). Returns most recent edit (path, timestamp, mtime). Caller compares against `.claude/visual-qa/<branch>/verdict.json` mtime separately.
- **Acceptance criteria:**
  - VERIFY: Fixture with one .tsx edit returns it; fixture with one .md edit returns null
  - VERIFY: Returns most-recent edit when multiple present, ignoring exempt paths

### Task S2-T3: Add `approval-of <hash>`, `push-ingress`, `reference-attached`, `visual-claim-language` queries
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** Yes (same file but split into separate handler functions)
- **Files:** `scripts/lib/transcript-scan.mjs` (modify)
- **Description:** Four more query handlers:
  - `approval-of <hash>`: returns true iff last user message contains EXACT string `APPROVED: <hash>` (case-sensitive, single-use semantics handled by caller via marker file)
  - `push-ingress`: returns true iff a given Bash command string matches `git push|gh pr merge|bash scripts/.*push.*` (caller passes the command via `--command`)
  - `reference-attached`: returns true iff any user message in transcript has a `tool_result` or content block referencing image attachment (`/var/folders/.../clipboard-*.png` or image content type)
  - `visual-claim-language`: returns true iff last assistant text message contains banned-phrase pattern (`live on production|looks correct|matches the design|ready to ship|visually verified` AND no `NO-VERIFY:` in same message)
- **Acceptance criteria:**
  - VERIFY: Each of 4 queries returns correct JSON for fixture cases
  - VERIFY: `approval-of` is exact-match on hash; `APPROVED: abc123` does not match query for `xyz789`

### Task S2-T4: Add `override-active-for-push` query + marker-file semantics
- **Complexity:** S
- **Depends on:** S2-T3
- **Parallel:** No (same file)
- **Files:** `scripts/lib/transcript-scan.mjs` (modify)
- **Description:** Query returns true iff last user message contains `ship immediately for: <reason>` AND no `/tmp/visual-qa-override-consumed-<session-id>` marker file exists. On true, caller writes the marker file to consume it. Override is one-shot per session.
- **Acceptance criteria:**
  - VERIFY: First call returns true; second call (after marker written) returns false
  - VERIFY: Marker file is per-session-id so parallel sessions don't share state

### Task S2-T5: Write `scripts/lib/transcript-scan.test.mjs`
- **Complexity:** S
- **Depends on:** S2-T1, S2-T2, S2-T3, S2-T4
- **Parallel:** No (depends on all)
- **Files:** `scripts/lib/transcript-scan.test.mjs` (new), `.github/workflows/test.yml` (modify to register)
- **Description:** Node test (`node --test`, .mjs format per CLAUDE.md §15) covering: empty transcript, edits-only, edits+verdict-newer, edits+verdict-older, approval-hash-match, approval-hash-mismatch, push-ingress positive/negative for each ingress pattern, reference-attached, visual-claim-language with and without NO-VERIFY, override one-shot behavior.
- **Acceptance criteria:**
  - VERIFY: `node --test scripts/lib/transcript-scan.test.mjs` reports 0 failures
  - VERIFY: test.yml lints — `npx js-yaml .github/workflows/test.yml` passes
  - VERIFY: Test runs ≥10 cases

---

## Sprint 3: Hooks + wiring

**Demo:** Self-test scenarios (a)–(h) all pass: (a) localhost run produces verdict; (b) push without APPROVED blocks; (c) APPROVED:<hash> unlocks; (d) override unlocks once then re-locks; (e) auto-pass on comment-only .tsx edit; (f) cloud preamble exits 0; (g) visual-claim language without verdict blocks Stop; (h) whitespace-nowrap lint warns on offending diff.

**Risks:** Extending `verify-edits.sh` (300 LOC load-bearing) without breaking scoring/ship-check branches; settings.json wiring order matters; PostToolUse lint hook false-positive rate.

**MODEL:** Opus — surgical extension of load-bearing hook with multiple branches.

### Task S3-T1: Extend `verify-edits.sh` with `is_ui_edit` branch (auto-pass + verdict requirement)
- **Complexity:** M
- **Depends on:** S1-T6, S2-T2
- **Parallel:** Yes (different file from S3-T6)
- **Files:** `.claude/hooks/verify-edits.sh` (modify)
- **Description:** Add new branch mirroring existing `is_scoring_edit` / `is_shipcheck_edit` structure. Detects UI edits via existing transcript walk; for each, runs `git diff` on the file — if the diff has no JSX text content / className / CSS-token / style attribute change (only whitespace, type annotations, prop renames, comment-only), auto-pass. Otherwise require `.claude/visual-qa/<branch>/verdict.json` with mtime newer than the UI edit. Cloud preamble: `command -v chromium >/dev/null 2>&1 || exit 0`; honor `VISUAL_QA_DISABLE=1`.
- **Acceptance criteria:**
  - VERIFY: All existing verify-edits.sh tests still pass (run any existing self-test fixtures)
  - VERIFY: Synthetic transcript with comment-only .tsx edit → exit 0 (auto-pass)
  - VERIFY: Synthetic transcript with className change + no verdict.json → exit 2 with UI-gate message
  - VERIFY: `VISUAL_QA_DISABLE=1 bash .claude/hooks/verify-edits.sh < fixture.json` exits 0
  - VERIFY: With `PATH` stripped of chromium → exit 0 (cloud sandbox)

### Task S3-T2: Add visual-claim-language trigger to `verify-edits.sh`
- **Complexity:** S
- **Depends on:** S3-T1, S2-T3
- **Parallel:** No (same file)
- **Files:** `.claude/hooks/verify-edits.sh` (modify)
- **Description:** Extend `is_ui_edit` branch: even if no UI file edited in THIS turn, if any prior turn edited a UI file AND last assistant message uses visual-claim language (`live on production|looks correct|matches the design|ready to ship|visually verified`) without `NO-VERIFY:`, require verdict.json with `elementCrops` array non-empty (proves agent didn't read at thumbnail size).
- **Acceptance criteria:**
  - VERIFY: Synthetic transcript with .tsx edit + assistant text "Live on production" + no verdict → exit 2
  - VERIFY: Same transcript with verdict.json containing `elementCrops: ["/path/to/crop.png"]` → exit 0
  - VERIFY: Same transcript with `NO-VERIFY: <reason>` in last message → exit 0

### Task S3-T3: Add reference-attached enforcement to `verify-edits.sh`
- **Complexity:** S
- **Depends on:** S3-T1, S2-T3
- **Parallel:** No (same file)
- **Files:** `.claude/hooks/verify-edits.sh` (modify)
- **Description:** Extend `is_ui_edit` branch: if `transcript-scan --query reference-attached` returns true AND a UI edit occurred AND verdict.json has `verdicts: null` (no LLM review run) → exit 2 with "user attached a design reference — re-run /visual-qa with --refs to compare against it."
- **Acceptance criteria:**
  - VERIFY: Fixture with image-attached user message + UI edit + verdict.json missing LLM verdict → exit 2
  - VERIFY: Same fixture with verdict.json containing LLM verdicts → exit 0

### Task S3-T4: Create `.claude/hooks/pre-push-visual-gate.sh` (PreToolUse on Bash)
- **Complexity:** M
- **Depends on:** S2-T3, S2-T4
- **Parallel:** Yes (independent file)
- **Files:** `.claude/hooks/pre-push-visual-gate.sh` (new)
- **Description:** Self-skip preamble, cloud-sandbox preamble (`command -v chromium || exit 0`), `VISUAL_QA_DISABLE=1` escape. Reads `tool_input.command` from stdin JSON. If not push-ingress (via `transcript-scan --query push-ingress --command=<cmd>`) → exit 0. Else: `git diff origin/main...HEAD` for UI files with actual rendered-output change (reuse helper logic from S3-T1). If override active (`transcript-scan --query override-active-for-push`) → write consume marker, exit 0. Else require `transcript-scan --query approval-of <verdictHash>` true. On block: exit 2 with multi-line error listing exact `APPROVED: <hash>` syntax, exact `ship immediately for: <reason>` syntax, and `NO-VERIFY:` syntax.
- **Acceptance criteria:**
  - VERIFY: Hook receives JSON with `{tool_input: {command: "git push"}}` on stdin and exits 2 when no approval
  - VERIFY: Same input with `{prompt: "APPROVED: <correct-hash>"}` in transcript → exit 0
  - VERIFY: `ls /tmp/visual-qa-override-consumed-*` shows marker after override use
  - VERIFY: Stripped-PATH (no chromium) → exit 0
  - VERIFY: Error message includes literal "APPROVED: <hash>" and "NO-VERIFY:" tokens

### Task S3-T5: Create `.claude/hooks/whitespace-nowrap-lint.sh` (PostToolUse)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (independent file)
- **Files:** `.claude/hooks/whitespace-nowrap-lint.sh` (new)
- **Description:** Self-skip preamble. PostToolUse on Edit/Write; only fires on `.tsx`/`.jsx`. Scans `tool_input.new_string` (Edit) or `tool_input.content` (Write) for `whitespace-nowrap` in a `className` containing a text node longer than ~20 chars AND in a flex/grid context. Warning only (`stderr` + exit 0), modeled on `design-system-lint.sh`. Surfaces the FeaturedSpot overflow trap class.
- **Acceptance criteria:**
  - VERIFY: Diff adding `<div className="whitespace-nowrap flex">HISTORICAL ACCURACY</div>` triggers warning
  - VERIFY: Diff adding `<div className="whitespace-nowrap">A</div>` (short text) does NOT warn
  - VERIFY: Edits to non-UI files don't fire
  - VERIFY: Exit code always 0 (warning only, not block)

### Task S3-T6: Wire new hooks into `.claude/settings.json`
- **Complexity:** S
- **Depends on:** S3-T4, S3-T5
- **Parallel:** No (final wiring)
- **Files:** `.claude/settings.json` (modify)
- **Description:** Add PreToolUse `Bash` matcher entry for `pre-push-visual-gate.sh` (alongside existing notion-create-block.sh). Add PostToolUse `Edit|Write` matcher entry for `whitespace-nowrap-lint.sh`. NO Stop changes (logic merged into verify-edits.sh in S3-T1). Validate JSON.
- **Acceptance criteria:**
  - VERIFY: `jq . .claude/settings.json` parses without error
  - VERIFY: All 4 hook scripts referenced exist and are executable (`test -x`)
  - VERIFY: Diff shows ADDITIONS only (no removed existing hook entries)

### Task S3-T7: Mirror executable bits + chmod
- **Complexity:** S
- **Depends on:** S3-T4, S3-T5
- **Parallel:** Yes
- **Files:** `.claude/hooks/pre-push-visual-gate.sh`, `.claude/hooks/whitespace-nowrap-lint.sh`
- **Description:** `chmod +x` on both new hook scripts. Commit explicit mode change so git records it.
- **Acceptance criteria:**
  - VERIFY: `ls -la .claude/hooks/pre-push-visual-gate.sh` shows executable bit
  - VERIFY: `ls -la .claude/hooks/whitespace-nowrap-lint.sh` shows executable bit
  - VERIFY: `git diff --summary HEAD` mentions `mode change` for both

---

## Sprint 4: Docs, memory, self-test, ship

**Demo:** CLAUDE.md still loads under 150 lines (net-reduced); memory entry exists and is linked from MEMORY.md; full self-test of all 8 scenarios from Sprint 3 demo passes against a real session; final merge to main + push.

**Risks:** CLAUDE.md edit accidentally drops a load-bearing rule; MEMORY.md exceeds cap; self-test reveals integration bug requiring Sprint 3 backtrack.

**MODEL:** Sonnet — well-scoped doc + memory edits; the heavy lifting is done.

### Task S4-T1: Update CLAUDE.md §5 — REPLACE 3-viewport text with 2-line pointer
- **Complexity:** S
- **Depends on:** S3-T6
- **Parallel:** Yes
- **Files:** `CLAUDE.md` (modify)
- **Description:** Replace the existing §5 "Visual QA (MANDATORY for UI Changes)" body (~12 lines) with 2 lines: "Run `/visual-qa` before any push touching UI files. Gate enforces. See `memory/feedback_local_preview_before_push.md`." Net-reduce. Confirm total line count ≤150.
- **Acceptance criteria:**
  - VERIFY: `wc -l CLAUDE.md` ≤ 150
  - VERIFY: `grep "/visual-qa" CLAUDE.md` finds the new pointer
  - VERIFY: `grep "390×844\|768×1024\|1440×900" CLAUDE.md` finds nothing (old viewport text removed)

### Task S4-T2: Create `memory/feedback_local_preview_before_push.md`
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `/Users/tompryor/.claude/projects/-Users-tompryor-Broadwayscore/memory/feedback_local_preview_before_push.md` (new)
- **Description:** Frontmatter (name, description, type: feedback). Body: rule (always /visual-qa before push for UI; await `APPROVED: <hash>`); **Why:** FeaturedSpot incident — agent claimed "Live on production" with clipped "HISTORICAL ACCURA" label + lowercase case + reduced glow; thumbnail-Read missed the clip. **How to apply:** see `.claude/skills/visual-qa/skill.md`; gate enforces; bypass requires `NO-VERIFY:` with reason.
- **Acceptance criteria:**
  - VERIFY: File exists with valid YAML frontmatter (`head -10` shows name, description, metadata.type)
  - VERIFY: Body contains literal "FeaturedSpot" reference
  - VERIFY: Cross-link `[[feedback_two_model_ui_review]]` present

### Task S4-T3: Archive/update `memory/feedback_visual_verify_before_push.md` + `feedback_playwright_1440px_required.md`
- **Complexity:** S
- **Depends on:** S4-T2
- **Parallel:** No (depends on new file existing)
- **Files:** Two existing memory files (modify or add `archived: true` frontmatter)
- **Description:** Add `archived: true` frontmatter to both pre-existing entries (per `[[memory-archive-in-place]]` pattern). Body of each adds a 1-line "Superseded by [[feedback_local_preview_before_push]]" at top. Avoids conflicting advice.
- **Acceptance criteria:**
  - VERIFY: Both files contain `archived: true` in frontmatter
  - VERIFY: Both files top body line points to new entry

### Task S4-T4: Update MEMORY.md index (archive 1 entry to stay under cap if needed)
- **Complexity:** S
- **Depends on:** S4-T2, S4-T3
- **Parallel:** No
- **Files:** `/Users/tompryor/.claude/projects/-Users-tompryor-Broadwayscore/memory/MEMORY.md` (modify)
- **Description:** Add 1-line index entry under "🎨 UI / design system" pointing to new file. Remove the 2 archived entries from the index (rebuild-memory-index.js will skip archived but a manual prune keeps live count down). Verify `wc -l MEMORY.md` ≤180.
- **Acceptance criteria:**
  - VERIFY: `wc -l MEMORY.md` ≤ 180
  - VERIFY: `grep "feedback_local_preview_before_push" MEMORY.md` finds the new index line
  - VERIFY: `grep "feedback_visual_verify_before_push\|feedback_playwright_1440px_required" MEMORY.md` finds nothing (removed)

### Task S4-T5: Run full self-test (8 scenarios) + commit + push to main
- **Complexity:** M
- **Depends on:** ALL prior tasks
- **Parallel:** No (final integration test)
- **Files:** None (test only); then `git push` after manual approval
- **Description:** Stand up `npm run dev` against localhost:3000. Run each of 8 scenarios with synthetic fixture transcripts and real hook invocation, capture pass/fail for each. Scenarios: (a) localhost capture produces verdict; (b) push without APPROVED blocks; (c) APPROVED:<hash> unlocks; (d) override unlocks once then re-locks; (e) auto-pass on comment-only .tsx edit; (f) cloud preamble (stripped PATH) exits 0; (g) visual-claim language without verdict blocks Stop; (h) whitespace-nowrap lint warns on offending diff. Document outputs. THEN merge worktree → main → push. Final push requires `APPROVED:` (eat your own dogfood).
- **Acceptance criteria:**
  - VERIFY: All 8 scenarios documented PASS in a self-test log committed to repo as `docs/visual-qa-self-test.md`
  - VERIFY: `git log main --oneline -5` shows the merged commits
  - VERIFY: `gh run list --workflow="Deploy to Vercel" --limit 1` shows a recent run triggered by the push (or confirmed cron-deploy will pick it up in <5min)

---

## Dependencies Graph

```
Sprint 1:
  S1-T1 → S1-T2 → S1-T3 ─┐
                  S1-T4 ─┼→ S1-T6 (assembly)
                  S1-T5 ─┘
  S1-T7 (independent)
Sprint 2 (depends only on Sprint 1 conceptually — paths/contracts):
  S2-T1 → S2-T2 ─┐
            S2-T3 ─┼→ S2-T4 → S2-T5 (tests)
Sprint 3:
  S3-T1 ← (S1-T6, S2-T2)
  S3-T2 ← (S3-T1, S2-T3)
  S3-T3 ← (S3-T1, S2-T3)
  S3-T4 ← (S2-T3, S2-T4)  parallel with S3-T1
  S3-T5 (independent, parallel)
  S3-T6 ← (S3-T4, S3-T5)
  S3-T7 (parallel with S3-T6)
Sprint 4:
  S4-T1, S4-T2 parallel
  S4-T3 ← S4-T2
  S4-T4 ← S4-T2, S4-T3
  S4-T5 ← ALL
```

## Subagent Execution Map (within one /execute-plan session)

```
Subagent track A:  S1-T1→S1-T2→S1-T3→S1-T6 │ S2-T1→S2-T2 │ S3-T1→S3-T2→S3-T3 │ S4-T1
Subagent track B:  S1-T4 │ S2-T3→S2-T4 │ S3-T4 │ S4-T2→S4-T3→S4-T4
Subagent track C:  S1-T5 │ ─────── │ S3-T5→S3-T7 │ ──────
Subagent track D:  S1-T7 │ ─────── │ ─────── │ ──────
Sync:             ── after S1 ── after S2 ── after S3 ── after S4 (S4-T5 is integration)
```

**Parallel sprints:** None — sprints are sequential by design (Sprint 2 needs Sprint 1's verdict.json shape; Sprint 3 needs both; Sprint 4 needs Sprint 3 wired).
**Critical path:** Sprint 1 → Sprint 2 → Sprint 3 → Sprint 4 = 1 session if coordinator dispatches subagent tracks well.
**Max subagent parallelism:** 4 within Sprint 1, 2 in Sprint 2, 3 in Sprint 3, 2 in Sprint 4.
**Cross-session plan:** Single session sufficient (~3-4 hours wall clock with subagent parallelism). If context tightens, natural break point is after Sprint 2 (push commits, fresh session picks up Sprint 3+4).

## Known Edge Cases

- **Cloud iOS session attempting UI edit:** `verify-edits.sh` cloud preamble auto-passes; user is told via skill markdown that cloud sessions cannot ship UI.
- **Hotfix at 3am, no dev server:** `NO-VERIFY: <hotfix reason>` in last assistant message bypasses both Stop and pre-push gates. Documented in error messages.
- **User pastes design then immediately says "ship immediately":** Override consumed for THIS push only; subsequent UI edits still require fresh approval.
- **User says `APPROVED: <hash>` but the verdict.json was overwritten by a new run with different hash:** Hash mismatch → block; agent must re-share the new manifest with the user.
- **Multiple parallel worktree sessions on same branch name:** marker files keyed by session_id, not branch — no cross-contamination.
- **Refactor of 1 file that changes JSX prop name but not rendered output:** auto-pass via diff-content check (no className / CSS-token / text-node change).
- **Image attached via clipboard but agent never references it:** `reference-attached` query trips on attachment presence; if verdict has no LLM review → block. Agent forced to run with `--refs`.
- **Long session where APPROVED:<hash> was given hours ago for a prior change:** approval is hash-bound; new edit → new verdict → new hash → old APPROVED doesn't match.

## Changes from Critique (and the other-session FYI)

| Change | Reason | Source |
|--------|--------|--------|
| Runner moved to `scripts/visual-qa.mjs` (was inside skill dir) | Skill shape divergence P0 — every other skill is markdown runbook | Code Design reviewer |
| Stop hook MERGED into verify-edits.sh (not a new file) | Two Stop hooks race on stop_hook_active | Code Design + Codex |
| Extracted `scripts/lib/transcript-scan.mjs` | Inline Python in bash is wrong layer + duplicates verify-edits.sh logic | Code Design |
| 5 widths not 10 | Perf realism; still hits all Tailwind breakpoint bands | Devil's Advocate (networkidle / runtime) |
| Auto-pass on non-rendered-output diffs | 20% FP rate would create NO-VERIFY muscle memory | User Impact |
| Hash-bound APPROVED token (not natural-language) | "looks great" in critique unlocks unrelated push | Devil + User Impact + Codex |
| Override is one-shot via marker file (not session-wide) | Stale override hours later unlocks unrelated push | Devil + User Impact + Codex |
| Cloud-sandbox preamble + `VISUAL_QA_DISABLE=1` kill switch | 9-day unbypassable deadlock pre-mortem | Pre-mortem + Codex |
| Dev-server health check before capture | Blank-page screenshots get PASS from both LLMs | Devil + Gemini |
| `.gitignore` `.claude/visual-qa/` + prune >48h | 4GB artifact bloat scenario | Pre-mortem |
| No clipboard auto-detect for refs | Picks up unrelated clipboard images | Devil |
| `--elements <css-selector>` for full-size crops | **Thumbnail-Read is the silent-PASS root cause** | Other-session FYI #1 |
| Structural `scrollWidth > clientWidth` overflow report | Catches clipped pills like "HISTORICAL ACCURA" | Other-session FYI #1 |
| `visual-claim-language` trigger in Stop hook | "Live on production" claim without proof IS the FeaturedSpot pattern | Other-session FYI #4 |
| `reference-attached` trigger in Stop hook | When user supplies design, agent MUST compare via LLM not skip it | Other-session FYI #2 |
| New `whitespace-nowrap-lint.sh` hook | Catches the recurring overflow trap pattern at write time | Other-session FYI #3 |
| Replaced (not augmented) CLAUDE.md §5 | 150-line cap already breached | Codex + session-start warning |

## Key Risks

1. **`verify-edits.sh` extension breaks existing scoring/ship-check branches.** Mitigation: S3-T1 explicitly verifies all existing fixtures still pass before adding new branch; structured as additional `if is_ui_edit` after existing branches.
2. **LLM rate-limit or outage cascades to false FAILs.** Mitigation: fail-closed is the intended behavior — better to block than silently pass. Override (`ship immediately for: provider outage`) gives user manual escape.
3. **Self-test (S4-T5) reveals integration bug requiring backtrack.** Mitigation: each Sprint 3 task has its own VERIFY that hits the hook directly with a fixture — integration surprises should be caught earlier, not at S4-T5.
