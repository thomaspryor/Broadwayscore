---
name: gh-cli-to-github-mcp-mapping
description: "Cloud sessions have no gh CLI — table mapping every gh command CLAUDE.md/skills reference to its GitHub MCP connector equivalent"
metadata:
  node_type: memory
  type: reference
  originSessionId: 20a446ba-7074-5e2e-87e5-a3d63c0383bd
---

`.claude/CLOUD.md` promises this file as "the full step-by-step mapping" for GitHub
work in cloud — it didn't exist until 2026-08-23 (dead link, found while
diagnosing why 8 iOS sessions in one day skipped mandatory steps that are
written as `gh` commands, e.g. wrap-up.md's async-operation gate). Cloud
sessions have no `gh` CLI at all; every `gh` invocation in CLAUDE.md,
`.claude/commands/*.md`, or memory must go through the `mcp__github__*` tools
instead (loaded on demand via ToolSearch — they're deferred tools, not
preloaded).

**How to read this table:** MCP tools are consolidated (one tool, many
`method` values) rather than one-tool-per-verb like `gh`. Always pass `owner`
and `repo` explicitly — there's no `git remote`-inferred default the way `gh`
picks up the current directory's repo.

| `gh` command | MCP equivalent |
|---|---|
| `gh pr create` | `mcp__github__create_pull_request` (`owner`, `repo`, `title`, `head`, `base`, `body`, `draft`) |
| `gh pr merge <N>` | `mcp__github__merge_pull_request` (`owner`, `repo`, `pullNumber`, `merge_method`) |
| `gh pr view <N>` | `mcp__github__pull_request_read` `method: "get"` |
| `gh pr diff <N>` | `mcp__github__pull_request_read` `method: "get_diff"` |
| `gh pr checks <N>` / commit status | `mcp__github__pull_request_read` `method: "get_status"` (combined status) or `method: "get_check_runs"` (individual check runs) |
| `gh pr view <N> --json files` | `mcp__github__pull_request_read` `method: "get_files"` |
| `gh pr view <N> --json commits` | `mcp__github__pull_request_read` `method: "get_commits"` |
| `gh pr view <N> --comments` | `mcp__github__pull_request_read` `method: "get_comments"` (issue-style) or `method: "get_review_comments"` (inline review threads) |
| `gh pr review <N>` (list reviews) | `mcp__github__pull_request_read` `method: "get_reviews"` |
| `gh pr review --approve/--comment/--request-changes` | `mcp__github__pull_request_review_write` — `method: "create"` to open a pending review, `add_comment_to_pending_review` for line comments, then `method: "submit_pending"` |
| `gh pr edit <N>` (title/body/base) | `mcp__github__update_pull_request` |
| `gh pr edit <N> --add-reviewer` | pass `reviewers` on `mcp__github__create_pull_request`, or re-`update_pull_request` |
| `gh run list` | `mcp__github__actions_list` `method: "list_workflow_runs"` (filter with `workflow_runs_filter.status`, `.branch`, `.event`, `.actor`) |
| `gh run list --workflow=X.yml` | `mcp__github__actions_list` `method: "list_workflow_runs"`, `resource_id: "X.yml"` |
| `gh run view <run-id>` | `mcp__github__actions_get` `method: "get_workflow_run"`, `resource_id: "<run-id>"` |
| `gh run view <run-id> --log` | `mcp__github__actions_get` `method: "get_workflow_run_logs_url"`, then fetch that URL — **note**: logs live on `*.blob.core.windows.net`, which is blocked by this session's proxy and can overflow context; prefer `mcp__github__get_job_logs` (below) which returns text directly, or `mcp__github__get_check_run` for a specific failed check's output |
| `gh run watch` | **Never** — see `feedback_github_polling_rate_limit.md`. Use `ScheduleWakeup` + a single later `mcp__github__actions_get` `method: "get_workflow_run"` check, not a polling loop |
| `gh workflow run <name>` | `mcp__github__actions_run_trigger` |
| `gh workflow list` | `mcp__github__actions_list` `method: "list_workflows"` |
| N/A (no `gh` equivalent — job-level log fetch) | `mcp__github__get_job_logs` — job's raw log text, paginated |
| N/A (no `gh` equivalent — single check run detail) | `mcp__github__get_check_run` — one check run's output text by `checkRunId`, paginated via `textOffset` |
| `gh api repos/x/y/pulls/N/comments` | `mcp__github__pull_request_read` `method: "get_review_comments"` (preferred) or `add_comment_to_pending_review` / `add_reply_to_pull_request_comment` to write |
| `gh issue create` / `view` / `list` | `mcp__github__issue_write` / `mcp__github__issue_read` / `mcp__github__list_issues` (`search_issues` for filtered queries) |
| `gh repo view` | `mcp__github__get_file_contents`, `mcp__github__search_repositories`, or `mcp__github__get_me` for the authenticated identity |
| `gh secret set` | **No MCP equivalent.** Repo/org secrets must be set through the GitHub web UI or a session with real `gh`/API push access outside this connector — flag to the user rather than attempting it. |

**Not covered by this table:** anything CLAUDE.md's global rules describe via
`wait-for-run.sh` or other local shell scripts that shell out to `gh` — those
scripts themselves don't run in cloud (no `gh` binary to call), so don't try
to invoke them; use the MCP tools above directly instead.
