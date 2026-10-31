#!/usr/bin/env bash
# Source after a review-texts pull. Successful rebases can silently pair
# unrelated review paths; use the same path invariant as push-with-retry.sh.
# Repairs are staged. The caller must commit them before another pull/push.
repair_review_texts_renames() {
  local before="$1" remote base helper out
  [ "$(git rev-parse HEAD)" != "$before" ] || return 0
  remote=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || return 1
  base=$(git merge-base "$before" "$remote") || return 1
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rename-crosswire.js"
  out=$(node "$helper" repair --base "$base" --ours "$before" --remote "$remote") || return 1
  printf '%s\n' "$out"
  # The general helper fails open for older callers. Sync must not push a
  # rebased tree when the invariant could not actually be checked.
  if [[ "$out" == *'::warning::'* ]] || ! grep -qE '^REPAIRED=[0-9]+$' <<<"$out"; then
    echo '::error::Could not verify review paths after pull; refusing to sync'
    return 1
  fi
}
