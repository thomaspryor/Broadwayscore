---
name: gh api emergency single-file commit
description: When local git state is broken (mid-stash-pop conflicts from another session, unmerged index, corrupt refs/stash) and you need to commit a single file, use `gh api PUT /contents/{path}` instead of trying to untangle the local working tree.
type: feedback
originSessionId: 7c8b1e1c-5601-47e8-b1c2-586a60403327
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

## When NOT to use

- Multi-file commits (tedious, one API call per file, no atomicity).
- When the local state is clean — prefer `git commit` + `git push`.
- Auth: this uses your `gh auth` token, which must have write access
  to the repo.

## Related
- memory/feedback_notion_create_verify.md — similar pattern of
  checking the remote state after a possibly-silent failure.
