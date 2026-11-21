#!/usr/bin/env bash
# BRO-5588: name the failing tests of a bare `node --test` step. Same extraction as
# run_batch() in .github/workflows/test.yml (BRO-2238): top-level `not ok` lines plus
# their `location:` line go to the step summary, each name becomes an annotation.
# Usage: summarize-failing-tests.sh <label> <logfile> <exit-code> [error|warning]
# Never changes the caller's result: always exits 0 (the step does `exit $rc`).
label="$1"; log="$2"; rc="${3:-0}"; level="${4:-error}"
[ "$rc" -eq 0 ] && exit 0
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ ! -r "$log" ]; then
  echo "::warning::$label batch exited $rc and its log $log is missing or unreadable, so no failing test could be named."
  exit 0
fi
failures=$(awk '
  /^not ok / { print; show=1; next }
  show && /^  location:/ { print; show=0; next }
  show && /^  \.\.\.$/ { show=0; next }
' "$log" 2>/dev/null)
if [ -n "$failures" ]; then
  echo "::group::$label batch — failing tests"
  echo "$failures"
  echo "::endgroup::"
  {
    echo "### $label batch — failing tests"
    echo '```'
    echo "$failures"
    echo '```'
  } >> "$summary"
  # GitHub shows at most 10 annotations per step; the rest are in the summary.
  n=0
  total=$(grep -c '^not ok ' "$log")
  while IFS= read -r name; do
    n=$((n + 1))
    [ "$n" -gt 10 ] && break
    name="${name//%/%25}"  # workflow commands decode %XX; keep the name literal
    echo "::$level::$label batch failing test: $name"
  done < <(grep '^not ok ' "$log" | sed -E 's/^not ok [0-9]+ - //')
  [ "$total" -gt 10 ] && echo "::$level::$label batch: +$((total - 10)) more failing tests, see the step summary"
else
  echo "::warning::$label batch exited $rc but no top-level 'not ok' TAP line was found in the log — likely a crash or timeout above, not a named test failure."
fi
exit 0
