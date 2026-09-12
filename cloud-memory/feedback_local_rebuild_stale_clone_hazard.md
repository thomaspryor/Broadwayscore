---
name: local-rebuild-stale-clone-hazard
description: Never run rebuild-all-reviews.js locally on this machine — it reads the stale data/review-texts clone and has no flag parsing (--help starts a full rebuild)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1f9057e0-7e51-418d-bece-e697ac8cc073
  modified: 2026-09-11T19:32:15.678Z
---

**Never run `scripts/rebuild-all-reviews.js` locally on this machine. Rebuild via `gh workflow run rebuild-reviews.yml` only.**

**`scripts/gather-reviews.js --shows=X` is NOT safe either — it auto-chains into a full local `rebuild-all-reviews.js` as its final phase**, even when scoped to one show (confirmed 2026-08-03, task #814). It silently modified ~45 unrelated review-texts files (stripping `wrongProduction: true` flags) and dropped a live scored review from `reviews.json` on a routine single-show discovery run. After ANY `gather-reviews.js` run: `git -C ~/broadway-review-texts status --short` and `git -C ~/broadway-scorecard-data status --short` before committing anything — `git checkout -- .` / `git checkout -- reviews.json` to discard the rebuild fallout, then separately `git add` only the specific new-show files you intended to create.

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

**Single-file scripts that legitimately DO need to run locally** (e.g. `ingest-review-from-url.js`, per a card's own suggested-approach command) still hit this same `data/review-texts` hardcode — but the failure MODE differs by checkout (BRO-462, 2026-09-11):
- **In a worktree:** `data/review-texts` doesn't exist at all → `fs.mkdirSync(..., {recursive:true})` silently creates a brand-new empty dir and writes a throwaway, context-free file there (no `wrongProduction`/history/etc. carried over) instead of erroring. Don't run these from a worktree — `rm -rf` the accidental dir immediately if you catch it (check `git status`/`ls data/review-texts` right after any such run).
- **In the main checkout (`~/Broadwayscore`):** `data/review-texts` IS a real, git-tracked second clone of `broadway-review-texts.git` (not a symlink to `~/broadway-review-texts`), but it lags — compare `git -C ~/Broadwayscore/data/review-texts log -1` vs `git -C ~/broadway-review-texts log -1` before trusting it for anything read-sensitive. Cookies for outlet-authenticated scripts (`data/cookies/`) only live in the main checkout too — a worktree needs `ln -s ~/Broadwayscore/data/cookies data/cookies` (gitignored, harmless) to run cookie-dependent scripts at all.
- To actually FIX one file safely: read/write it directly via its absolute path in `~/broadway-review-texts` (the canonical, kept-fresh clone) using the real pure functions (e.g. `safeWriteReview`) rather than trusting the script's own `__dirname`-relative resolution — then `git pull --ff-only`/rebase + push from `~/broadway-review-texts` itself.
- To prove a code FIX to such a script actually works end-to-end without touching the canonical clone: run it for real (no `--dry-run`) from the main checkout against its own stale `data/review-texts` copy — a genuine execution that writes to disk, safe because that clone is already known-secondary/non-authoritative.
