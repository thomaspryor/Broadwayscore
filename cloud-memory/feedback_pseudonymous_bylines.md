---
name: feedback-pseudonymous-bylines
description: "Bloggers who publish under initials/pseudonyms get inconsistent names invented by scrapers; \"multi-author\" audit flag is the wrong fix"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: adc9edd6-a29b-42e3-a8c6-e105272e7e77
---

When an outlet's audit shows ≥3 distinct critic bylines, it can be **rotating bylines** (true multi-author) OR **a single pseudonymous critic whose name was guessed differently by different scrapers**. Setting `multiAuthor: true` is correct for the first, wrong for the second.

**Why:** 2026-05-23 jks-theatre-scene: audit flagged it multi-author-confirmed because Show Score had recorded the same blogger as "Jeff Kyler" (9 reviews) and "Jeff Kready" (3 reviews) + 1 garbage. WebFetch on the source blog confirmed: the author publishes pseudonymously as just **"JK"**. Neither Kyler nor Kready is verifiable. Show Score (or its upstream) invented both names trying to humanize an initials-only byline. The right canonical attribution would be "JK" (matching source) — not "Jeff Kyler" (the dominant audit attribution) or "Jeff Kready" (the registry default).

**How to apply:**
- Before bulk-renaming "multi-author" audit hits to a chosen byline, **WebFetch one canonical URL** for that outlet and read the actual byline. If the source uses initials/a pen name, it's NOT rotating bylines — it's a single pseudonymous critic with scraper-driven name drift.
- For pseudonymous outlets: `multiAuthor: true` blocks the wrong-name auto-fill (good) but leaves the inconsistent historical attributions unchanged. The proper fix is a separate canonical-pseudonym sweep (`defaultCritic` → the actual pen name + all historical reviews normalized).
- Symptom check: audit shows ≥3 critics, distinct critics are spelling/format variants of each other (Kyler/Kready, JK/J.K., "Bob Smith"/"Robert Smith"), and source URL byline is short/initials/handle.
- See [[feedback_outlet_registry_dual_repo]] for the registry edit pattern when adding `multiAuthor` or normalizing `defaultCritic`.
