---
name: Recurring backfill commits = broken creator script
description: When git log shows 3+ reactive "backfill field X" commits, stop backfilling and find the script that writes empty X
type: feedback
originSessionId: c465b526-2fc2-4dbe-8cbc-4d7c6db5d9fe
archived: true
---
When `git log --oneline -- data/<file>.json | grep -iE "backfill|fix.*missing|set <field>"` returns 3+ commits in the last month for the same field, **do not write a 4th backfill**. Find the creator script and fix it.

**Why:** On 2026-04-22 the user called out that the null-category bug had been "fixed" by multiple prior sessions. Each session patched the data file. None opened `scripts/discover-new-shows.js` — which had an if/else-if chain with no Broadway else-branch, silently adding every new Broadway show with null category+market. 7+ reactive backfills over the preceding month: `f0a68182` (32 legacy open shows), `e307456f` (109 open shows), `552e59bf` (full 332-show backfill), `5e35adde` (Balusters), `1412ae6a` (Schmigadoon), `17b57c76` (Rocky Horror), `e0fa07f3` (Beaches). Same class of bug, same field, every week.

**How to apply:**
- Grep commits: `git log --oneline --since="1 month ago" -- <file> | grep -iE "backfill|missing|set.*=.*null"`. 3+ matches = creator bug.
- Find writers: `grep -rn "\.<field>\s*=" scripts/` and `grep -rn "fs\.writeFileSync.*<file>\|data\.shows\.push\|<entity>\.push" scripts/`.
- Look for `if/else-if` chains missing a default branch. Broadway/main-market was the unspoken default — implicit defaults are where bugs hide.
- Secondary: if `validate-data.js` or equivalent only **warns** instead of **errors** on missing fields for shows in early states (previews/upcoming), upgrade warn→error. The warning ships the bug into prod; the error at `status=open` fires too late.
- Third: extract classification/derivation to `scripts/lib/<name>.js` and `require()` it in a test. Regex-based structural tests are gameable — a later refactor to a helper silently bypasses them. See CLAUDE.md §15.
