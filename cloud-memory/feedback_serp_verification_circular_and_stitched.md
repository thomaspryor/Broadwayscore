---
name: feedback_serp_verification_circular_and_stitched
description: "SERP-based fact verification has two silent false-confirm modes — Google stitches unrelated page fragments into one snippet, and Google indexes OUR OWN wrong data (circular verification); Giulia hallucinated team survived both"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2e960e48-ba82-4126-985b-01b49b17c9d6
---

While retro-auditing hallucinated creative teams (2026-07-09, Giulia PAC NYC carried "Stefano Massini/Ludovico Einaudi" instead of Jennifer Nettles/Mary Zimmerman since ~Feb 2026), two failure modes let fake facts pass SERP verification:

1. **Snippet stitching:** Google joins disjoint page fragments with "…". A 1991 NYT dance review crediting "music by Ludovico Einaudi" + a sitewide events module mentioning "Giulia: The Poison Queen of Palermo" on the same page produced one snippet that contained both the attribution phrase and the show title.
2. **Circular verification:** broadwayscorecard.com's own wrong page (and mirrors that scrape us) rank in the SERP for `"<show>" "<name>"`, so our hallucination confirms itself. Opus adjudication repeatedly identified "the only source is broadwayscorecard.com" as the tell.

**Why:** phrase-in-snippet checks look airtight but validate co-occurrence on a PAGE, not attribution in a STATEMENT. Any verification loop whose corpus includes our own published output can self-confirm.

**How to apply:**
- Use `serpTextConfirms()` from `scripts/lib/creative-team-verify.js` (splits snippets on ellipses; requires the attribution phrase in the same segment as a title token, or the page title naming the show; normalizes curly quotes/dashes per [[feedback_word_boundary_punct_titles]]).
- Never auto-delete on a SOFT signal: zero SERP results can be a cached provider soft-failure (`[]` cached 24h in serp-cache — see [[feedback_fetchpage_gotchas]]). Deletion requires positive counter-evidence via LLM adjudication (Opus, per [[feedback_opus_for_classification]]) — `scripts/audit-creative-team-serp.js --adjudicate --fix`, which also has a >50% circuit breaker.
- When adjudicating, tell the model our own domain may mirror the bad data so it discounts it.
- Retro-audit pattern: entries written before a guard existed carry no provenance tag (`_source`) — filter on its absence to find them.
