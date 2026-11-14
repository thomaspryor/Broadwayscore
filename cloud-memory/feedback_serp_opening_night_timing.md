---
name: SERP indexing timing for opening night
description: Google indexes Broadway reviews from major outlets no earlier than 2.9h after publication — measured from Giant and Proof opening nights
type: project
originSessionId: 28bfb149-b89e-4783-9803-7204bba09c7c
---
SERP is not useful in the first 3 hours after an opening night embargo lift. Measured from Giant (2026-03-24) and Proof (2026-04-17): fastest observed SERP discovery was 2.9h post-publication for major outlets (NYT, Variety, Vulture, THR, Post, Daily News, Sun). Median for top outlets is 3–11h.

**Why:** Google News crawls major publishers frequently but review pages still need to be indexed and ranked before a `site:domain "title" review` query returns them.

**How to apply:** The opening-night-poller.js SERP gate is set to 3h after `show.openingDate`. Don't reduce this below 3h. After the gate, every-2h interval is sufficient — reviews trickle in over hours, not minutes. SERP state file: `data/collection-state/serp-last-run-{showId}.json` (CI-ephemeral, not persisted across runs).
