---
name: Opening night broadcast quality bar
description: "≥1 more review than BWW RR; send 7-9am next morning."
type: feedback
---

**Broadcasts are sent manually by Tom.** The opening-night-broadcast.js script is run to create the Resend draft, but Tom reviews and clicks Send himself. Automated send-on-trigger was tried previously and produced too many errors — do not propose re-automating the actual send.

**Editorial quality bar (warning, not hard block):**
Send the broadcast in the 7am–9am window the morning after opening. At send time, have **at least 1 more review than the BWW Review Roundup article cites**. If we'd be at parity or under, that's a heavy flag/warning — not an automatic block. Tom decides whether to send anyway.

**Why:** The site's positioning is "the most comprehensive Broadway scorecard." If a subscriber clicks through and could find more critics on BWW Review Roundup, the value prop collapses. The +1 vs BWW RR is the editorial proof point.

**How to apply:**
- Don't recommend score-floor gates. Drift after send is fine — Dog Day going 60→54 post-broadcast is not a reason to gate.
- Don't recommend higher review-count minimums. 16 reviews can be enough; some smaller shows genuinely have fewer in the first 12 hours.
- BWW RR comparison should warn loudly, not block. Tom is the human in the loop.
- Current `scripts/send-opening-night-broadcast.js` uses fixed minimums (12 / 3 T1 / 3 T2 / 8 high-confidence) and does NOT compare to BWW RR. A future feature would surface the comparison as a warning in the dry-run output.

**Related but separate rule (Opening Night PROCESS, not broadcast):**
Every review from the BWW RR page AND every review from the DTLI page must be scored and live on the site before opening night is "complete." See `feedback_opening_night_review_completeness.md`.
