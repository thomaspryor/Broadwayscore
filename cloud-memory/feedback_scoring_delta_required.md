---
name: Scoring-logic edits require counterfactual check
description: "Edits to review-guards/rebuild/scoring MUST run scoring-delta.js + temporal fixture."
type: feedback
originSessionId: 09f4a3c6-90ce-4517-9094-ed3ec9f0c12e
modified: 2026-07-26T19:04:08.126Z
---
**Rule:** Any edit to a file controlling review-inclusion logic must be verified with a whole-dataset counterfactual check before merge — not just unit tests.

**Files that trigger the rule (two phases since 2026-04-22):**

Phase A — inclusion decision:
- `scripts/lib/review-guards.js`
- `scripts/rebuild-all-reviews.js`
- `src/lib/scoring.ts`
- `src/lib/engine.ts`
- `src/lib/data-core.ts`

Phase B — score-source selection (added in commit bcfd58d5e0 after the NY Post stars fix slipped past the narrow watchlist):
- `scripts/lib/rebuild-helpers.js` (getBestScore lives here)
- `scripts/lib/score-extractors.js` (OUTLET_VERIFIED_SOURCES, KNOWN_STAR_OUTLETS, OUTLET_STAR_AUTHORITATIVE, extractors)
- `scripts/lib/score-parsers.js`
- `scripts/lib/review-normalization.js` (AGGREGATOR_SCORE_SOURCES)
- `scripts/lib/score-routing.js`

Phase B loads HEAD via `git archive BASE -- scripts/lib scripts/llm-scoring | tar -x` into a tempdir and requires baseline rebuild-helpers from there. Per-review replay compares baseline vs working-tree `getBestScore()` output; any score or source divergence is a flip.

**Required verification:**
- `node scripts/scoring-delta.js` — replays BOTH phases (one or both run depending on which watchlist changed). Exits 2 if >0 T1 flips or >5 total flips. Prints affected shows + T1 score-source transitions (e.g. `tammy-faye-2024 · nypost · Johnny Oleksinski: 45/adjudicated → 25/originalScore-priority0`).
- `node scripts/test-temporal-override-regression.js` — fixture test over 15 flagship shows (Giant, Hamilton, Hadestown, Phantom, Lion King, Book of Mormon, Wicked, MJ, Moulin Rouge, Six, Chicago, Aladdin, Angels, Sweeney Todd, Into the Woods). Fails if any high-confidence wrongProduction flag survives the 30-day opening-window override.

**Why:** 2026-04-14 Giant incident. A session edited `applyTemporalOverrides` to "trust high-confidence LLM wrongProduction flags near opening," updated the 276-case unit test harness to match, and merged. Unit tests were green. Post-merge honest verification revealed the fix would have newly excluded 183 legitimate T1 reviews across 46 flagship shows, because the LLM has ~15% false-positive rate at high confidence on opening-week reviews. The "bug" was a safety net. Session reverted. Pattern: unit tests can pass on a change that still materially breaks the site, because unit-test expectations get updated alongside the code.

**How to apply:**
- When editing any file in the list above, run both scripts BEFORE committing.
- If `scoring-delta` prints "SCORING DELTA — significant change detected," paste the T1 flip list to the user and get explicit confirmation before pushing.
- If `test-temporal-override-regression` fails, do NOT update its tolerance band to make it pass. The tolerance is 0 because the override must always downgrade high-confidence flags within 30 days — breaking that is exactly the regression the test exists to catch.
- The Stop hook (`~/.claude/hooks/verify-edits.sh`) blocks completion claims on edits to these files unless `scoring-delta`, `test-temporal-override-regression`, or `analyze-rebuild-drops` appears in the transcript.
- Bypass (rare): `NO-VERIFY: <reason>` in message text for genuinely impact-free changes (comments, formatting). Explain *why* the edit cannot affect inclusion.

**Also required after data-flag audit sweeps (added 2026-04-26):**
- Audit sweeps that clear inclusion flags in `data/review-texts/` (wrongProduction, wrongShow, isRoundupArticle, etc.) must ALSO run `scoring-delta.js` — the script now detects these via `detectDataFlagChanges()` which diffs the review-texts repo's own HEAD vs working tree.
- The Stop hook detects audit sweeps by looking for `'review-texts'` in any Bash command. If found, it requires scoring-delta before the session can end.
- For large sweeps (>2000 changed files), scoring-delta scans the first 2000; raise cap with `SCORING_DELTA_MAX_DATA_FILES=N`.

**What this does NOT cover:**
- Email broadcast / send logic — see `memory/email-broadcast-rules.md`
- Audience score logic — different failure mode, different check
- Non-scoring scripts (scrapers, enrichers) — regular verify-edits gate applies

**Related memories:**
- `feedback_llm_wrongprod_false_positives.md` — the LLM FP rate that the temporal override is protecting against
- `feedback_verification_gate_hook.md` — the base Stop hook this extends
- `feedback_test_extraction_pattern.md` — how guard tests should be structured

**Evaluating an already-committed data sweep (2026-07-12):** scoring-delta always diffs review-texts working tree vs HEAD, so committed+pushed sweeps show "nothing to check". Recreate the diff in the `data/review-texts` clone (scratch copy, CI overwrites it): `git fetch && git reset --hard <post-sweep-sha> && git reset --soft <pre-sweep-sha>` → run scoring-delta → `git reset --hard origin/main` to restore. HEAD=pre, tree=post ⇒ the delta is exactly the sweep.

**Known blind spot — unscored-file eligibility changes (2026-07-26, task #501):** `scoring-delta.js`'s own `decideInclusion()` (its LOCAL reimplementation of the inclusion predicate, not a call to the real `isIncludableForRebuild`) early-returns `{included:false, reason:'no score'}` whenever `review.assignedScore == null` — BEFORE it ever reaches the final text/excerpt fallback logic. So any fix that changes whether an *unscored* file is eligible (e.g. the excerpt-only fallback fix in #501) reports "0 flips" / "delta within tolerance" no matter what, because scoring-delta can only see flips among ALREADY-SCORED reviews. A clean scoring-delta run does NOT prove no impact for this class of change. **Verify instead with `node scripts/audit-llm-scoring-parity.js`** (calls the REAL `isIncludableForRebuild`/`isScoreable`, and diffs before/after via `git stash` on `scripts/lib/review-guards.js` if scoring-delta's git-diff mode doesn't apply) — still run scoring-delta.js too (it's the mandated gate and catches the *other* class: already-scored files flipping), just don't stop there.
