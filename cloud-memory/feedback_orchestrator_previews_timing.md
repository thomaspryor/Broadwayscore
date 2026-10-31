---
name: Orchestrator fires before status update — misses previews shows on opening night
description: "10 PM UTC fires before 8 AM UTC status update; include passed-openingDate previews."
type: feedback
archived: true
---

The opening-night-orchestrator runs at 10 PM UTC but update-show-status (which transitions previews→open) runs at 8 AM UTC the next day. On opening night, shows are still 'previews' when the orchestrator fires.

**Why:** Kinky Boots opened 2026-03-29 but the orchestrator skipped it because status was 'previews'. Zero reviews captured on opening night.

**How to apply:** Fixed in orchestrator filter — now includes 'previews' shows whose openingDate <= now. If adding new workflows that filter by show status, always consider the previews→open timing gap.
