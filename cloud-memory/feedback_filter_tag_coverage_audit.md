---
name: Audit tag coverage before shipping a filter UI
description: A pill that returns zero shows is broken UX. Run a coverage count for every tag-based filter before shipping — both total and "currently open" subset. Caught Concert/Revue (0 matches) before merge in PR #283.
type: feedback
originSessionId: c013fa2d-00bf-4653-a707-51d9f50b64c7
archived: true
---
Tag-based filters look fine in code review and pass unit tests. They only fail at runtime when no shows match the tag — and the UI happily renders a pill that always returns "0 shows." Embarrassing.

**Why:** PR #283 ship-check (2026-04-26) audited the tag-coverage of every filter pill against `data/shows.json`. Found `concert: 0`, `revue: 0`, `solo-show: 2 (0 open)`, `immersive: 2 (0 open)`, `pulitzer: 1 (Hamilton only)`. Removed 5 filter pills before merge. The right-experience reviewer had also independently flagged sparse-tag filters. GPT-4o reviewer also flagged the data-sparsity trust hit.

**How to apply:**
- Before shipping any tag-based filter, run a coverage count for every tag the UI exposes. Both total matches AND currently-open matches (the open subset is the user's default browse view; if open=0, the filter looks broken).
- Threshold heuristic: ≥3 open matches OR ≥10 total matches. Below that, defer until tags are backfilled.
- Pattern: `node -e "const d=require('./data/shows.json');const s=d.shows||d;const c={};for(const x of s)for(const t of (x.tags||[]))c[t]=(c[t]||0)+1;..."`
- Same applies to award-based filters joining `awards.json` — Pulitzer had 1 entry total, blocked by the same audit.
