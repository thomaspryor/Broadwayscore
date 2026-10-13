# shellcheck shell=bash
# git-net-timeout.sh: source this to get `git_net <secs> <git args...>`, a
# git network op with a hard wall-clock cap (BRO-4966).
#
# A transport hang (2026-09-08: pushes that neither succeed nor reject) never
# returns, so a retry loop around a bare `git push` waits for the job timeout
# instead of counting the hang as a failed attempt. `git_net` kills the op
# after <secs> (SIGKILL 10s later if it ignores SIGTERM) and returns 124 or
# 137, which callers treat like any other failure. The http.lowSpeed flags make
# git abort a stalled HTTP transfer on its own first. Same shape as
# push-with-retry.sh's _timeout/git_push, which can't be sourced (it runs its
# main body on load). Fail-open: with no timeout/gtimeout binary the op runs
# unbounded, as before.
#
# Callers: .github/actions/push-core-data/action.yml ("Commit and push core data").
git_net() {
  local secs="$1"; shift
  local bin
  bin="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
  if [ -n "$bin" ]; then
    "$bin" -k 10 "$secs" git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=45 "$@"
  else
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=45 "$@"
  fi
}
