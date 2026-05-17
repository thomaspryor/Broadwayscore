---
name: Local LLM rescore must set GITHUB_ACTIONS=1 to checkpoint
description: scripts/llm-scoring/index.ts gitCheckpoint() early-returns on local runs; bulk rescores get clobbered by parallel workflows pulling data/review-texts/
type: feedback
originSessionId: 826a3b12-cf5c-4349-98f6-03fc85feb606
archived: true
---
When running `scripts/llm-scoring/index.ts --rescore --ensemble` locally on >50 reviews, **export `GITHUB_ACTIONS=1`** in the subprocess env. Otherwise `gitCheckpoint()` (line 413) early-returns and writes never get committed during the multi-hour run. Parallel workflows running `git pull --rebase=true -X theirs origin main` on `data/review-texts/` (a separate git repo) will silently overwrite uncommitted working-tree changes, blowing away the rescore output.

**Why:** `data/review-texts/` is itself a git repo (the private `broadway-review-texts` clone in-place). Multiple workflows pull-rebase it concurrently. With `-X theirs`, my uncommitted v5.4.0 scores got replaced by remote's v5.3.0 scores during the pull's checkout phase. Lost ~1,711 of 1,716 successfully-scored reviews from a 2026-04-29 rescore (~$65 of API spend). Only the last 5 — written after the most recent parallel pull — survived.

**How to apply:**
- For local bulk rescores >50 reviews, **always** set `GITHUB_ACTIONS=1` so checkpoints fire every 50.
- Sample command: `cd /Users/tompryor/Broadwayscore && set -a && source .env && set +a && unset OPENROUTER_API_KEY && GITHUB_ACTIONS=1 nohup npx ts-node --project scripts/tsconfig.json scripts/llm-scoring/index.ts --rescore --ensemble ... &`
- Verify checkpointing fires: tail the log for `📌 Checkpoint: committing N/M scored reviews...` lines every 50 reviews.
- Don't rely on filesystem-level write durability for `data/review-texts/` — parallel pulls reset it.
- Related memory: `feedback_reset_rsync_wipes_ci_fields.md` (the broader pattern of CI workflows clobbering uncommitted work).
