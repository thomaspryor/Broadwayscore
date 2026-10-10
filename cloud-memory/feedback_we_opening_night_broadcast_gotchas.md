---
name: feedback_we_opening_night_broadcast_gotchas
description: "West End opening-night email — market-aware gate, OWE leak, Resend name cap, \"tonight\" copy, CLI draft-only ops"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7fc18b1f-6174-4c6a-b243-9b51c71e27b1
---

Operational gotchas for the West End opening-night broadcast, learned shipping the WE auto-draft pipeline + a combined weekly roundup (2026-06-29).

**Why:** WE show-open emails had never gone through the automated Resend-draft pipeline — they were sent manually out-of-band. Several subtle traps blocked it and bite anyone touching this subsystem.

**How to apply:**
- **WE readiness gate must NOT require a DTLI/BWW aggregator thumb.** Those are Broadway-only aggregators; WE reviews are LLM-scored (`anchored-v6`/`llm-v6`) and carry no `dtliThumb`/`bwwThumb`. The old workflow gate `aggCount < 1` silently excluded *every* WE show. Gate logic lives in `scripts/lib/broadcast-readiness.js` (`evaluateBroadcastReadiness`): Broadway = 15 reviews + aggregator; West End = 12 reviews, NO aggregator. WE median is ~16 scored reviews vs Broadway ~29.
- **`isLondonMarket(category)` returns TRUE for `off-west-end`.** Any WE-market code path that gates on `isLondonMarket(s.category)` will sweep OWE shows (Globe/fringe/kids — 60+/quarter) into WE output. Use exact `category === 'west-end'` for WE-subscriber-facing filters (mirrors the Broadway off-broadway exclusion). Applied in both `findRecentlyOpenedShows` and `broadcast-readiness.js`. WE subscribers did not opt into OWE. See [[feedback_off_broadway_opening_date_gap]].
- **Resend broadcast `name` field caps at 70 chars** (HTTP 422). Listing every title overflows once several shows coalesce. Use `buildBroadcastName()` — falls back to "<Site> opening night — N shows".
- **Multi-show headline must not say "Opened Tonight."** A roundup coalesces shows that opened across several days. `email-templates.js` H1 now mirrors the subject's market-aware location: "N Shows Opened in the West End / on Broadway — The Reviews Are In".
- **Create a draft from the CLI with ZERO emails:** `OWNER_EMAIL="" node scripts/send-opening-night-broadcast.js --market=west-end --shows=A,B --force-create-draft`. The `/broadcasts` POST only creates a draft (no send); suppressing OWNER_EMAIL skips the owner-notification transactional email. `--force-create-draft` bypasses the script's internal 3-T1/2-T2/6-hi-conf quality gate (still draft-only). User reviews + sends from Resend UI. See [[email-broadcast-rules]].
- **`--recreate-draft` only deletes the draft for the SAME broadcastKey.** Changing the `--shows` set changes the broadcastKey, so the prior draft is NOT deleted — it's orphaned live in Resend. Delete it explicitly (a `# BROADCAST_AUTHORIZED_BY=<name>` inline-marker `curl -X DELETE .../broadcasts/<id>` is allowed past the block hook for a user-authorized one-off; a draft DELETE never sends).
- **CLI draft path does NOT sync `opening-night-sent.json` to origin** (only the `--send-to` preview path calls `syncTrackerToOrigin`). After a CLI draft, force-add + commit + push `data/opening-night-sent.json` yourself or the 12:30 UTC cron will create a duplicate draft.
