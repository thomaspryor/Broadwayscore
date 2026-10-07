#!/usr/bin/env bash
# Phantom .git/shallow self-heal (BRO-4603) — sourced by push-with-retry.sh,
# usable by any script that fetches into a shallow checkout.
#
# A shallow fetch (seen with --shallow-since and --deepen) can finish rc=0 yet
# leave a .git/shallow entry for a commit whose object never arrived. From then
# on EVERY fetch in that repo dies in <1s with
#   fatal: error in object: unshallow <sha>
# because git advertises the phantom as a client shallow, the server answers
# "unshallow <sha>", and the client cannot parse an object it does not have.
# Every retry repeats the identical failure. That is how card-verifiability-
# audit.yml (run 36999684962, 5/5 attempts) and opening-night-express.yml
# (run 37190310392, 7/7 attempts) lost their pushes on 2026-10-02/04 and paged
# the owner. See cloud-memory/feedback_shallow_since_poisons_git_shallow.md.
#
# Fix: drop only the entries whose commit object is missing locally. Entries
# for commits we do have are untouched, so the real shallow boundary (and
# every ancestry check that depends on it) stays exactly as it was.
#
# Usage:
#   source scripts/lib/heal-phantom-shallow.sh
#   heal_phantom_shallow            # rc 0 = removed >=1 phantom; rc 1 = nothing to do
#   is_phantom_shallow_error "$stderr_text"   # rc 0 when the text is this failure
#
# Fail-safe: any unexpected state (no shallow file, a concurrent git holding
# shallow.lock, every entry missing) leaves the file alone and returns 1.
# The rewrite holds shallow.lock the way git does, so it cannot interleave
# with a concurrent fetch in a shared checkout.

is_phantom_shallow_error() {
  case "${1:-}" in
    *"error in object: unshallow"*) return 0 ;;
    *) return 1 ;;
  esac
}

heal_phantom_shallow() {
  local shallow_file lock_file sha kept=0 removed=""
  shallow_file="$(git rev-parse --git-path shallow 2>/dev/null)" || return 1
  [ -s "$shallow_file" ] || return 1
  lock_file="${shallow_file}.lock"
  # git's own lockfile protocol: create shallow.lock exclusively (noclobber =
  # O_EXCL), write the new content into it, rename it over the original. If
  # another git process holds the lock it is rewriting the boundary right now,
  # so back off; while we hold it, a concurrent fetch cannot interleave.
  ( set -o noclobber; : > "$lock_file" ) 2>/dev/null || return 1

  while IFS= read -r sha || [ -n "$sha" ]; do
    sha="${sha%$'\r'}"
    [ -z "$sha" ] && continue
    if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
      printf '%s\n' "$sha" >> "$lock_file"
      kept=$((kept + 1))
    else
      removed="${removed:+$removed }$sha"
    fi
  done < "$shallow_file"

  # Nothing phantom, or nothing real left (an empty file would claim full
  # history the repo does not have): leave it as it was.
  if [ -z "$removed" ] || [ "$kept" -eq 0 ]; then
    rm -f "$lock_file"
    return 1
  fi
  if ! mv -f "$lock_file" "$shallow_file"; then
    rm -f "$lock_file"
    return 1
  fi
  local n
  n=$(echo "$removed" | wc -w | tr -d ' ')
  echo "::warning::heal-phantom-shallow: removed ${n} .git/shallow entr$([ "$n" -eq 1 ] && echo y || echo ies) with no local object (${removed}); kept ${kept}. Every fetch was failing with 'error in object: unshallow' (BRO-4603)."
  return 0
}
