# shellcheck shell=bash
# clone_review_texts_source <source clone> <dest dir>
#
# Clone a session-attached broadway-review-texts checkout locally (hardlinked
# objects, no network, no token) and check out the commit it should supply: its
# origin/main, else its HEAD. Prints that commit's sha. Returns 1 on failure.
# Used by setup-local-data.sh (REVIEW_TEXTS_SOURCE mode, BRO-5008). The commit
# choice must match sourceSha() in review-texts-refresh.js, or every session start
# re-copies.
#
# BRO-7128: cloud clones are shallow, and `git clone` of a shallow repo copies
# only what its local branches reach. A session clone sits on its session branch,
# usually behind its origin/main, so that commit was never in the new clone: the
# checkout failed and every cloud session kept a stale data/review-texts. Fetch
# origin/main in by ref before checking it out.
clone_review_texts_source() {
  local src="$1" dest="$2" sha
  if ! git clone -q "$src" "$dest"; then
    echo "ERROR: Local clone of $src failed." >&2
    return 1
  fi
  if sha="$(git -C "$src" rev-parse -q --verify 'refs/remotes/origin/main^{commit}')"; then
    if ! git -C "$dest" cat-file -e "$sha^{commit}" 2>/dev/null; then
      git -C "$dest" fetch -q "$src" '+refs/remotes/origin/main:refs/remotes/source/main' >&2 || true
    fi
  else
    sha="$(git -C "$src" rev-parse HEAD)" || return 1
  fi
  if ! git -C "$dest" checkout -q --detach "$sha"; then
    echo "ERROR: Could not check out $sha from $src." >&2
    return 1
  fi
  printf '%s\n' "$sha"
}
