# shellcheck shell=bash
# Sourced by scripts/setup-local-data.sh (BRO-5938).
#
# On the owner's Mac, `setup-local-data.sh --all` used to clone broadway-review-texts
# into a temp dir, strip .git and swap the result in as data/review-texts, deleting
# the previous copy. Every pipeline writer (review-file-writer.js and ~50 scripts that
# hardcode data/review-texts) writes into that copy, so a Mac-local scrape or ingest
# left its files where nothing commits them, and the next re-sync deleted them. The
# real clone lives at ~/broadway-review-texts.
#
# Fixing that per caller would split readers from writers: the rebuild and ~60 audit
# tools read data/review-texts too. So fix the tree instead: when a real
# broadway-review-texts clone exists, data/review-texts becomes a link to it, and
# reads, writes and pushes all happen in one checkout. CI (clones straight into
# data/review-texts) and cloud (a stamped copy by design, BRO-5217) are unchanged.

# 0 when $1 is a git checkout whose origin names review-texts and holds content.
review_texts_is_clone() {
  local dir="$1"
  [ -e "$dir/.git" ] || return 1
  git -C "$dir" remote get-url origin 2>/dev/null | grep -qi 'review-texts' || return 1
  # .git alone is the false-all-clear shape review-texts-dir.js rejects too.
  find "$dir" -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit | grep -q .
}

# 0 when data/review-texts is a symlink into a git checkout. Copying a fresh tree
# THROUGH such a link overwrites the clone's working tree, uncommitted writes included.
review_texts_link_is_checkout() {
  local link="$1/review-texts"
  [ -L "$link" ] && [ -e "$link/.git" ]
}

# link_review_texts_clone DATA_DIR CLONE_DIR
#   0  data/review-texts now links to CLONE_DIR (or already did)
#   1  not applicable here; the caller keeps its copy flow
#   2  failed; the caller must stop
link_review_texts_clone() {
  local data_dir="$1" clone="$2" rt="$1/review-texts"

  if [ "${REVIEW_TEXTS_COPY:-}" = 1 ] || [ "${CLAUDE_CODE_REMOTE:-}" = true ] \
    || [ -n "${REVIEW_TEXTS_SOURCE:-}" ] || [ "${GITHUB_ACTIONS:-}" = true ]; then
    return 1
  fi
  review_texts_is_clone "$clone" || return 1

  # The copy flow cloned fresh from origin each time; keep the clone as fresh.
  # Never pull over uncommitted work: --autostash can leave conflict markers in
  # review JSON and briefly resets files a running writer may be touching. A
  # skipped or failed pull leaves the clone as is: still the right place to
  # write, so warn and carry on.
  if [ -n "$(git -C "$clone" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "WARNING: $clone has uncommitted changes; not updating it. Commit or push them, then re-run."
  elif ! GIT_TERMINAL_PROMPT=0 git -C "$clone" pull -q --ff-only 2>/dev/null; then
    echo "WARNING: could not fast-forward $clone (offline or diverged); linking it as it is."
  fi

  local clone_real moved=0 backup=""
  clone_real="$(cd "$clone" && pwd -P)" || return 2

  if [ -L "$rt" ]; then
    if [ "$(cd "$rt" 2>/dev/null && pwd -P)" = "$clone_real" ]; then
      echo "Review texts: data/review-texts already links to $clone"
      _link_review_texts_archive "$data_dir" "$clone" || return 2
      return 0
    fi
    rm "$rt" || return 2 # the link only, never its target
  elif [ -e "$rt" ]; then
    # Keep the old copy: it may hold the only copy of reviews written before this fix.
    # Never overwrite an earlier backup: it may hold the only copy of older writes.
    backup="$data_dir/.review-texts.copy-backup"
    [ -e "$backup" ] && backup="$backup.$(date +%Y%m%d-%H%M%S)"
    mv "$rt" "$backup" || return 2
    moved=1
    local only
    only="$(cd "$backup" && find . -name '*.json' -type f | while IFS= read -r f; do
      [ -e "$clone_real/$f" ] || echo "$f"; done | wc -l | tr -d ' ')"
    echo "Review texts: old copy moved to data/${backup##*/} ($only json files there are not in the clone; check before deleting)"
  fi

  if ! ln -s "$clone_real" "$rt"; then
    # Put the copy back rather than leave no data/review-texts at all.
    [ "$moved" = 1 ] && [ ! -e "$rt" ] && mv "$backup" "$rt"
    return 2
  fi
  echo "Review texts: data/review-texts now links to $clone (BRO-5938)"
  _link_review_texts_archive "$data_dir" "$clone" || return 2
  return 0
}

# The copy flow peeled aggregator-archive out of the clone into data/; keep doing that.
_link_review_texts_archive() {
  local data_dir="$1" clone="$2"
  [ -d "$clone/aggregator-archive" ] || return 0
  mkdir -p "$data_dir/aggregator-archive"
  if ! cp -a "$clone/aggregator-archive/." "$data_dir/aggregator-archive/"; then
    echo "FATAL: cp of aggregator-archive failed." >&2
    return 1
  fi
  echo "Aggregator archive: $(find "$data_dir/aggregator-archive/" -type f | wc -l | tr -d ' ') files in data/aggregator-archive/"
}
