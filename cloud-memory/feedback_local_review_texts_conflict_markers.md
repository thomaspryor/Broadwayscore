---
name: Local data/review-texts can carry stash-pop conflict markers invisible to CI
description: When local rebuild diff vs origin reviews.json is unexpectedly large, grep data/review-texts/ for <<<<<<< — local-only conflict markers silently break JSON and drop reviews
type: feedback
originSessionId: 12f33ad8-9781-43a0-8624-2f1fee3168aa
archived: true
---
When a local `node scripts/rebuild-all-reviews.js` produces a diff vs origin/main that is far larger than the explicit data change you made (e.g. cleared one stale flag → expect ~10 lines of diff → got +2100/-897), suspect local conflict-marker corruption in `data/review-texts/`.

**Why:** `data/review-texts/` is a **regular directory**, not a symlink — two independent copies (`data/review-texts/` in main repo + `~/broadway-review-texts/` private repo) sync'd by CI. Local-only operations (interrupted `git pull`, aborted `git stash pop`, manual recovery edits) can leave conflict markers in the local copy that NEVER reach the private repo or CI. CI's input stays clean, so its rebuild output stays clean. But your LOCAL rebuild silently drops every review-text file with broken JSON.

Hit 2026-04-26 with **287 corrupted local files** (`<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes`), zero in private repo. Each broken file made `require()` throw inside the rebuild's per-file try/catch and got dropped without a log line.

**How to apply:**
1. Before declaring "rebuild produced large diff" a problem worth investigating in scoring code, run:
   ```
   grep -rl "<<<<<<<" data/review-texts/ | wc -l
   grep -rl "<<<<<<<" ~/broadway-review-texts/ | wc -l
   ```
2. If local count > 0 and private count = 0: it's local corruption, not a real data change. Sync from private:
   ```
   while IFS= read -r f; do
     rel="${f#./data/review-texts/}"
     [ -f "$HOME/broadway-review-texts/$rel" ] && cp "$HOME/broadway-review-texts/$rel" "$f"
   done < <(grep -rl "<<<<<<<" data/review-texts/)
   ```
3. Re-run rebuild against clean inputs.
4. Push the canonical fix to private repo, then trigger CI's "Rebuild Reviews Data" workflow (ID 228882172) rather than pushing your local rebuild output — CI's input is the authoritative private repo and produces a smaller, cleaner diff (just the actual data change).

**Detection:** `scripts/verify-review-recovery.js` already checks JSON validity + conflict markers (lines 107-120), but it is only run after opening-night manual recovery, not as a general local-state health check. Could be wired into a session-start advisory: run the grep, warn if local has conflict markers absent in private.

Class: same shape as memory/feedback_review_texts_not_symlink.md (two-repo drift) — but the corruption mode here is BROKEN JSON, not missing edits.
