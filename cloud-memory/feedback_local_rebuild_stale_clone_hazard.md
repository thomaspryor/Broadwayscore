---
name: local-rebuild-stale-clone-hazard
description: Never run rebuild-all-reviews.js locally on this machine — it reads the stale data/review-texts clone and has no flag parsing (--help starts a full rebuild)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1f9057e0-7e51-418d-bece-e697ac8cc073
---

**Never run `scripts/rebuild-all-reviews.js` locally on this machine. Rebuild via `gh workflow run rebuild-reviews.yml` only.**

Three stacked hazards, all hit on 2026-07-05:
1. **No flag parsing.** `node scripts/rebuild-all-reviews.js --help` is not a help call — any unknown flag is ignored and a FULL rebuild starts immediately.
2. **Stale input.** The script hardcodes `data/review-texts` (see [[rebuild-ignores-review-texts-dir-env]] in cloud-memory), which on this machine is a second clone that was 1430 commits behind `~/broadway-review-texts`. The rebuild overwrote `reviews.json` (via the symlink into `~/broadway-scorecard-data`) from stale sources — TKAM WE dropped 14→6 reviews, 3300 lines deleted across the file.
3. **SIGPIPE mid-run.** Piping the rebuild to `head` killed it mid-write. Recovery: the damage was uncommitted, so `git -C ~/broadway-scorecard-data checkout reviews.json` restored HEAD.

**Why:** reviews.json is the derived source of truth for every score on the site; a stale rebuild silently regresses hundreds of shows and CI would have propagated it within minutes if committed.

**How to apply:**
- Rebuild: `gh workflow run rebuild-reviews.yml -f reason="..."` then `scripts/lib/wait-for-run.sh <id>` (never `gh run watch` — 3s polling, see [[feedback_github_polling_rate_limit.md]]) — CI checks out fresh canonical repos.
- Never pipe a data-writing script to `head`/`grep` — capture to a file in scratchpad, then filter.
- After ANY accidental local run of a rebuild/enrichment script: `git -C ~/broadway-scorecard-data status` immediately and checkout-restore before anything commits.
- Related: `verify-review-recovery.js` also reads the stale local clone — treat its per-file findings as hypotheses and re-check against `~/broadway-review-texts` (it flagged a file that didn't exist canonically, and named the wrong unscored file).
- Also learned same day: `RESEND_API_KEY` (and other keys) are exported globally in the shell profile — "the worktree has no .env" does NOT mean API calls will fail. Guard dry-run paths in code, not by assuming missing credentials.
