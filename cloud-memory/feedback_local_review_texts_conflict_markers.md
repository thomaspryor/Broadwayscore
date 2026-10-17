---
name: review-texts conflict markers — local-only OR committed to private-repo origin by a bad rebase
description: Conflict markers in review-text JSON break the corpus two ways — local-only (invisible to CI) AND committed to private-repo origin by an automation rebase (CI's validate-review-texts catches it). When validate-review-texts fails on a JSON parse error, suspect a committed marker.
type: feedback
originSessionId: 12f33ad8-9781-43a0-8624-2f1fee3168aa
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

---

**2026-06-29 — the ORIGIN-side variant (contradicts the "CI input stays clean" assumption above).**
An automation rebase (`enrich-reviews`, commit 09e78a7a) committed git conflict markers as invalid JSON **to the private-repo origin itself** — not just local. So the "local > 0, private = 0" detection above gives the WRONG answer here: private/origin had the markers too, and CI's `validate-review-texts` step FAILED on the parse error (`Expected property name or '}' at position 2`). Two files hit: `a-midsummer-nights-dream-west-end-2026/broadwayworld--michael-major.json` and `_pending/relics-west-end-2026/times-uk--61f17567.json` — a rebase had collided two *different* files at one path (`<<<<<<<< HEAD:_pending/relics.../times-uk...` vs `>>>>>>>> ...:a-midsummer.../broadwayworld...`).

**Diagnostic:** when `validate-review-texts.js` (or any rebuild) fails with a JSON parse error on a review-text file, fetch that file from the private repo (`gh api repos/thomaspryor/broadway-review-texts/contents/<path> --jq .content | base64 -d`) and look for `^<<<<<<<`. Resolve **by file path** — each conflicted blob's correct content is the side whose marker names that file's path (the midsummer file → the `broadwayworld--michael-major` side; the relics file → the `_pending/relics.../times-uk` side). Verify the counterpart file exists separately before resolving so you don't orphan it. PUT each fix back via `gh api -X PUT`.

**Prevention (carded, Notion 38e637c5-416f-8188):** add a pre-push conflict-marker guard in `scripts/lib/push-with-retry.sh` rejecting any staged file containing `^<<<<<<<`/`^=======`/`^>>>>>>>`. Root-cause fix — a bad rebase should never be able to commit invalid JSON. There is currently NO such guard; only the late `validate-review-texts` CI step catches it, after it's already on origin.
