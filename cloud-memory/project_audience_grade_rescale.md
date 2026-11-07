---
name: Audience grade rescale (deferred)
description: Gentle rescale of A+/A/A- thresholds in audience-grade-utils.ts, deferred until after 2026 Tony eligibility window closes
type: project
originSessionId: 14871d47-bd97-469e-97f6-098d277e1562
archived: true
---
Planned but deferred: gentle rescale of audience letter-grade thresholds in `src/lib/audience-grade-utils.ts`.

**Why:** Tom noticed the current season's new openings clump at A-. Analysis (2026-04-22) confirmed A- is the plurality bucket for recent openings (27% of 2025-26 season, 7 of 10 April 2026 openings). Two structural issues:
- A is only 2 points wide (88–89) — a near-impossible dead zone
- A- spans 83–87 (5 pts) exactly where new-show audience scores naturally land

**Decision:** Ship the GENTLE version, not the aggressive one. Tom's note: "I don't want to scare away everyone. It's nice to be kind with audience scores."

**Exact change — three threshold numbers in `src/lib/audience-grade-utils.ts` `getAudienceGrade()`:**
- A+ floor: 90 → **92**
- A  floor: stays 88, but range widens from 88–89 to **88–91**
- A- floor: 83 → **84**
- B+ and everything below: **unchanged**

**Impact on open Broadway shows (38):** 7 change tier, 31 stay the same. No one drops more than one notch. No one lands in red.
- 5 shows A+ → A (scores 90.1–91.3)
- 2 shows A- → B+ (Becky Shaw 84.0, Rocky Horror 83.9 — both 0.1 pt from bucket line)
- 6 shows stay A+ (Hamilton, Maybe Happy Ending, Ragtime, Wicked, Hadestown, Just in Time)
- A tier grows from 6 → 11 shows (becomes populated, not a dead zone)

**When to ship:** Week of 2026-04-27, AFTER Tony eligibility window closes (2026-04-27). Don't touch grading mid-Tony-season — risks perceived score movement during awards voting/press coverage.

**How to apply:** Three-line edit in `src/lib/audience-grade-utils.ts`. No companion data migration needed — grades are computed on every render from `combinedScore`. No backfill. Visual QA (design rule §5): capture grade badge before/after at /broadway, /show/hamilton, /show/becky-shaw on mobile + desktop. Consider brief tooltip/copy update if the "dead zone" fix is announced.

**Full analysis:** See session transcript 2026-04-22 "Audience Grade analysis" (saved to Notion card).
