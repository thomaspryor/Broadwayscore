---
name: LLM scoring needs calibration anchors
description: "GPT-4o needs reference anchors or all scores cluster; use scale extremes."
type: feedback
archived: true
---

When using an LLM to produce numeric ratings across many items, the model defaults to safe middle scores with almost no differentiation.

**Why:** GPT-4o anchors to "reasonably good" for everything unless forced to use the full scale. First run of theater venue scores: 83% of sightlines were 4, 93% of sound were 4, 86% of ambiance were 5.

**How to apply:** Always include calibration anchors in scoring prompts — name specific items that should score at the extremes (e.g., "Marquis comfort = 5 because best legroom on Broadway, Broadhurst comfort = 1 because worst"). Also include explicit scale definitions (what does each number mean) and a warning not to cluster. Plan for a calibration pass after the first batch to normalize drift.
