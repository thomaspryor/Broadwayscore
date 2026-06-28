---
name: feedback-newsletter-manual-send-data-lag
description: "For a manual weekly-newsletter send, local data and slim score files lag production — sync/rebuild before generating, and commit the de-dup state from the FINAL run"
metadata:
  node_type: memory
  type: feedback
---

When generating the weekly newsletter for a **manual** send (not the Saturday
cron), local data lags production and will silently ship stale or non-canonical
scores. Two distinct lags, both bit hard on 2026-06-28:

1. **Private data repo** (`~/broadway-scorecard-data`, symlinked into `data/*.json`)
   is often hours/commits behind origin. `reviews.json` updates there continuously
   via CI. Symptom: The Truth / Archduke showed pre-rebuild critic scores.
2. **Locally-generated slim score files** `public/data/shows/<id>.json` (NOT a
   symlink — written by a local rebuild, `.cs`/`.rc` = canonical critic score +
   count) lag even further. `generate.mjs` reads `.cs` via `loadCompositeScore`;
   if `.cs`/`.rc` are missing/stale it **falls back to a raw-mean of reviews.json**,
   which diverges from the site (Pride rendered 85 vs canonical 83). The cron is
   safe (a <24h rebuild gate keeps slim files fresh); only manual local runs hit this.

**Before a manual generate:**
- `git -C ~/broadway-scorecard-data pull --ff-only`
- For every scored show in the issue, sync its slim file from prod
  (`curl -s https://broadwayscorecard.com/data/shows/<id>.json > public/data/shows/<id>.json`)
  or run a full rebuild. Verify `Math.round(cs)` per show matches prod before trusting the draft.

**De-dup state gotcha:** `generate.mjs` rewrites `data/newsletter-state.json` on
**every** run — including throwaway `NEWSLETTER_OUT_DIR=/tmp` probes. So the
committed de-dup row for the week must come from the FINAL run whose content
matches the sent email, else next week repeats this week's mover/featured shows
(2026-06-28: committed row still had mover=Pied a Terre after the real mover was
Girl Interrupted). Always regenerate with the exact sent overrides, confirm the
`2026-06-XX` row, then commit `data/newsletter-state.json`. Note the state write
runs **before** `londonSection()`, so West End openings are never recorded for
de-dup (harmless today — WE openings are date-bound).

**Editorial overrides** (env vars, all optional): `SUBJECT_OVERRIDE`,
`LEDE_OVERRIDE`, `NEWSLETTER_OB_LEAD=<showId>` (floats one OB opening to lead).
Show names in the lede italicize automatically (exact canonical titles) or via
`*asterisk*` markers for short forms ("Henry VI", "Sinatra"). Subject stays plain.

Related: [[feedback_newsletter_resend_broadcast_draft]], [[feedback_critic_score_canonical_helper]].
