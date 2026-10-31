---
name: ORCHESTRATOR_PAUSED variable does NOT pause opening-night-broadcast.yml
description: "Broadcast auto-fires on workflow_run; disable workflow or mark completed."
type: feedback
originSessionId: c8626b9f-b070-46d1-b345-ffcb9dfc6462
---
The `ORCHESTRATOR_PAUSED` GitHub variable only pauses `opening-night-orchestrator.yml`. It does NOT pause `opening-night-broadcast.yml`.

The broadcast workflow has its own independent triggers:
```yaml
on:
  workflow_run:
    workflows: ["LLM Ensemble Score Reviews"]
    types: [completed]
  workflow_dispatch:
```

So every time the LLM scoring pipeline finishes — which can happen via gather-reviews → rebuild → score, or via the daily 5 AM UTC cron, or via manual dispatch — the broadcast workflow auto-fires. When it does, it sends a preview email to OWNER_EMAIL (currently thomas.pryor@gmail.com) via Resend transactional. This happens whether or not the orchestrator is paused.

**Why:** Pausing the orchestrator gives operators a false sense of safety. They think "I've stopped opening night automation" but the broadcast pipeline keeps going. Two failure modes compound: (1) UTC-day dedup keys let same-evening duplicates through (see feedback_utc_date_keys_for_dedup.md), and (2) local CLI runs of the script don't commit/push the tracker, so the workflow's next run reads stale state.

**How to apply:**
- If you need to fully stop opening-night email sends, you must EITHER:
  - Disable the broadcast workflow: `gh workflow disable "Opening Night Broadcast"` (re-enable later — kills future openings if forgotten)
  - OR mark the specific show as `completed: true` in `data/opening-night-sent.json` on origin/main, which makes the workflow's pending_shows filter (line 203) exclude that show. Workflow stays alive for OTHER shows. This is the surgical fix.
- For multi-show pause (e.g. an emergency stop), use the workflow disable. There's no per-workflow pause variable yet.
- Do NOT assume `gh variable set ORCHESTRATOR_PAUSED true` stops anything other than the orchestrator.

**Repeat offense context:** This was learned during the 2026-04-10/11 duplicate-email incident where the DoaS postmortem session paused the orchestrator thinking that was sufficient, then the broadcast workflow auto-fired twice anyway (12:16 UTC Apr 10 + 12:21 UTC Apr 11), sending duplicate previews + 2 overdue alerts. Containment fix was marking DoaS completed:true. Real fix is the dedup card 33f637c5-416f-81bf-a494-cfcfaee99491.

**See also:**
- `feedback_utc_date_keys_for_dedup.md` — the dedup bug that compounds with this
- `memory/email-broadcast-rules.md` — broadcast safety rules
- `memory/hotfix-rollback-apr12.md` (local only, gitignored) — rollback procedure created during this incident
