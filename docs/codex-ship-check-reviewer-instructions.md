# Codex ship-check reviewer: data preflight behavior (BRO-517)

## What runs Codex during ship-check

`/ship-check` Phase 5.3 shells out to the local Codex CLI (`codex exec --sandbox read-only
--skip-git-repo-check`) as the third, adversarial-design reviewer. Codex CLI reads this repo's
root-level `AGENTS.md` as its instructions for every invocation — that file is the *only* place
this repo controls Codex's behavior. There is no separate `.codex/` config; `AGENTS.md` is it.

## The bug

`AGENTS.md`'s "Before You Start" section previously said, unconditionally:

> Run `npm run data:check` — if data files are missing, stop and report it; do not proceed
> without data.

Codex follows this literally on every review, including diffs that never touch `data/`. On a
diff limited to `scripts/lib/done-semantics-gate.js` + its test + the test manifest (zero
`data/*.json` dependency), Codex ran `data:check`, found the local
`broadway-scorecard-data` checkout incomplete, and refused to review at all — citing "project
instructions require stopping in that case." This is a real coverage failure (see
`scripts/lib/review-output-guard.js`'s `CODEX_REFUSED` classification, task #1320), not a
zero-findings pass.

## Root cause and control

This is **fixed in this repo**, not a Codex CLI limitation. `AGENTS.md` is a plain instructions
file we author; the preflight rule was unconditional by mistake, not by Codex CLI design.

## The fix (two layers)

**1. `AGENTS.md`'s general preflight rule is now scoped**, since it governs every Codex
invocation in this repo, not just review:

- **Data-dependent** — diff touches `data/*.json`, `src/lib/data-core.ts`, `src/lib/engine.ts`,
  `src/lib/scoring.ts`, or any script that reads/writes `data/*.json` → run `npm run data:check`
  first; stop and report if core data is missing.
- **Data-independent** — diff is limited to `scripts/lib/` helpers, `tests/`, `docs/`, CI config,
  or other files with no `data/` import → skip the preflight, review directly.

Codex is told to `grep` the changed files for `data/` imports when it's unsure which bucket a
diff falls into.

**2. The `/ship-check` and `/plan-review` Codex prompts now carry an explicit per-invocation
override**, since a code review or plan critique never needs to execute anything against live
data regardless of what the diff touches:

> Do NOT run `npm run data:check`, `npm install`, `setup-local-data.sh`, or any other
> setup/preflight command — this is a pure read-only review of the diff below, no show/review
> data is needed, and worktree sessions do not have the full local data clone available. If
> CLAUDE.md's session-start convention would normally tell you to run a data-check preflight,
> that convention does not apply here: read the diff and the repository files directly and
> review them.

This second layer was discovered already present in the user's global `~/.claude/commands/`
copies of `ship-check.md` and `plan-review.md` — added in a prior session but never synced back
into this repo's tracked `.claude/commands/` copies (a command-file drift the session-start hook
flags on every session). Both repo copies now match. `second-opinion.md` and `wrap-up.md` do not
invoke Codex and needed no change; an unrelated `$CLAUDE_CODE_SESSION_ID` vs `$CLAUDE_SESSION_ID`
drift in `plan-review.md`/`second-opinion.md` is a separate issue and was left untouched (repo's
`$CLAUDE_CODE_SESSION_ID` is confirmed live in this environment — the global copy is the stale
side there).

The two layers are complementary: layer 1 is the correct general-purpose default for any Codex
task, layer 2 is a belt-and-suspenders override for the specific review invocations where the
answer is always "skip it," independent of what the diff touches.

## Fallback path (unchanged, still needed)

If Codex still refuses or produces empty output for any reason (flaky CLI, an unrelated
future preflight, no Codex CLI installed), `/ship-check` Phase 5.3 already falls through to the
same adversarial prompt run against `gpt-5.4-mini` via `api.openai.com`, and Phase 6's coverage
banner reports the degraded coverage explicitly (`CODEX_EMPTY` / `CODEX_REFUSED`). This doc only
fixes the common case (data-independent diffs); the fallback remains the safety net for
everything else.
