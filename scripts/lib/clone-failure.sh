# BRO-7130: run a clone command and, when it fails, say WHY.
#
# setup-local-data.sh used to run `git clone ... 2>/dev/null` and then print
# "Check your access permissions." for every failure. A session whose disk
# allowance was spent (old worktrees) saw "fatal: write error: No space left on
# device" swallowed and reported as an access problem. This keeps git's stderr,
# captures it in memory, prints its last lines (tokens redacted), and names disk space plus the cleanup
# when that is the cause.
#
# Usage: run_clone "<what failed, e.g. Failed to clone broadway-review-texts>" "<hint for other errors>" cmd args...
# Returns the command's exit status. Every printed line starts with "ERROR:" so
# cloud-bootstrap-data.sh's `grep -E 'ERROR|FATAL'` filter keeps all of it.
run_clone() {
  local what="$1" hint="$2"
  shift 2
  local err rc
  # Capture stderr in memory, not a temp file: on a full disk mktemp can still
  # succeed while git's write into it fails, leaving the file empty and the
  # cause unreported (ship-check finding). fd 3 keeps the command's stdout.
  { err="$("$@" 2>&1 1>&3 3>&-)"; rc=$?; } 3>&1
  if [ "$rc" -ne 0 ]; then
    if printf '%s\n' "$err" | grep -qi 'No space left on device'; then
      echo "ERROR: $what: the disk is full (No space left on device), not an access problem."
      echo "ERROR:   Free space, then rerun: remove old worktrees (git worktree list; git worktree remove .claude/worktrees/<name>) and stale clones or build output (.next, node_modules caches)."
    else
      echo "ERROR: $what. $hint"
    fi
    # Last lines of the real error, with any embedded credential stripped.
    printf '%s\n' "$err" | tail -n 3 \
      | sed -E 's#(https?://)[^/@[:space:]]*@#\1***@#g; s#(gh[pousr]_|github_pat_)[A-Za-z0-9_]+#\1***#g' \
      | sed 's/^/ERROR:   git: /'
  fi
  return "$rc"
}
