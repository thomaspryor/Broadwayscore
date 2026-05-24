---
name: nonprofit-venue-vs-production
description: nonprofitOrg tags the producing nonprofit, NOT the venue owner. Commercial rentals at nonprofit-owned theaters (Hayes, Friedman, Vivian Beaumont, Todd Haimes) must NOT get a nonprofitOrg tag — they're commercial productions.
metadata:
  type: feedback
---

Some nonprofit Broadway institutions own theaters they sometimes rent to fully commercial productions. The nonprofit gets an "in association with" landlord credit, but is NOT a producer. These shows are economically commercial — they carry full commercial cap stacks, the nonprofit has no producer role, recoupment is owed to investors.

**Venues + their nonprofit owners (Broadway only):**
- Vivian Beaumont Theater → Lincoln Center Theater (LCT)
- Samuel J. Friedman Theatre → Manhattan Theatre Club (MTC)
- Todd Haimes Theatre (formerly American Airlines) → Roundabout Theatre Company
- Helen Hayes Theater → Second Stage Theater (2ST)

**The trap:** A production at one of these venues LOOKS like a nonprofit production (nonprofit name appears on Playbill credits) but may actually be a commercial rental. Tagging it with `nonprofitOrg` overstates the nonprofit's role and corrupts /biz capital-at-risk math via the `data-commercial.ts:238` filter (enhancement deals are now included but pure-commercial rentals shouldn't carry a nonprofit tag at all).

**Why:** Caught 2026-05-24 on `purpose-2025` and `job-2024`. Both at the Hayes (2ST's house) — 2ST credited "in association with" landlord-only. `purpose-2025` was a Steppenwolf/David Stone commercial transfer (Stone/Platt/LaChanze/Universal/Nederlander/Gore/ATG/Shubert cap stack); `job-2024` was Hannah Getts/P3/Jeffrey Richards + 20 commercial co-pros. Tagging either as 2ST production would have been wrong.

**How to apply (audit methodology):**
Before assigning `nonprofitOrg`, verify the production is actually OF that nonprofit by checking AT LEAST ONE of:

1. **Season announcement** — the nonprofit's own website lists the show as part of an announced subscription season (e.g. `manhattantheatreclub.com/shows/24-25-season/{slug}`, `lct.org/shows/{slug}`, `roundabouttheatre.org/get-tickets/2024-2025/{slug}`, `2st.com/shows/{slug}`). If the show isn't on the nonprofit's season page, it's a rental — skip the tag.
2. **Playbill credit-line lead** — the nonprofit "presents" or "produces" (lead position), not "in association with" / "by special arrangement."
3. **Wikipedia/Playbill explicit denial** — phrases like "not part of [Nonprofit]'s season" or "commercial rental" → rental.

**Strong signals of a commercial rental (NOT nonprofit production):**
- Open-ended run with multiple extensions and big weekly grosses
- Heavyweight commercial lead producers named ABOVE the nonprofit (David Stone, Cameron Mackintosh, Marc Platt, Sonia Friedman, ATG, Nederlander, Shubert Organization, John Gore)
- Star-driven Steppenwolf / West End / Williamstown transfer
- The nonprofit ONLY appears as "in association with" near the end of the credit line

**Pure nonprofit / enhancement signals:**
- Nonprofit's name leads the credit ("Manhattan Theatre Club presents...")
- Limited engagement matching the nonprofit's typical run length (~8-13 weeks)
- "By special arrangement with [Commercial Producer]" — that's enhancement (nonprofit IS still the producer)
- Listed on the nonprofit's announced season

**Validator check (added 2026-05-24, scripts/validate-data.js):** Warns when `nonprofitOrg` is set but the show's venue doesn't match the nonprofit's known house(s). Catches inverse problem (Liberation had nonprofitOrg=Roundabout but venue=James Earl Jones Theatre, commercial). Does NOT catch the rental-at-correct-venue case — that still requires manual season verification.

**Related:** productionType='enhancement' now feeds into `data-commercial.ts:238` so enhancement deals count in /biz stats. Commercial rentals at nonprofit venues should NOT carry productionType='enhancement' OR nonprofitOrg — they're just commercial productions.
