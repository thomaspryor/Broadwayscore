#!/usr/bin/env bash
# Modify/delete conflict classifier for push-with-retry.sh resolve_conflicts().
# Sourced, never executed. Reads $PULL_BRANCH (the branch being pushed).
#
# git checkout --ours/--theirs fails on modify/delete conflicts because one side
# has no version. Common cause: poller creates --unknown.json, LLM scoring
# renames it to --named-critic.json on remote, so the poller's push sees
# modify/delete and the right answer is to accept the deletion.
#
# BRO-5494: "remote lacks the path" is NOT the same as "remote deleted it". When
# our commit deletes a _pending/ file and ADDS a new review file, git's rename
# detection can pair the two (56% similar on 2026-10-16). If the remote also
# deleted the _pending/ file, git reports rename/delete + modify/delete on OUR
# NEW path, a path the remote never had. Accepting "the deletion" there rm'd a
# brand-new review, the post-rebase survival check aborted, and the run lost 17
# files. So when the remote lacks the path we check the merge base: if the base
# never had it either, it is a local addition and must be kept.
#
# is_modify_delete FILE MODE   (MODE = rebase | merge)
#   Returns 0 if modify/delete, 1 if normal both-sides conflict.
#   Sets IS_DELETED_LOCALLY=true|false, and IS_LOCAL_ADDITION=true|false
#   (true only when the remote side lacks the path AND the merge base provably
#   lacked it too; an undeterminable base, e.g. a shallow clone, stays false so
#   the old accept-deletion behavior and the survival check still apply).

# The local commit whose version of a path we keep: during a rebase it is the
# commit being replayed (REBASE_HEAD); during a merge it is our branch (HEAD).
modify_delete_local_ref() {
  if [ "$1" = "rebase" ]; then echo REBASE_HEAD; else echo HEAD; fi
}

is_modify_delete() {
  local file="$1"
  local mode="$2"
  local local_ref base
  local_ref=$(modify_delete_local_ref "$mode")
  IS_DELETED_LOCALLY=false
  IS_LOCAL_ADDITION=false

  # Check remote side
  if ! git cat-file -e "origin/$PULL_BRANCH:$file" 2>/dev/null; then
    # Remote deleted (or never had) this file. Tell the two apart by the base.
    if git cat-file -e "$local_ref:$file" 2>/dev/null \
       && base=$(git merge-base "origin/$PULL_BRANCH" "$local_ref" 2>/dev/null) \
       && [ -n "$base" ] \
       && ! git cat-file -e "$base:$file" 2>/dev/null; then
      IS_LOCAL_ADDITION=true
    fi
    return 0
  fi

  # Check local side (the commit being applied)
  if ! git cat-file -e "$local_ref:$file" 2>/dev/null; then
    IS_DELETED_LOCALLY=true
    return 0
  fi

  return 1  # Both sides have the file — normal conflict
}
