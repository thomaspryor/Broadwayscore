---
name: feedback_notion_sentinel_hook_gap_cloud_session
description: "In a headless/cloud session (CLAUDE_CODE_ENTRYPOINT=sdk-cli), notion-brain.js create succeeds but the PostToolUse sentinel hook that unblocks git commit doesn't fire -- manually write /tmp/notion-card-<session_id>"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 14ee170a-b57f-4e5b-82dd-55297f046549
  modified: 2026-08-19T16:44:43.964Z
---

2026-08-19: in a headless/cloud session (env showed `CLAUDE_CODE_ENTRYPOINT=sdk-cli`,
`CLAUDE_CODE_CHILD_SESSION=1`), `node scripts/notion-brain.js create ...` succeeded twice
(confirmed via the `__NOTION_CARD_ID__=<uuid>` marker in stdout/stderr and a real card
returned), but `git commit` still hit `notion-card-required-commit.sh`'s BLOCKED message
both times. Root cause: the PostToolUse hook (`notion-create-verify.sh`) that's supposed to
write `/tmp/notion-card-${session_id}` on a successful `create` never fired -- the sentinel
file was absent even 3+ minutes after two successful creates. `CLAUDE_CODE_SESSION_ID` (env
var) WAS set and matched what the blocking hook enforced against, so this isn't a missing-
session-id fail-open case -- the create-side hook specifically isn't wired up (or isn't
firing) for this session type.

**Why:** Notion itself was reachable and healthy (cards created fine, correct JSON returned)
-- this is a hook-plumbing gap in this specific harness/session type, not a Notion outage the
`notion-card-required-commit.sh`'s own reachability probe would catch and fail open for.

**How to apply:** If `git commit` blocks on "NO NOTION CARD FOR THIS SESSION" after a
`notion-brain.js create` that visibly succeeded (JSON with a real `id`, no REJECTED text),
don't just retry `create` again (wastes a duplicate card + still won't fix it). Instead:
1. Get the session id: `echo $CLAUDE_CODE_SESSION_ID`.
2. Manually write the sentinel with the card id from the successful create's output:
   `echo "<card-id>" > /tmp/notion-card-${CLAUDE_CODE_SESSION_ID}`.
3. Retry the commit.
If you created a genuine duplicate card while diagnosing this, archive the extra one
(`node scripts/notion-brain.js archive <id>`) rather than leaving both open.
