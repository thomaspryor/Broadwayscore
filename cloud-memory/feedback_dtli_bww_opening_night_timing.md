---
name: DTLI and BWW Review Roundup URLs do not exist until opening night itself
description: "URLs don't exist until opening night (~9pm+). Stop pre-staging them."
type: feedback
originSessionId: c8626b9f-b070-46d1-b345-ffcb9dfc6462
archived: true
---
BWW Review Roundup and DTLI (Did They Like It) pages are **published on opening night itself**, not in the days leading up to it. Do not try to "prepare" or "pre-map" these URLs as part of pre-opening checklist work.

**Timeline on opening night:**
- BWW Review Roundup: typically appears around 9 PM ET (after curtain), sometimes later
- DTLI page: appears AFTER BWW RR — DTLI waits until they have "all" the reviews in, which can be well into the night or even the next morning

**Why:** Both aggregators are reactive to the reviews published by critics. They can't publish a "roundup" until there are reviews to round up. DTLI is even more conservative — they wait until multiple critics have posted.

**How to apply:**
- Pre-opening checklists should NOT include "map DTLI slug" or "find BWW RR URL" as items to complete ahead of time. Those are impossible.
- DTLI slug discovery runs AT opening night, once the page goes live.
- BWW RR URL gets supplied manually (via `--bww-roundup-url` flag to the poller) once it's published — usually by the operator watching for it to appear.
- The opening-night-orchestrator handles this correctly: it polls throughout the window and picks up aggregator pages as they publish.
- The CLAUDE.md pre-opening checklist item "DTLI slug mapped" refers to OLDER revival shows where DTLI already has a historical page (e.g. for a 2022 production). For a brand-new opening, there is nothing to map.

**Repeat offense context:** This has been stated to Claude more than once. The fix that keeps sticking is: don't treat DTLI/BWW RR as pre-opening data. Treat them as opening-night-only discoveries.
