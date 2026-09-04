#!/usr/bin/env bash
# cron-health-sets.sh — the stale / recovered / unknown set arithmetic for
# .github/workflows/check-cron-health.yml.
#
# Extracted so it can be tested against the REAL code rather than a copy
# (CLAUDE.md rule 15). It is pure set logic over newline-separated name lists: no
# API calls, no git, no state file.
#
# THE BUG THIS EXISTS TO PREVENT (BRO-2771 follow-up, caught in review):
# a cron whose run-history query FAILED is absent from the stale list, because its
# health could not be determined. Absence is otherwise indistinguishable from
# health, so it was reported RECOVERED — which resolves its cron-health and
# cron-health-chronic alert conditions and resets its consecutive-stale streak to
# zero. An API failure every other day would then keep the 3-consecutive-day
# chronic escalation permanently out of reach for a cron that is still dead.
#
# The three groups are deliberately distinct:
#   stale     — checked, and confirmed overdue. Drives redispatch and paging.
#   unknown   — could not be checked. Never redispatched (we would be guessing) and
#               never counted as recovered, but its prior staleness is PRESERVED.
#   recovered — was stale, is no longer stale, AND we could actually check it.

# normalize_names <comma-or-newline-separated>
# Trims, drops blanks, de-duplicates and SORTS. Sorting matters: comm(1) silently
# produces wrong answers on unsorted input rather than failing.
normalize_names() {
  printf '%s' "${1-}" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sed '/^$/d' | sort -u
}

# stale_names_from_failures <FAILURES block>
# Pulls the friendly names out of the "❌ <name>: <detail>" lines.
stale_names_from_failures() {
  printf '%s' "${1-}" | grep -oE '❌ [^:]+:' | sed 's/^❌ //;s/:$//' | sort -u
}

# compute_cron_health_sets <current_stale> <prev_stale> <unknown>
# Echoes three sections separated by lines reading exactly "--", in this order:
#   newly stale, recovered, persist-stale
# All three inputs must already be normalized/sorted.
compute_cron_health_sets() {
  local current_stale="${1-}" prev_stale="${2-}" unknown="${3-}"

  # Newly stale is derived from confirmed-stale ONLY, so an unknown cron is never
  # redispatched on a guess.
  comm -23 <(printf '%s\n' "$current_stale") <(printf '%s\n' "$prev_stale") | sed '/^$/d'
  echo "--"

  # Recovered excludes anything we could not check this cycle.
  comm -13 <(printf '%s\n' "$current_stale") <(printf '%s\n' "$prev_stale") \
    | sed '/^$/d' \
    | comm -23 - <(printf '%s\n' "$unknown")
  echo "--"

  # Persisted stale keeps any PREVIOUSLY-stale cron we could not check, so its
  # streak survives an API blip. A cron that was healthy and is now unknown is NOT
  # invented as stale.
  printf '%s\n%s\n' "$current_stale" \
    "$(comm -12 <(printf '%s\n' "$prev_stale") <(printf '%s\n' "$unknown"))" \
    | sed '/^$/d' | sort -u
}
