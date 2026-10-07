# Hooks audit (BRO-383, Phase 3)

Source of truth for the hook migration. Every hook is either **KEEP** (with a stated reason) or **DELETE** (with the replacement named). No hook is left undecided. Audit date 2026-09-29; refreshed 2026-10-07 for two project hooks added since (pre-push-land-preflight, compact-state). `tests/unit/hooks-audit-coverage.test.mjs` fails when a hook under `.claude/hooks/` or `scripts/hooks/` is missing from this document or left undecided, so it cannot go stale silently.

Rule used: a hook is kept only if it blocks an irreversible or costly action *before* it happens and nothing downstream can catch it (shared-state races, spend, outbound email, main-branch writes, secret leaks), or it is pure session plumbing. Anything that only nags, duplicates CI or the Linear board, or polices a retired system is deleted.

## Inventory (where hooks live)

- User level: `~/.claude/hooks/*.sh` (44 scripts; the counts in this bullet and in the User-level table are NOT verifiable from this repo, `~/.claude` is a separate private repo) wired in `~/.claude/settings.json` (41 registrations across PreToolUse, PostToolUse, SessionStart, Stop, ConfigChange, FileChanged, Notification, UserPromptSubmit). Library code in `~/.claude/hooks/lib/`, tests in `~/.claude/hooks/tests/`.
- Project level: `.claude/hooks/*.sh` (18 scripts) wired in `.claude/settings.json`. Most are cloud-only copies that self-skip when the user-level master exists.
- Git hooks: `scripts/hooks/{pre-commit,commit-msg,pre-push}` via `core.hooksPath=scripts/hooks`.
- Codex: `.codex/hooks.json` points every event at `scripts/codex/hook-adapter.js`, which runs the Claude hooks above (see the Codex section).
- Not hooks, so not in the tables: `.claude/hooks/lib/strip-git-commit-noise.js` (helper for block-resend-broadcasts.sh), `scripts/setup-git-hooks.sh` (installs the git hooks), `~/.claude/hooks/lib/` and `~/.claude/hooks/tests/`.

Status key: KEEP / DELETE. "Replacement" is required for every DELETE.

## User-level hooks (`~/.claude/hooks/`)

| Hook | Event | Status | Reason (KEEP) / Replacement (DELETE) |
|---|---|---|---|
| worktree-enforce.sh | PreToolUse Edit/Write/Bash | KEEP | Uncommitted edits in the shared checkout get silently reverted by CI/parallel sessions; no downstream check can recover them. |
| pre-push-review-gate.sh | PreToolUse Bash | KEEP | Only guard on pushes to main and unreviewed code; the push is irreversible. |
| pre-merge-review-gate.sh | PreToolUse Bash | KEEP | Same guard one step earlier at the merge boundary into the shared local main. |
| pre-push-visual-gate.sh | PreToolUse Bash | KEEP | Blocks UI deploys without visual approval; prod UI regressions are user-visible. |
| block-resend-broadcasts.sh | PreToolUse Bash | KEEP | Broadcast email to real subscribers cannot be recalled (CLAUDE.md §17). |
| infra-plan-review-gate.sh | PreToolUse edit tools | KEEP | Shared infra (dispatch, spend guards, workflows) needs a review before the first edit (CLAUDE.md §18). |
| infra-post-write-audit.sh | PostToolUse Bash | KEEP | Backstop for the Bash arm of the gate above, which cannot parse every command string. |
| gh-poll-block.sh | PreToolUse Bash | KEEP | GitHub API quota was zeroed twice by polling loops; only a pre-execution block prevents it. |
| dispatch-timeout-guard.sh | PreToolUse Bash | KEEP | A `timeout` wrapper on a non-detached dispatch kills the job silently (BRO-3053). |
| cmux-destructive-guard.sh | PreToolUse Bash | KEEP | `cmux restore-session` once killed 14 live sessions; irreversible. |
| cmux-launch-guard.sh | PreToolUse Bash | KEEP | Launching claude without the permission flag stalls unattended sessions; canonical launcher exists but hand-rolled calls recur. |
| fanout-model-gate.sh | PreToolUse Agent/Task/Workflow | KEEP | Silent model inheritance on fan-out is a direct spend leak. |
| cloud-memory-pull-first.sh | PreToolUse edit tools | KEEP | cloud-memory/ is a shared-write race hotspot; a stale write produced conflict-state memos. |
| memory-index-cap-guard.sh | PreToolUse Edit/Write/Bash | KEEP | Harness truncates MEMORY.md at ~200 lines; the guard blocks growth past the cap before it is lost. |
| task-complete-dead-dispatch-guard.sh | PreToolUse TaskUpdate | KEEP | Prevents marking a task complete whose dispatch never launched (card #1144 incident). |
| exit-status-gate.sh | Stop | KEEP | The single mechanical enforcer of the recorded end-of-session block. Absorbs the checks that session-stop.sh does prose-side. |
| finish-line-gate.sh | Stop | KEEP | Enforces ship-check, execution evidence and prevention lines; the unfinished-work backstop. |
| verify-edits.sh | Stop | KEEP | Catches "done" claims with no run evidence; not replaceable by CI because it inspects the session. |
| linear-issue-required-stop.sh | Stop | KEEP | Enforces that code-touching sessions report to Linear (board of record). |
| linear-issue-verify.sh | PostToolUse Bash | KEEP | Feeds the sentinels linear-issue-required-stop.sh reads. Goes away only together with it. |
| session-start.sh | SessionStart | KEEP | Session plumbing: data check, drift warnings, worktree state. |
| workspace-mark-done.sh | Stop | KEEP | Mechanical tab marking replaces a skippable wrap-up step (card #154). |
| workspace-clear-needs-you.sh | UserPromptSubmit | KEEP | Clears the tab marker on owner reply; one `test -f` fast path. Pair of workspace-mark-done. |
| notify.sh | Notification | KEEP | Owner alerting when a session needs input; pure plumbing. |
| statusline.sh | statusLine (not a hook event) | KEEP | Shows the model loudly; part of Fable spend control. |
| model-drift-guard.sh | ConfigChange | KEEP | Auto-corrects the global default model that drifts to the priciest tier. |
| anti-slop-check.sh | Stop | KEEP | Owner's explicit standing rule for external-facing copy; no other layer sees the drafted text. |
| commit-check.sh | PostToolUse Bash | DELETE | Post-hoc commit-content nag. Replaced by `scripts/hooks/pre-commit` and `scripts/hooks/commit-msg` (commit-time checks); the commit content is also validated in CI. |
| script-edit-check.sh | PostToolUse Edit/Write | DELETE | Reminder text plus a tsc run per edit. Replaced by the tsc and `next lint` steps in `test.yml` (CI) and CLAUDE.md §12 (manual pre-commit checks); worktree warning is redundant with worktree-enforce.sh. |
| design-system-lint.sh | PostToolUse Edit/Write | DELETE | Warn-only zinc/slate class check. Replaced by an ESLint no-restricted-syntax rule in `next lint` (run in test.yml CI) so it fails instead of warns. |
| whitespace-nowrap-lint.sh | PostToolUse Edit/Write | DELETE | Warn-only Tailwind trap check. Replaced by the same ESLint rule set, plus `/visual-qa` overflow probe which already covers the rendered result. |
| design-system-mockup-check.sh | (not wired) | DELETE | Orphan script, registered nowhere. Replaced by `memory/design-system.md` plus the CLAUDE.md §4 rule; delete the file. |
| gh-zombie-reap.sh | (not wired) | DELETE | Orphan; reaps loops that gh-poll-block.sh now prevents. Replaced by gh-poll-block.sh; a launchd entry, if any, is removed with it. |
| config-change-notify.sh | ConfigChange | DELETE | Notification-only hash diff of skills/settings. Replaced by claude-sync (`~/.claude` is a git repo; `git diff` shows every change) and model-drift-guard.sh for the one change that costs money. |
| watched-file-changed.sh | FileChanged | DELETE | Same hash-dedup warning for shows.json/reviews.json/CLAUDE.md/MEMORY.md. Replaced by CLAUDE.md §10 (git diff after external modification) and `validate-data.js` in CI. |
| context-budget-nudge.sh | UserPromptSubmit | DELETE | Advisory nudge on every prompt. Replaced by `statusline.sh`, which already displays context use to the owner. |
| session-stop.sh | Stop | DELETE | Overlaps finish-line-gate.sh (verification claims) and exit-status-gate.sh (uncommitted state, status). Replacement: those two gates. |
| notion-card-required-commit.sh | PreToolUse Bash | DELETE | Notion retired 2026-08-20. Replaced by linear-issue-required-stop.sh and the Linear Done gate in `linear-brain.js`. |
| notion-card-required-stop.sh | Stop | DELETE | Same. Replaced by linear-issue-required-stop.sh. |
| notion-create-verify.sh | PostToolUse Bash | DELETE | Same. Replaced by linear-issue-verify.sh (it already covers `linear-brain.js`). |
| notion-create-block.sh | PreToolUse | DELETE | Blocks creating cards in a retired system. Replaced by the removal of `notion-brain.js create` itself (the script errors, so no hook is needed). |
| notion-mcp-block.sh | PreToolUse MCP/ToolSearch | DELETE | Notion MCP is not configured. Replaced by dropping the MCP server; nothing left to block. |
| git-pre-push-hook-tests.sh | (helper) | KEEP | Not a hook event: test runner behind claude-sync's push gate. Kept as tooling, reclassified out of the hook count. |

## Project hooks (`.claude/hooks/`)

These run on cloud sessions, where `~/.claude/hooks/` does not exist. Copies that duplicate a user-level master are kept only because cloud has no other copy.

| Hook | Event | Status | Reason (KEEP) / Replacement (DELETE) |
|---|---|---|---|
| cloud-bootstrap.sh | SessionStart | KEEP | Cloud-only dataset bootstrap; nothing else provides shows.json in cloud. |
| worktree-enforce.sh | PreToolUse | KEEP | Cloud copy of the master guard. |
| pre-push-review-gate.sh | PreToolUse Bash | KEEP | Cloud copy of the master guard. |
| pre-merge-review-gate.sh | PreToolUse Bash | KEEP | Cloud copy of the master guard. |
| pre-push-visual-gate.sh | PreToolUse Bash | KEEP | Cloud copy of the master guard. |
| block-resend-broadcasts.sh | PreToolUse Bash | KEEP | Cloud copy; email safety (BRO-4238). |
| infra-plan-review-gate.sh | PreToolUse | KEEP | Cloud copy of the master guard. |
| infra-post-write-audit.sh | PostToolUse Bash | KEEP | Cloud copy of the master backstop. |
| github-main-guard.sh | PreToolUse GitHub MCP | KEEP | GitHub MCP writes server-side and bypasses every git hook; sole guard on main. |
| block-prompting-remote-tools.sh | PreToolUse remote MCP | KEEP | Those tools prompt the owner's phone in every mode. |
| enterworktree-guard.sh | PreToolUse EnterWorktree | KEEP | Same-name resume of a locked/dirty worktree caused a real cross-session clobber (2026-07-26). |
| check-skill-redaction.sh | PreToolUse Bash | KEEP | Repo is public; blocks pushes that reintroduce a redacted sensitive string. |
| pre-push-land-preflight.sh | PreToolUse Bash | KEEP | Blocks a `land/*` push that land.yml would refuse anyway (rebase conflict, unregistered test file). Each refusal costs a ~30-minute land cycle; the check takes a second. Fails open. No master exists, so the project copy runs everywhere (BRO-4593). |
| compact-state.sh | PreCompact + SessionStart(compact) | KEEP | Writes a checkpoint before compaction and prints it back after, so a long session keeps its state (spend review 2026-10-01). Fail-open, no master exists, logic is unit-tested in `scripts/lib/compact-state.js`. |
| verify-edits.sh | Stop | KEEP | Cloud copy of the master Stop gate. |
| session-start.sh | SessionStart | KEEP | Cloud copy of the master. |
| notion-create-block.sh | (not wired) | DELETE | Notion retired. Replacement: none needed, `.claude/settings.json` does not register it; delete the file. |
| whitespace-nowrap-lint.sh | PostToolUse Edit/Write | DELETE | Replaced by the same ESLint rule set plus the `/visual-qa` overflow probe, as in the user-level entry. |

## Git hooks (`scripts/hooks/`)

| Hook | Status | Reason |
|---|---|---|
| pre-commit | KEEP | Runs before a commit exists: rejects tracked symlinks/gitlinks, wrong-aspect images, auto-sorts test manifests. Deterministic, no session context needed. |
| commit-msg | KEEP | Requires the VISUAL-OK-1440 prefix when UI files are staged. |
| pre-push | KEEP | Protects CLAUDE.md critical sections from concurrent-session reverts and runs the CI lint audits locally before a push burns a CI cycle. |

## Codex layer

Codex sessions run the same guards through one adapter; there is no second copy of any guard, so every decision above applies to Codex too.

| Hook | Event | Status | Reason (KEEP) / Replacement (DELETE) |
|---|---|---|---|
| scripts/codex/hook-adapter.js (registered by `.codex/hooks.json`, installed by `scripts/codex/install.js`) | all events | KEEP | Pass-through: reads `.claude/settings.json` at run time and runs every matching Claude hook unchanged (BRO-4745), so a Codex worker follows the same guards and nothing can drift. It shrinks automatically as hooks above are deleted. |

## Still registered until their migration step

A DELETE decision is taken, but the hook keeps running until its step in the migration order below. Today, in `.claude/settings.json`: whitespace-nowrap-lint.sh (step 1). `tests/unit/hooks-audit-coverage.test.mjs` fails if this line and the settings file disagree.

## Totals

- Kept: 28 user-level rows (27 hooks plus the git-pre-push-hook-tests.sh test helper; unverifiable from the repo) + 16 project (mostly cloud copies of user-level masters) + 3 git.
- Deleted: 15 user-level scripts (commit-check, script-edit-check, design-system-lint, whitespace-nowrap-lint, design-system-mockup-check, gh-zombie-reap, config-change-notify, watched-file-changed, context-budget-nudge, session-stop, and the five notion-* hooks) plus 2 project scripts (notion-create-block, whitespace-nowrap-lint).
- The named handful of *gates* that remain, by purpose: worktree, push/merge review, visual, email, infra review, API-poll, cmux safety, model spend, memory races, and the three Stop gates (exit-status, finish-line, verify-edits) plus Linear.

## Migration order (for the follow-up work)

1. Add the ESLint rules (design-system tokens, nowrap traps) and confirm `next lint` fails on a seeded violation; then remove design-system-lint and whitespace-nowrap-lint (user and project).
2. Remove the five notion-* hooks, their settings.json entries and `~/.claude/hooks/tests` fixtures.
3. Remove the remaining warn-only hooks (commit-check, script-edit-check, config-change-notify, watched-file-changed, context-budget-nudge, session-stop) and orphans (design-system-mockup-check, gh-zombie-reap).
4. Run `~/.claude/hooks/tests/run-all.sh` after each step; update `GATES.md` for session-stop removal.

Deletion happens in `~/.claude` (private repo, claude-sync) and `.claude/settings.json`; this document only records the decisions.
