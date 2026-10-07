---
name: Show Score star rating trust rules
description: "Wrong 11% of the time; fallback only, never primary."
type: feedback
archived: true
---

Show Score star ratings have two known problems:

1. **11% error rate** — discovered via audit. Show Score's displayed ratings don't always match the outlet's actual rating.
2. **Extraction reads wrong data** — Playwright reads CSS `--rating` variable (a float like 3.9) instead of counting displayed stars (integer like 3/5). This gives fake precision that doesn't match anything.

**Rules:**
- Show Score star ratings are FALLBACK ONLY — never use if we can collect the rating from the actual outlet page
- The Playwright extraction needs to count displayed stars, not read `--rating` CSS variable
- Never trust a non-integer star rating from Show Score (e.g. 3.9/5 is impossible — they only display whole stars)

**Why:** The Stage review for Teeth 'n' Smiles had `assignedScore: 78` from Show Score's `--rating: 3.9`, but the actual review page clearly shows 3/5 stars (= 60). A 30% score error on a T2 outlet.

**How to apply:** When extracting from Show Score, count filled star SVGs/elements. When scoring, prefer outlet's own `originalScore` over Show Score's rating. Flag reviews where the only score source is Show Score for manual verification.
