---
name: awards-tie-cowinners-dropped-at-scrape
description: "Year-page award scrapers captured only ONE winner per category, silently dropping tie co-winners (DD 2026 Lead Musical: Caissie Levy lost, both Henry+Levy@Ragtime). Same-show ties lose the 2nd name entirely; a prior pass even \"corrected\" the real tie away as a misread."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c11b4c72-6848-4132-8803-22c8eb63a7d6
---

User feedback (Nick, 2026-06-02) flagged that Caissie Levy was missing from Ragtime's 2026 Drama Desk Outstanding Lead Performance in a Musical — she co-won (a tie) with Joshua Henry. Root cause: `scripts/lib/year-page-precursor.js` `parseWinnersNomineesCell` took only the FIRST five-quote winner bullet and stopped (`winner === null` guard). Real Wikipedia ties join co-winners with `" and "` between bold-quote runs:
`'''[[Joshua Henry]]''' and '''[[Caissie Levy]]''', ''Ragtime''`. A **same-show** tie (both winners one production) lost the 2nd name entirely and demoted her to a nominee; a **split-show** tie (Lithgow/Giant + Manville/Oedipus) survived only because each lands on a different show id. Worse, a prior session had "corrected" Levy away believing the tie was a flat-list misread — so a wrong human assumption was baked into a test comment.

**Why:** Awards data feeds Tony predictions + show pages; a dropped co-winner is a silently-wrong public claim, and the single-winner-per-category assumption is invisible until someone who knows the result reports it.

**How to apply:**
- Parser now emits `winnerEntries: [{person, show}]` for genuine ties, splitting ONLY on `" and "` flanked by quote-runs (`/(?<=')\s+and\s+(?=')/`). Collaborative single wins (`'''Jen Schriever and [[Michael Arden]], ''Show'''''`) and titles containing "and" ("Joe Turner's Come and Gone") must NOT split — the naive `/\s+and\s+/` split regressed both (caught by parity test, NOT unit tests).
- enrich (`enrich-awards-with-precursors.js`) consumes `winnerEntries` to attribute each person to their paired production directly — no nominee-adjacency / Tony-lookup guessing.
- ALWAYS parity-test awards changes vs a clean re-enrich (origin precursor + origin code), not vs origin's on-disk awards.json (which carries pre-existing CI drift). The clean-baseline diff isolates your true effect.
- Prefer a SURGICAL precursor patch (add `winnerEntries` to just the tie rows) over a full re-scrape: a re-scrape clobbers curated multi-person team names the year-page parser can't reconstruct.
- awards.json is DUAL-REPO and the live build OVERLAYS the private repo copy (`broadway-scorecard-data`) via `checkout-core-data` in `vercel-deploy.yml`. Fix BOTH repos. `update-precursor-awards.yml` only commits the web repo and runs Mondays/Apr-May — it does NOT auto-push the private repo, so a web-only fix never reaches production. See [[feedback_awards_json_dual_repo]] and [[feedback_awards_enrichment_scoring_decoupled]].
- CI gotcha: a same-commit test asserting awards content can fail on a RACE if the private-repo overlay hasn't been pushed yet (test reads the overlaid copy). Push the private repo BEFORE (or same minute as) the web push, or expect to re-run CI after.
