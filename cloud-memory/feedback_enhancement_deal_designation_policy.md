---
name: enhancement-deal-designation-policy
description: Enhancement-deal entries (nonprofit shell + commercial co-producers) require HARD trade-press citation to claim Easy Winner / Flop / Fizzle designations. Indirect signals (early closing notice, soft grosses, short run) are NOT sufficient — default to designation=Nonprofit + recouped=null when no citation exists.
metadata:
  type: feedback
---

The 2026-05-24 audit produced 16 enhancement-tagged entries in commercial.json. Designations were initially inconsistent — some Flops without hard citations, some Easy Winners with citations, some Nonprofit + recouped=false based on indirect signals. The outcome-driven policy below was applied in commit 12c41d8e (broadway-scorecard-data bb008747).

**The rule (apply to any enhancement-deal entry):**

- **designation = "Easy Winner" / "Windfall" / "Miracle"** — requires explicit Playbill / Variety / THR / Deadline citation that the production recouped its capitalization. `recouped: true` + `recoupedSource` with quoted phrase + `recoupedDate`.
- **designation = "Flop" / "Fizzle"** — requires explicit citation that the production did NOT recoup ("lost money," "failed to recoup," "did not recoup"). NOT enough: early closing notice, soft grosses, capacity decline, short run, weak Tony conversion. Those are indirect signals only.
- **designation = "Nonprofit" + `recouped: null`** — the default when no hard citation exists either way. Most enhancement deals close without disclosing recoupment because the financial structure is opaque (nonprofit shell + enhancement contribution). Don't invent claims.

**Why:** Caught 2026-05-24 when 4 enhancement entries (Camelot 2023, Floyd Collins 2025, Pirates of Penzance 2025, Old Friends 2025) had been tagged Flop or recouped=false from earlier deep-research passes — none had hard citations. Three of them had EXTENDED their runs and/or closed on schedule with strong capacity (91.86% for Old Friends; 4-week extension for Pirates; 6 Tony noms for Floyd Collins). The Flop tag was wrong. Demoting them to Nonprofit + null is honest.

**How to apply (audit checklist):**
1. Web-search the show + "recouped" / "lost money" / "failed to recoup" — needs to be a direct statement, not inference.
2. If hard citation found: capture URL + quoted phrase in `recoupedSource`, set `recouped`, set designation accordingly.
3. If no citation: set `designation: "Nonprofit"`, `recouped: null`, document the indirect signals in notes if they exist (so future audits know what's been considered).
4. Indirect "we think it didn't recoup" notes are fine in `notes` field, but they don't change `recouped` or `designation`.

**Examples from the 2026-05-24 corpus:**

- HARD citation → Easy Winner: ragtime (Playbill: "recouped its Broadway investment earlier this year"), what-the-constitution-means-to-me-2019 (Playbill: "recoups ahead of August final bow," $2.5M cap), appropriate (recoupment via Belasco commercial leg with $20M gross + Tony Best Revival)
- NO hard citation → Nonprofit + null: camelot-2023 (early closing notice doesn't count), floyd-collins-2025 (closed on schedule with Tony noms, no failure citation), pirates-the-penzance-musical-2025 (4-week EXTENSION past original close), stephen-sondheims-old-friends-2025 (two extensions + 91% capacity), my-fair-lady-2018 (long run + national tour suggests recoupment but no Playbill confirmation)

**Validator interaction:** The data-commercial.ts:238 filter now includes enhancement deals in /biz capital-at-risk math (commit 5a3f2e6b0d). Setting recouped=false propagates as a known-loss signal in the season recoupment ratio. Setting recouped=null preserves the show in totalShows count without contributing to either recouped or unrecouped buckets — the honest answer when outcome isn't disclosed.

**Related:** [[nonprofit-venue-vs-production]] (deciding nonprofit-vs-commercial-rental for venue assignment) and [[parallel-worktree-race]] (multi-writer wholesale-replace risk).
