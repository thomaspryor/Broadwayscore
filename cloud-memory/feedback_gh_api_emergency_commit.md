---
name: gh api emergency single-file commit
description: When local git state is broken, or push-with-retry.sh exhausts every retry under extreme concurrent-push churn (many sessions racing origin/main), commit directly via the GitHub API instead of fighting the local working tree. Single file → Contents PUT; multiple files atomically → Git Data API (blob/tree/commit/ref-update).
type: feedback
originSessionId: 7c8b1e1c-5601-47e8-b1c2-586a60403327
modified: 2026-07-31T04:18:09.905Z
---
## The situation

Observed 2026-04-24 during WE wrongProduction FP clear. Local
`data/review-texts` repo (which is the private `broadway-review-texts`
repo) was in mid-stash-pop corruption from another session — 72
modified files + 10+ unmerged (UU) entries from a broken `git stash
pop`, plus corrupt `refs/stash`. `git commit` refused. `git reset
--hard origin/main` would have destroyed another session's
uncommitted work.

## The workaround

Commit a single file directly via GitHub REST API. Bypasses the
local git state entirely:

```bash
FILE="mamma-mia-west-end-2021/variety--matt-wolf.json"
CONTENT=$(base64 -i /Users/tompryor/Broadwayscore/data/review-texts/$FILE)
SHA=$(gh api /repos/thomaspryor/broadway-review-texts/contents/$FILE --jq '.sha')
gh api -X PUT /repos/thomaspryor/broadway-review-texts/contents/$FILE \
  -f message="Commit message here..." \
  -f content="$CONTENT" \
  -f sha="$SHA" \
  -f branch="main"
```

Returns a commit SHA. The file lands on origin/main without touching
the local broken index.

## Why

- `gh api PUT /contents/...` uses the "Create or update file" REST
  endpoint. It creates a commit server-side from the base64 payload.
- The `sha` param is the blob SHA of the PREVIOUS version (needed for
  update; omit for create). Get it from `gh api ... --jq '.sha'`.
- File size limit is 1 MB for this endpoint; larger files need the
  Git data API.

## When NOT to use (single-file PUT)

- Multi-file commits — use the Git Data API instead (below).
- When the local state is clean — prefer `git commit` + `git push`.
- Auth: this uses your `gh auth` token, which must have write access
  to the repo.

## Multi-file atomic commit, or push-with-retry.sh exhausted under extreme churn

Observed 2026-07-30/31 (task #698): ~20 concurrent Claude sessions
pushing to the same repo made `push-with-retry.sh`'s local
fetch+rebase+push cycle lose 20/20 attempts even with
`PUSH_DEADLINE_SEC=300` and 10 retries — every rejection was a plain
non-fast-forward, never a real conflict. The local mutex
(`scripts/lib/push-mutex.sh`, task #556) only serializes THIS
machine's sessions against each other; it does nothing to make a
single rebase cycle faster than origin's actual advance rate, so
under sustained high churn the local flow can lose indefinitely
regardless of deadline/retry count.

Fix: build the commit server-side via the Git Data API instead of a
local rebase. No working-tree checkout, so each retry is a few small
API calls, not a full git rebase — landed on the FIRST attempt after
20 failed local-flow attempts.

```bash
REPO="owner/repo"
# 1. Blob per changed file
for f in "${FILES[@]}"; do
  sha=$(gh api "repos/$REPO/git/blobs" -f encoding=base64 \
    --field content="$(base64 < "$f")" --jq '.sha')
done
# 2. Current tip + its tree
MAIN_SHA=$(gh api "repos/$REPO/git/refs/heads/main" --jq '.object.sha')
BASE_TREE=$(gh api "repos/$REPO/git/commits/$MAIN_SHA" --jq '.tree.sha')
# 3. New tree (base_tree + changed-file blobs), new commit (parent=$MAIN_SHA)
NEW_TREE=$(gh api "repos/$REPO/git/trees" --input <(jq -nc \
  --arg bt "$BASE_TREE" --argjson tree "$TREE_JSON" '{base_tree:$bt, tree:$tree}') --jq '.sha')
NEW_COMMIT=$(gh api "repos/$REPO/git/commits" --input <(jq -nc \
  --arg msg "$MSG" --arg tree "$NEW_TREE" --arg parent "$MAIN_SHA" \
  '{message:$msg, tree:$tree, parents:[$parent]}') --jq '.sha')
# 4. Compare-and-swap the ref — fails safely (like non-fast-forward) if main moved
gh api "repos/$REPO/git/refs/heads/main" -X PATCH -f sha="$NEW_COMMIT" -F force=false
# On failure: re-fetch MAIN_SHA and retry from step 2. Each retry is cheap.
```

Verify landing via the Contents/Commits API at the exact SHA — not
`raw.githubusercontent.com` (can lag/cache) and not the push tool's
own stdout (this exact bug class, task #619/#420, silently drops
content via `git rebase -X theirs` without ever reporting a
conflict).

Follow-up carded: task #707 generalizes this into
`push-with-retry.sh` itself as an automatic post-exhaustion fallback.

## Related
- memory/feedback_notion_create_verify.md — similar pattern of
  checking the remote state after a possibly-silent failure.
