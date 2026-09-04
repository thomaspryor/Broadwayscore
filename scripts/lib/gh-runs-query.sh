#!/usr/bin/env bash
# gh-runs-query.sh — list a workflow's runs, newest-first, through the Actions REST endpoint.
#
# BRO-2771 (follow-on to BRO-2767). NEVER use `gh run list --limit=N` for run history on this
# repo. With 6,600+ test.yml runs on main the gh CLI's paginated run listing returns arbitrary,
# sometimes months-stale result SETS — not merely a mis-ordered page. Three identical invocations
# about a minute apart on 2026-09-04 returned Sep 3-4 runs, then Aug 26-29 runs, then Aug 5 runs,
# with the core rate limit at 5000/5000 and the documented full workflow path in use. Every
# consumer assumes newest-first, so a stale page silently produces a wrong verdict.
#
# BRO-2767 fixed the six JavaScript call sites in scripts/health-check.js (see ghRunsQuery there).
# This is the bash equivalent, and it deliberately emits the SAME field names that
# `gh run list --json` did, so callers' downstream jq expressions need no edits:
#
#     databaseId  headSha  createdAt  updatedAt  conclusion  status
#
# Emitting raw REST keys (.id/.head_sha/.created_at) instead would silently blank every
# downstream `.createdAt` and make check-cron-health report "No successful runs found at all!"
# for every cron it watches.
#
# Sourcing this file requires a repo checkout. `.github/workflows/vercel-deploy.yml`'s
# `check-streak` job has no checkout step, so it carries an inline copy of the same query with a
# comment pointing here. Keep the two in sync.

# The jq program. Two invariants live here and nowhere else:
#   1. The result is an ARRAY. Raw REST returns an OBJECT ({total_count, workflow_runs}), and
#      `jq 'length'` on that object returns 2, not the run count — which is how a naive port of
#      check-cron-health's deploy-duration step would have errored and exited 1 on every daily run.
#   2. Newest-first is asserted here rather than inherited from the transport, matching
#      sortRunsNewestFirst() in scripts/health-check.js.
GH_RUNS_JQ='[.workflow_runs[] | {databaseId: .id, headSha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, conclusion: .conclusion, status: .status}] | sort_by(.createdAt) | reverse'

# gh_runs_query <repo> <workflow-file> <per-page> [key=value ...]
#
# <repo> is passed EXPLICITLY rather than resolved inside here, because the right answer differs
# by caller and neither default is safe everywhere:
#   - Inside a workflow, pass "$GITHUB_REPOSITORY". check-cron-health.yml already resolves the
#     repo that way at lines 170, 172 and 196 of the same bash step; using a different form for
#     the runs query would leave the state check reading one repo and the recency check another.
#   - Locally (scripts/ci-health-check.sh), pass the literal {owner}/{repo} placeholder, which gh
#     expands from the checkout. Note it is NOT env-immune: a GH_REPO in the environment overrides
#     it (purge-archives-history.yml:86, rotate-gitlab-token.yml:101 both set one).
#
# Extra key=value pairs are appended to the query string verbatim: status=success,
# status=completed, branch=main, event=push.
#
# Prints a JSON array on stdout. Exits 2 on a bad per-page.
gh_runs_query() {
  local repo="$1" workflow="$2" per_page="$3"
  shift 3

  if [ -z "$repo" ] || [ -z "$workflow" ]; then
    echo "gh_runs_query: repo and workflow-file are required" >&2
    return 2
  fi

  # The REST endpoint silently CAPS per_page at 100 and returns a shorter window than asked for.
  # For a streak scan that reads as "the streak ended here", so fail loudly instead of quietly
  # measuring the wrong thing. Mirrors the same guard in ghRunsQuery() (scripts/health-check.js).
  case "$per_page" in
    ''|*[!0-9]*) echo "gh_runs_query: per-page must be an integer 1-100, got '${per_page}'" >&2; return 2 ;;
  esac
  if [ "$per_page" -lt 1 ] || [ "$per_page" -gt 100 ]; then
    echo "gh_runs_query: per-page must be 1-100 (REST caps it), got ${per_page}" >&2
    return 2
  fi

  local query="per_page=${per_page}"
  local pair
  for pair in "$@"; do
    [ -n "$pair" ] && query="${query}&${pair}"
  done

  gh api "repos/${repo}/actions/workflows/${workflow}/runs?${query}" --jq "$GH_RUNS_JQ"
}
