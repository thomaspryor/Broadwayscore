# Weekly retro (cloud), one firing

Read by the "Weekly retro (cloud)" routine every Sunday morning ET. It replaces
the Mac's `scripts/local-triggers/weekly-retro.sh` (launchd
`com.bwsc.weekly-retro`). Change the retro here, not in the routine prompt.

No human is watching. Do not ask questions, do not edit code, do not land
anything. The only write is one Linear record issue.

## 0. Setup

In /home/user/Broadwayscore: `git fetch origin main && git checkout -f -B retro-base origin/main`
(retry the fetch with backoff on network errors). Set
`WEEK_START=$(date -u -d '7 days ago' +%F)` and `TODAY=$(date -u +%F)`.

The board is Linear (team BRO). Notion is retired: never use Notion or
notion-brain.js. Query Linear with the repo's client and keep output in a file:

    node -e "require('./scripts/lib/linear-client').graphql(process.argv[1],{}).then(d=>console.log(JSON.stringify(d,null,1)))" '<GraphQL query>' > /tmp/q.json

using `issues(filter: { team: { key: { eq: "BRO" } }, ... }, first: 100)` with
fields `identifier title state { name } priority completedAt createdAt labels { nodes { name } }`.
Read the JSON with `node -e` or `jq`, never by printing it whole.

## 1. Daily digests

Issues whose title contains "Daily Digest" created since WEEK_START. Read each
description and its comments.

## 2. Completed issues

Issues with completedAt between WEEK_START and TODAY. Count them and sort them
into fix, feature, data quality and market expansion from labels and titles.

## 3. Recurring issues

Any label on 3 or more completed fix issues: "Label X appeared on N fix issues
this week: <ids + titles>. Consider a systemic fix."

## 4. Git activity

    git log origin/main --oneline --since='7 days ago' | wc -l
    git log origin/main --since='7 days ago' --pretty=format: --name-only | sort | uniq -c | sort -rn | head -20

## 5. Stale items

Open priority-1 (Urgent) issues still in Todo or Backlog for over 7 days.
Issues In Progress created over 24h ago with no comment in 24h.

## 6. Workflow health

The `gh` CLI is not available in cloud. Use the GitHub MCP tools
(`mcp__github__actions_list`, load with ToolSearch) or curl
`https://api.github.com/repos/thomaspryor/Broadwayscore/actions/runs?per_page=50`
with `Authorization: Bearer $GH_TOKEN`. Report failed scheduled runs in the last
7 days, grouped by workflow, and the latest `check-cron-health.yml` result.

## 7. Outcome quality

For each issue completed this week, flag any whose Outcome comment lacks the
sections "What changed", "Why this approach", "Gotchas", "Discovered work".

## 8. File the record

Write the retro to a temp file in this format:

    ## Week in Review, WEEK_START to TODAY
    ### Velocity
    ### Key Accomplishments
    ### Recurring Issues
    ### Stale P0s
    ### Outcome Quality
    ### Most Active Areas
    ### Priorities for Next Week

Then:

    node scripts/linear-brain.js create "Week in Review, $WEEK_START to $TODAY" --priority 4 --source routine:weekly-retro --park "weekly retro record" --notes "$(cat <file>)"
(The dated title is recorded in data/audit/routine-logs.jsonl, not filed as a card: there is no card to close. BRO-6130)

If Linear is unreachable, print the retro in the reply instead. Do not fall
back to Notion.

## 9. Reply

The issue URL and three plain-English lines: issues closed this week, the one
pattern worth attention, anything stale. End with `SAFE TO ARCHIVE`.
