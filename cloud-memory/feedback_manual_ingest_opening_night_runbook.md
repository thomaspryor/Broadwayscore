---
name: Manual ingest opening-night runbook
description: Read FIRST before any manual review ingestion. 21-item checklist of failure modes that have caused lost reviews, wrong scores, stale deploys, or duplicate files across 11+ opening nights. Sourced from Rocky Horror 2026-04-23, Joe Turner 2026-04-25/26, Beaches 2026-04-22, Lost Boys 2026-04-26, and earlier postmortems.
type: feedback
originSessionId: 9b9b7cf9-33e6-4c63-9802-f9b8945d65ef
---
# Manual ingest opening-night runbook

User on Lost Boys 2026-04-26: "We've tried to automate pulling in all reviews via BWW RR + direct outlet checks + SERP + DTLI, but all of the last 11 or so have failed miserably and I've had to do it manually." Every item here has bitten us before. **Read FIRST, work the list, don't improvise.**

## Trigger conditions
Manual ingest is needed when:
- T1 outlet (NYT, Variety, Vulture) publishes but pipeline can't fetch (paywall break, Cloudflare lockout, URL pattern miss)
- BWW RR publishes but reviews.php + homepage + SERP all fail (rare post-2026-04-26 fix `eccdb3280f`)
- User has full review text from email/screenshot/copy-paste
- Aggregator extractor breaks mid-wave (e.g. Show Score JSON-LD shift)

---

## §1. File creation (every manual file MUST have)
**Why:** Rebuild silently drops reviews missing any of the 8 protection fields, or strips overrides on next CI rebase.

1. **Set ALL 8 protection fields:**
   - `humanReviewScore` (1-100)
   - `humanReviewScoreProvisional: false`
   - `assignedScore` (same as humanReviewScore)
   - `llmScore.score` (same value — see §3)
   - `originalScore` + `scoreSource` if outlet has explicit rating
   - `contentTier: 'complete'`
   - `contentVerification: { isValid: true, ... }`
   - `protectedFields: ['humanReviewScore','assignedScore','llmScore','contentTier',...]` (per-file lock)
   Source: `feedback_per_file_protected_fields_lock.md`, Rocky Horror postmortem #8/9.

2. **`-2026` filename suffix is TEMPORARY** — rebuild auto-renames it on first cycle (~95% similarity match strips suffix). Don't rely on naming for protection. Use `wrongProductionManualClear: true` + `protectedFields` array. Rocky Horror postmortem #20.

3. **Re-ingesting onto an existing wrongProduction:true file silently preserves the flag** — review will keep getting excluded. Either pass `--force-clear-stale-flag` to ingest-manual-review.js, OR `rm` the stale file before re-ingest. Rocky Horror postmortem #13.

4. **`safeWriteReview` merge re-adds deleted fields** — `delete fresh.field` then `safeWriteReview` keeps the field (merge step at line 202-208 re-adds anything `undefined` from disk). Use `field: null` instead. Source: `feedback_safe_write_review_merge_gotcha.md`.

5. **Renaming a review-text file requires parallel updates everywhere:**
   - `data/llm-scores/{show-id}/{outlet--critic}.json`
   - Any `duplicateTextOf` pointers in sibling files
   - BOTH repos (broadway-review-texts + data/review-texts symlink)
   - Audit snapshots that reference the old name
   Source: `feedback_backfill_sibling_stores.md`.

6. **Critic-name typo flags** — if `criticName` is set wrong, dedup creates duplicates on re-ingest. Use `renameReviewFileToMatchCritic` in `scripts/lib/review-normalization.js`. Source: `feedback_critic_override_must_rename_file.md`.

---

## §2. Push order (private repo first, ALWAYS)
**Why:** CI rebuild reads from broadway-review-texts HEAD; if you push public main first then review-texts, the rebuild input doesn't have your changes.

7. **Push to `thomaspryor/broadway-review-texts` (private) BEFORE running rebuild or pushing public main.** Source: `feedback_review_texts_ci_overwrites.md`.

8. **NEVER `git reset --hard origin/main && rsync`** — wipes CI-added `llmScore` fields on every show. Use `git pull --rebase` only. Source: `feedback_reset_rsync_wipes_ci_fields.md`, Rocky Horror postmortem #10.

9. **After ANY rebase, run `node scripts/restore-protected-fields.js`** — re-applies stripped per-file locks. Source: `feedback_restore_protected_fields.md`.

10. **Local data/reviews.json is symlinked** — `fs.renameSync`/`writeFileSync` must resolve the symlink first or it becomes a regular file (decoupled from the private repo). Source: `feedback_symlink_aware_writes.md`.

11. **gh api PUT for emergency single-file commits** — when local git is broken (stash conflicts, corrupt refs), use `gh api PUT /repos/.../contents/{path}` with base64 content + sha. Source: `feedback_gh_api_emergency_commit.md`. Used tonight (2026-04-26) to flag the 2 _pending non-reviews.

---

## §3. Rebuild (use the FAST one)
**Why:** Wrong workflow = 13 min wasted per attempt during the wave.

12. **Use `rebuild-fast.yml` (2 min) NOT `rebuild-reviews.yml` (15 min)** for opening-night corrections. Rocky Horror postmortem #11.

13. **Score resolution prefers `llmScore.score` over `humanReviewScore`** — to force a human override, set BOTH `humanReviewScore` AND `llmScore.score` AND `assignedScore` to the same value. For NYT Critic's Pick override (Helen Shaw on Rocky Horror = 82 across all three): lock all three. Rocky Horror postmortem #16.

14. **LLM ensemble overrides manually-set `keyPhrases`** — DTLI verdict quotes get stripped by ensemble's own keyPhrase selection. Either re-set after ensemble runs OR add `keyPhrases` to a protectedFields-equivalent. Rocky Horror postmortem #15.

15. **Local data/review-texts can carry stash-pop conflict markers invisible to CI** — when local rebuild diff is unexpectedly large vs origin, grep `data/review-texts/` for `<<<<<<<`. Detection wired in `~/.claude/hooks/session-start.sh`. Source: `feedback_local_review_texts_conflict_markers.md`.

---

## §4. Deploy (don't deploy stale)
**Why:** Vercel will happily deploy review data without your fix.

16. **Vercel deploy dispatched BEFORE rebuild commits = stale deploy** — `git fetch origin main` and confirm the rebuild SHA is on origin/main BEFORE running `gh workflow run "Deploy to Vercel"`. Hit 3+ times on Rocky Horror. Postmortem #12.

17. **Vercel concurrency cancels back-to-back dispatches** — 4 dispatches → 2 succeeded, 2 cancelled. Wait between dispatches, don't queue. Rocky Horror postmortem #17.

18. **Deploy verification:** after dispatch, wait with `scripts/lib/wait-for-run.sh <run-id>` (never `gh run watch` — 3s polling burns quota, [[feedback_github_polling_rate_limit.md]]) and confirm the deployed reviews.json mtime > the manual-ingest start timestamp.

---

## §5. Dedup / attribution gotchas
**Why:** Wrong attribution → duplicate scoring → composite drifts → on-site display shows two identical reviews.

19. **URL dedup canonicalization** strips `?triedRedirect`, `?utm_*`, `?fbclid`, `?ref`, etc. via `canonicalizeUrlForDedup` in `review-guards.js` (shipped 2026-04-24, commit `5dd8e183f8`). Verify it caught the case BEFORE doing manual deletion.

20. **BWW RR can mis-attribute critics** — Cote Notices → David Finkle on Rocky Horror 2026-04-24. The byline in the BWW article may not match the actual reviewer's URL hostname. Verify: does `outletId` match the URL domain? If outlet=substack-name and critic-byline=different-name, look up the substack to confirm authorship. Rocky Horror postmortem #19.

21. **Poller re-creates deleted files next cycle** — never `rm` a wrong-production file. Mark `wrongProduction: true` + optional `duplicateOf` instead. The merge-bug at write time preserves these flags. Rocky Horror postmortem #21.

---

## §6. Score-extraction holes (manually patch when these outlets land)
**Why:** Explicit ratings are present in the page but pipeline doesn't auto-pick them up; LLM ensemble guesses ~10-30 points off.

22. **NYSR star ratings (★★☆☆☆ = 40 in our scale)** — `extractNYSRScore` exists in `score-extractors.js` but is NOT called from `collect-review-texts.js` in the opening-night flow. If NYSR reviews land tonight: manually set `originalScore` + `starRating` on the file. Same audit needed for:
   - Time Out (★/5 format) — `extractTimeOutScore`
   - Guardian (API-based, separately handled per code comment)
   - EW (letter grades — partial coverage)
   Rocky Horror postmortem #22.
   **Update 2026-04-27 (Lost Boys followup):** for `/ingest` UI submissions, the API now runs `extractScore('', fullText, outletId)` against pasted body text BEFORE rebuild touches the file (see commit 818d4c1021). This populates `originalScore` + `originalScoreNormalized` for NYSR / Time Out / EW / NY Post / Culture Sauce / One-Minute Critic / etc. Manual setting of `originalScore` is no longer required for /ingest-driven reviews. The auto-discovery (orchestrator BWW RR / Playbill Verdict) path is still uncovered — manual setting remains needed there.

23. **Critic-name 'unknown' SERP discoveries land in `_pending/{show-id}/outlet--{hash}.json`** — file is in limbo. After ingesting full text and identifying the byline, must rename to match real critic name (parallel updates per §1.5). Source: `feedback_critic_override_must_rename_file.md`.
   **Update 2026-04-27:** /ingest UI no longer rejects on byline-detect failure — saves with `criticName: 'Unknown'` + `pendingReason: 'no-byline'` and a sha-prefix filename (`outlet--unknown-{6charhash}.json`). Operator edits `criticName` later; rebuild's existing `Stale --unknown cleanup` step (`rebuild-all-reviews.js:1070-1115`) auto-renames the file. See commit 818d4c1021.

---

## §7. Verification (MANDATORY before claiming done)
**Why:** Pipeline has 5 independent silent-failure points after ingest. Skipping verification → user finds problem 30 min later.

24. **Run `node scripts/verify-review-recovery.js --show={SHOW_ID} --production`** — checks all 5 silent-failure points (conflict markers, scoring cancellation, rebuild timing, etc.) and prints the exact fix command for each failure. Per CLAUDE.md "Content Quality" section. **MANDATORY** after any flag clearing, stub creation, URL ingestion, or manual review insert.

25. **Read the live show page after deploy** — `curl -sL https://broadwayscorecard.com/show/{slug} | grep -i "{critic-name}"` to confirm the review actually rendered. Deploy lag bugs (#16) are silent.

---

## When to escalate to user
- 5+ minutes blocked on a single review file = stop, ask
- Three consecutive ingest attempts that hit different bugs = stop, regroup
- Conflict between competing protections (e.g. wrongProduction:true vs intentional ingest) = ask before forcing
- Ensemble score is wildly off explicit rating (e.g. ★★/5 = 40 but ensemble gave 65) = manual override + flag for postmortem

## Reference postmortems (read before tonight's manual ingest)
- `memory/rocky-horror-2026-opening-night-postmortem.md` (project file, 22 issues)
- `feedback_admin_ingest_opening_night_2026-04-26.md` (Joe Turner master log, ~42 issues)
- `feedback_local_review_texts_conflict_markers.md` (silent-corruption detection)
- `feedback_per_show_concurrency_with_idempotency.md` (watcher idempotency)
