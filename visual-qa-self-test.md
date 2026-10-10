# Visual-QA gate self-test (2026-05-24)

Verification log for the 8 scenarios from the sprint plan, plus 2 incident-driven additions from the other-session FYI.

## Component-level (during build)

| Scenario | Method | Result |
|---|---|---|
| (a) localhost capture → verdict.json with verdictHash | `node scripts/visual-qa.mjs --url http://localhost:3000 --paths "/"` against running dev server | ✓ 5 PNGs + 0 crops + 0 overflow at 13s; verdictHash = sha256-stable (recomputed match: true) |
| (a) localhost capture with `--elements` | Same + `--elements "h1,nav"` | ✓ 10 element crops added (5 widths × 2 selectors); 14s total |
| (a) reject non-localhost URL | `--url https://example.com` | ✓ exit 2 with "must be a localhost URL" error |
| (a) reject unreachable dev server | `--url http://localhost:59999` | ✓ exit 2 with "start dev server first" message |
| (a) reject missing reference file | `--refs /tmp/missing.png` | ✓ exit 1 with explicit error |
| (a) fail-closed on bad OPENAI key | `OPENAI_API_KEY=sk-bad ... --refs <real>` | ✓ openai.verdict=FAIL with provider error; gemini PASS independent; overallPass=false; exit 2 |
| (a) two-model PASS on identical image | Capture homepage, use as ref against itself | ✓ openai PASS + gemini PASS after anti-hallucination prompt + gpt-4o/gemini-2.5-pro upgrade |
| (a) prune stale branch dirs >48h | Seed `.claude/visual-qa/stale-test/file.png` with 2000-01-01 mtime | ✓ "pruned stale branch dirs: stale-test" on next run |
| (a) .gitignore covers `.claude/visual-qa/` | `git status .claude/visual-qa/` after capture | ✓ silent (ignored) |

## Transcript helper unit tests (S2-T5)

`node --test scripts/lib/transcript-scan.test.mjs` → **25/25 pass in 87ms**, covers:
- walker handles empty/truncated/multi-event transcripts
- ui-edits-without-verdict: .tsx/Write/.md cases; most-recent semantics; tailwind config
- approval-of: exact hash match; wrong hash; assistant text ignored; only LAST user msg
- push-ingress: git push variants, gh pr merge, gh workflow run deploy, wrapper scripts; non-push rejected
- reference-attached: [Image #N] marker, clipboard path, image content block; false case
- visual-claim-language: triggers on banned phrases; rejected when NO-VERIFY present; only LAST asst text
- override-active-for-push: detection; one-shot marker semantics

## Stop hook (S3-T1..T3) — extended `verify-edits.sh`

| Scenario | Expected | Actual |
|---|---|---|
| (e) empty transcript | exit 0 | ✓ 0 |
| (b) UI edit no verdict | exit 2 UNVERIFIED_VISUAL | ✓ 2 with explicit "Read element crops at full resolution" guidance |
| (c) UI edit + fresh verdict | exit 0 | ✓ 0 |
| (e) UI edit + NO-VERIFY: in last asst text | exit 0 | ✓ 0 |
| (f) UI edit + VISUAL_QA_DISABLE=1 | exit 2 (falls through to existing UNVERIFIED) | ✓ 2 |
| (preserved) scoring-logic edit | exit 2 SCORING gate fires | ✓ 2 |
| (g) UI edit + "Live on production" claim, no verdict | exit 2 UNVERIFIED_VISUAL_CLAIM | ✓ 2 with specific FeaturedSpot reference in message |
| (g) same + NO-VERIFY | exit 0 | ✓ 0 |
| (S3-T3) ref attached + verdicts:null | exit 2 UNVERIFIED_VISUAL_REF | ✓ 2 with "re-run with --refs" guidance |
| (S3-T3) ref attached + verdicts populated | exit 0 | ✓ 0 |

## Pre-push hook (S3-T4)

| Scenario | Expected | Actual |
|---|---|---|
| non-push command (`ls -la`) | exit 0 | ✓ 0 |
| `git push`, no UI changes in branch | exit 0 | ✓ 0 |
| Full APPROVED:<hash> / override / verdict scenarios | covered by next live UI session — gate fires when `git diff origin/main...HEAD` has UI files. This sprint's diff has no UI files (only .sh / .mjs / .md / CLAUDE.md), so the gate self-skips on this very push. | n/a this branch |

## PostToolUse whitespace-nowrap lint (S3-T5)

| Pattern | Diff | Warns? |
|---|---|---|
| A: long text in nowrap div | `<div className="whitespace-nowrap flex">HISTORICAL ACCURACY</div>` | ✓ warn |
| A: short text in nowrap | `<div className="whitespace-nowrap">A</div>` | ✓ silent |
| non-UI file (.md) | same content in README.md | ✓ silent |
| C: flex-1 + nowrap, no min-w-0 | `<div className="flex-1 whitespace-nowrap">title</div>` | ✓ warn |
| C: flex-1 + nowrap + min-w-0 | `<div className="flex-1 min-w-0 whitespace-nowrap">title</div>` | ✓ silent |

## Wiring (S3-T6 + S3-T7)

- Project `.claude/settings.json`: PreToolUse Bash matcher + PostToolUse Edit|Write matcher added; Stop unchanged (verify-edits.sh logic merged inline).
- Master `~/.claude/settings.json`: same entries added via `jq` patch; new hook scripts copied to `~/.claude/hooks/` and chmod +x'd. Active for THIS session's push.
- All 5 hook scripts executable, JSON valid.

## CI registration (Sprint 4)

- `.github/workflows/test.yml`: new step "Run scripts/lib tests (visual-qa transcript-scan etc.)" runs `node --test scripts/lib/*.test.mjs`. Covers transcript-scan + any future scripts/lib helpers. Passes locally (25/25, 87ms).

## Out of scope this sprint (documented for follow-up)

- **Auto-pass on no-rendered-output diff** — plan called for `git diff` inspection on changed UI files; if the diff has no JSX/className/CSS-token change (comment-only, type-only, prop rename), exit 0 to avoid forcing visual-qa for non-rendering edits. Not implemented to limit Sprint 3 scope; user can use NO-VERIFY for refactors. The 20% false-positive concern from the User-Impact reviewer is partially mitigated by VISUAL_QA_DISABLE=1 and NO-VERIFY: bypasses.
- **Refactor existing 5 `screenshot-*.mjs` scripts onto `scripts/lib/screenshot.mjs`** — explicitly out of scope per Sprint 1 plan. Follow-up: extract shared helper, migrate one script as proof, leave the rest.

## End-to-end ship

Branch `worktree-visual-qa-gate` → merge → main → push. The pre-push gate self-skips on this push because the diff has no UI files (only infrastructure, scripts, docs). Future UI-change pushes will exercise the full APPROVED:<hash> path.
