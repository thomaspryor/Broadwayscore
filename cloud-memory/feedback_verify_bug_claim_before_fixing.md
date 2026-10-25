---
name: Verify a postmortem's bug claim with live data before "fixing" it
description: Before writing code to fix a reported bug, spend 10 minutes reproducing it against live data. Postmortem claims written under pressure often misdiagnose the symptom.
type: feedback
originSessionId: 074db50f-1651-4986-98f8-5b1abe14fd3d
---
When a postmortem lists a bug ("the extractor is broken", "the API returns null", "the pipeline silently drops"), **reproduce it live before writing any fix code.** Fetch the real URL, run the real script against real data, and confirm the failure mode. A meaningful share of opening-night postmortem bullets turn out to be transient artifacts (rate limits, propagation delay, pre-reviews snapshots), NOT structural breaks.

**Why:** Session 1 of the Beaches+RH postmortem (2026-04-24) listed "Show Score HTML extractor returning 0 reviews. Page loads (58KB), DOM selectors broken. Silently breaking EVERY open show right now" as a P1. 10 minutes of live fetching against 4 open shows (DoaS 8 critics, Giant 8, Beaches-correct-URL 8, Rocky Horror 2) proved the extractor was healthy; Rocky Horror only HAD 2 critic tiles at the time. The "0 reviews" log in the postmortem was a transient rate-limit response. Had I gone straight to "fix the DOM selectors", I'd have shipped unnecessary churn, possibly introduced a real bug, and wasted ~2h of session time.

**How to apply:**
- For any "X is broken" postmortem claim, the FIRST step is: curl / fetchPage / node script against live data. 5-10 minutes of reproduction saves 1-2 hours of cargo-cult fixing.
- If the live data shows the system works: document WHY the postmortem saw the failure (rate limit, propagation, cache), note in Notion card outcome, move on.
- If the live data confirms the break: THEN write the fix, with confidence you're fixing the right thing.
- Extra hazard on opening-night postmortems: the writer was under pressure at 1 AM and may have conflated two issues. Reproduce independently.

**Related:**
- memory/feedback_live_api_contract_test.md — live API behavior over unit tests.
- memory/feedback_verification_gate_hook.md — broader verification-before-claiming rule.
