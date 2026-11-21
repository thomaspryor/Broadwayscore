---
name: manual-stub-bypasses-validation
description: "When a user asks for shows to be added by name, NEVER stub them into shows.json from memory — venue + dates must come from Playbill/IBDB/Lortel lookup. Manual stubs bypass the discovery pipeline's cross-validation gate."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f614bb18-b7c3-4fc0-8969-fe0774c404d4
---

When a user asks for specific shows by name (e.g. "also add All Nighter, Trophy Boys, The Lonely Few, Shit. Meet. Fan."), **NEVER stub them into shows.json with guessed venue/dates.** That bypasses the cross-validation pipeline that exists precisely to prevent wrong data shipping.

**Why:** Session 2026-05-27 user asked to add 4 OB shows by name. I dropped 4 stubs in shows.json with venue/dates from memory. They shipped to production. Later audit revealed:
- Shit. Meet. Fan. — venue WRONG (had Audible Minetta Lane, actually MCC)
- All Nighter — year WRONG (had 2024, actually 2025)
- Trophy Boys — year WRONG (had 2024, actually 2025)
- The Lonely Few — dates WRONG (had March 2024, actually May 2024)

The discovery + validation pipeline (`scripts/promote-ob-venue-candidates.js` + `scripts/lib/ob-cross-validation.js`) has a gate that requires cross-validation against Playbill OB + Lortel before promoting to shows.json. I bypassed it by manually adding entries.

**How to apply:**
- When user names shows to add: **run a venue/date lookup script FIRST.** Use `scripts/discover-playbill-urls.js` to find each show's Playbill production page; fetch that page; parse venue + opening + closing dates from the structured fact box.
- If the lookup fails or returns conflicting data, ask the user — don't guess.
- Even when adding shows that aren't on Playbill, evidence the dates from a primary source (review URLs containing publish-date are the easiest: an NYT review URL `/2025/03/10/theater/...` means the show ran around that date, not the date you guessed).
- Manual stub entries should carry `provisional: true` + `discoverySource: 'manual-*'` and the next cron tick should fail loud if a future `validate-show-venue` finds a mismatch.

Related: [[ob-discovery-expansion]] (the pipeline that has the gate that was bypassed), [[ob-venue-historical-backfill]] (the next-session work that should include the validator).
