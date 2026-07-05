---
name: gh_cli_to_github_mcp_mapping
description: Cloud sessions have no gh CLI — how to run each CLAUDE.md gh-CLI runbook step through the GitHub MCP tools instead, and where the mapping breaks down
metadata:
  type: feedback
---

**Cloud Claude Code has no `gh` CLI.** All the CLAUDE.md runbooks are written in `gh` (deploy checks, CI monitoring, opening-night triggers, secret rotation). In a cloud session those commands do not exist — GitHub work goes through the **GitHub MCP connector** instead. This maps each documented step to its MCP equivalent, or says "skip, report instead" where there's no equivalent.

**Why:** A 2026-07-05 cloud session hit this repeatedly — `gh run list`, `gh workflow run "Deploy to Vercel"`, `gh secret set`, `gh run watch` are all in CLAUDE.md as literal commands, none run in cloud. The MCP path works but is lossy (no `--jq`, huge JSON blobs), so you have to adapt, not transliterate.

**How to apply — mapping table** (MCP tool names follow GitHub's official MCP server; match them to whatever your connector actually exposes — run one call and read the `mcp__<server>__<tool>` id it reports, names may differ slightly):

| CLAUDE.md gh command | GitHub MCP equivalent | Notes |
|---|---|---|
| `gh run list --limit N --json ... --jq ...` | `list_workflow_runs` | **No `--jq`.** Returns large JSON (≈110KB for 8 runs). Fetch, then filter in JS/Node — don't try to eyeball it. Ask for the smallest page you can. |
| `gh run view <id>` | `get_workflow_run` | Status/conclusion of one run. Cheap — prefer this over listing. |
| `gh run watch <id>` | (no streaming) `get_workflow_run` on an interval | MCP can't long-poll. Use `ScheduleWakeup(270s)` + a single `get_workflow_run`, per CLAUDE.md's "switch to ScheduleWakeup after >1 watch" rule. Do NOT loop `list_workflow_runs` (rate-limit burn — see [[feedback_github_polling_rate_limit]]). |
| `gh run view <id> --log` / job logs | `get_job_logs` / `list_workflow_jobs` | **Logs are the worst offender.** Job-log download URLs point at `*.blob.core.windows.net`, which the network policy blocks, and the payloads are 100–750KB and overflow context. Save the log to a file, then slice with Node/python — never paste a raw job log into context. |
| `gh workflow run "Deploy to Vercel"` | `run_workflow` (workflow_dispatch) | Pass workflow file name (`vercel-deploy.yml`) + ref + inputs. Same cascade caveat as CLAUDE.md §2 — don't manually deploy after a normal push. |
| `gh workflow run opening-night-orchestrator.yml -f show_id=X -f market=Y` | `run_workflow` with `inputs: {show_id, market}` | Confirm the run actually queued via `list_workflow_runs` after. |
| `gh secret set NAME` | **NONE — no MCP equivalent.** | GitHub MCP cannot write Actions secrets (needs libsodium encryption of the value). Report to the user with the exact `gh secret set` command to run locally, or the Settings → Secrets UI path. Don't claim a secret was rotated. |
| `gh pr view/create/merge` | `get_pull_request`, `create_pull_request`, `merge_pull_request` | These work well. `get_pull_request_files` / `get_pull_request_diff` for the diff. |
| `gh api <endpoint>` | `get_file_contents` / generic REST tools | For emergency commits (`gh api PUT /contents/`) see [[feedback_gh_api_emergency_commit]] — may need the user to run it locally. |
| `node scripts/check-prod-deploy.js HEAD` | runs as-is (Node) | This is a repo script, not `gh` — it works in cloud IF `broadwayscorecard.com` is allowlisted in the network policy (it wasn't on 2026-07-05, so the deploy check failed). |

**Hard rules for cloud GitHub work:**
- **Never dump a workflow-run list or job log into context.** Fetch → save to a scratchpad file → slice programmatically. The blobs overflow the window.
- **Secret rotation is not doable in cloud.** Report the command; don't pretend.
- **Monitoring = `ScheduleWakeup` + single `get_workflow_run`**, never a polling loop.
- **When a step has no MCP path, say so and report** rather than working around it silently.

Related: [[feedback_github_polling_rate_limit]], [[feedback_gh_api_emergency_commit]], [[feedback_e2e_runs_against_production]], [[feedback_mcp_reconnect]].
