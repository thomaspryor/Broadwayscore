---
name: feedback-shallow-since-poisons-git-shallow
description: "git fetch --shallow-since can succeed yet leave .git/shallow referencing a never-transferred object; every later fetch dies instantly with \"fatal: error in object: unshallow <sha>\" (rc=128)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 45d86cef-b8df-4028-b9ee-f45ba023d852
  modified: 2026-07-28T07:53:08.249Z
---

`git fetch --shallow-since=<date>` can SUCCEED while writing a `.git/shallow` boundary entry whose object was never transferred (edge case: merge commit sitting exactly at the window boundary; hit 2026-07-28 in check-corpus-drift.yml, boundary merge 44dfa33b dated 2026-07-18). After that, EVERY fetch in the repo fails in <1s with `fatal: error in object: unshallow <sha>` rc=128 — explicit-refspec, bare, and `--deepen=N` forms alike.

**Why:** the poisoned SHA is advertised to the server as a client shallow line; the server's unshallow response references an object the client can't read.

**Why it hides:** [[feedback-github-polling-rate-limit]] aside, `scripts/lib/push-with-retry.sh` discards fetch stderr (`2>/dev/null`), so CI logs show only `rc=128`. Diagnose by local repro: `git clone --depth=1 --no-checkout file://$HOME/Broadwayscore /tmp/x`, replay the workflow's deepen fetch, run the exact failing fetch with stderr visible.

**How to apply:**
- rc=128 in <1s = LOCAL git fatal (repo state: .git/shallow, locks). rc=124 at the 90s wall = network/timeout (task #464/#466 class). Instant failure on BOTH fetch forms → shared local state, not the refspec/bound.
- Self-heal (verified): remove the phantom SHA's line from `.git/shallow` (`git cat-file -e` per entry finds it), refetch → rc=0.
- A broken retry-fetch only surfaces under push contention → intermittent green/red alternation with instant rc=128 fetches is the signature; do not triage as flaky network or close as transient (the 10-day window slides, so it self-quiets and recurs).
- Related: [[feedback-parallel-worktree-race]] push-with-retry history (tasks #464, #466, #543).
