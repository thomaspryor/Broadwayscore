---
name: transfer-production-reviews-get-fp-excluded
description: Reviews of a prior run that transfers (not a revival) get false-flagged wrongShow by CV pre-pass and generic-URL guard
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f490de5e-8aa8-4c3b-8fcf-eb1525c456e9
---

When a production **transfers** (same production, new venue/run — NOT a revival), the prior run's critic reviews are legitimately attached to the new show entry (`isRevival:false` + `priorRuns`). But two guards false-exclude them, so we under-count vs Show-Score.

**Music City off-Broadway 2026 (2026-06-15):** transfer of the 2024 Bedlam production (same dir Eric Tucker, original cast returning). Show-Score aggregated 3 critic reviews; we showed 1. The other 2 were on disk, scored, but FP-excluded:
- **TheaterMania (Z. Stewart)** → `wrongShow:true` from the **CV pre-pass LLM** ("preview article, lacks critical evaluation") — but the text is plainly evaluative.
- **Lighting & Sound America (D. Barbour)** → `wrongShow:true` from the **generic-URL guard** ("Generic homepage URL, not a review-specific URL") because the URL is `story.asp?ID=LUWYAU`. Query-param article IDs look like homepages to the guard.

**Why:** both guards optimize against pre-opening preview/news noise, but transfer reviews are old (prior run) and from quirky-URL outlets, so they trip both. The CV "preview article" verdict and the generic-URL heuristic are the two repeat offenders.

**How to apply:**
- When a show shows fewer critic reviews than Show-Score, FIRST check `~/broadway-review-texts/{id}/` (and `data/review-texts/{id}/`) for files flagged `wrongShow`/`wrongProduction` with `contentTier:invalid` — they're often real reviews already scored.
- Recover via the 8 protection fields ([[feedback_manual_review_protection_fields.md]]) incl. `allowEarlyDate:true` (prior-run dates are months before opening).
- **Two clones exist**: rebuild reads `data/review-texts/` (a real dir, NOT a symlink), but both it and `~/broadway-review-texts/` are git clones often 600+ commits behind origin. Don't push reviews.json from a stale clone — it clobbers the whole corpus. Edit the origin/main version of the file, commit via `gh api` ([[feedback_gh_api_emergency_commit.md]]), then trigger `rebuild-fast.yml` (fresh checkout, no re-classification) to regenerate + deploy.
- `rebuild-fast` is correct for corrections because it does NOT re-run the CV/flagging that caused the FP. The full `rebuild-reviews.yml` re-classifies; protection fields must survive it.
