---
name: feedback_freeze_tony_audience_grades
description: Historical-prediction metrics must freeze their inputs; live audience data drift silently re-ranked closed Tony seasons and moved published accuracy
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 21cb4d13-fdba-419d-8e46-003a5f412e3a
---

A published Tony-prediction accuracy figure (93%) reverted to 90.7% overnight with no code change. Root cause: `computeTonyAudienceGrade()` read live `data/audience-buzz.json` for ALL seasons, and the `update-mezzanine` cron refreshes audience scores even for shows closed years ago. A single Mezzanine point on Kimberly Akimbo (78→77) dropped its Tony audience grade 82→81.5, which — on a **0.17-point** margin — flipped the 2022-23 Best Musical pick to Some Like It Hot and dropped in-sample accuracy 40/43→39/43.

**Why:** any metric that recomputes a model over HISTORICAL/closed entities at build time will wobble as upstream live data drifts. New 2026 ratings of a 2023 show are irrelevant to the 2023 Tonys, yet they silently re-rank that season and move the headline number. The track-record hero/grid recompute live (`getSeasonSummary`), so the committed `tony-loso-stats.json` disclosure (also live-derived, but snapshotted at tuning time) can disagree with the grid — even claiming LOSO > in-sample, which is nonsensical.

**How to apply:**
- For predictions over completed/closed periods, FREEZE the model inputs once the period ends. Fix: `data/tony-frozen-audience-grades.json` + `computeTonyAudienceGrade()` returns the frozen value for completed-season nominees; current season stays live until it completes, then `npx tsx scripts/freeze-tony-audience-grades.ts` snapshots it (freeze-once; seed from the OLDEST snapshot in git history, closest to ceremony — not drifted live data).
- When a "X%" headline reverts with no code change, check whether the metric is recomputed live over data that crons keep refreshing. `git log` the data repo (e.g. `audience-buzz.json`) around the regression window; diff the specific entity's score. The data repo truncates history — use `git log --all --reverse` to reach pre-graft snapshots.
- Treat any model result that hinges on a sub-point margin in one historical cell as fragile/overfit, not as a stable claim. See [[project_tony_predictions_accuracy]] and [[feedback_in_sample_accuracy_claims_need_loso]].
