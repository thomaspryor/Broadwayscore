---
name: Rebuild has two independent wrong-production checks
description: "Date guard + director audit are independent; fix both when clearing."
type: feedback
archived: true
---

rebuild-all-reviews.js has two independent wrong-production detection systems:
1. **Pre-opening date guard** — flags reviews >90 days before show's earliest date
2. **Director mismatch audit** (audit-wrong-production.js) — flags reviews mentioning a director from a different production of the same show

**Why:** Op Mincemeat reviews were cleared by fixing the date guard but immediately reflagged by the director audit because the WE entry had no creativeTeam data (empty array → shared director treated as "other production's director").

**How to apply:** When fixing wrongProduction issues, check BOTH guard systems. If a show shares creative team across markets (same director for WE and Broadway), ensure both entries have the creativeTeam populated.
