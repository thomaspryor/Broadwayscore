---
name: DoaS Opening Night Postmortem (2026-04-09)
description: Comprehensive postmortem of all bugs found during DoaS opening night. Use to prep for next opening (~April 11).
type: project
originSessionId: 57921dad-e1d4-456d-a729-6ad575af8f93
archived: true
---

# Death of a Salesman Opening Night Postmortem (Apr 9, 2026)

**Show:** death-of-a-salesman-2026 | **Venue:** Winter Garden | **Opening:** Apr 9 2026
**Final live state:** 24 reviews, composite 86.12, NYT Critics' Pick correct
**Session duration:** ~6 hours, dozens of manual interventions
**Next opening:** ~April 11

## TL;DR

The pipeline produced the correct data internally throughout the night, but **systemic bugs in 4 different scripts** repeatedly wiped human-verified fields, blocked legitimate reviews from being created, and prevented public files from being committed. The user had to babysit every step. The same bug class — "scripts that decide to overwrite/clear data without checking for human-reviewed flags" — fired in collect-review-texts.js, gather-reviews.js, mergeReviews, the wrong-production audit, and rebuild-fast.yml.

5 systemic bugs were fixed in code tonight. ~10 more remain unfixed and will recur on April 11 unless addressed.

---

## CRITICAL CODE BUGS (fixed in code tonight, deployed)

### 1. rebuild-fast.yml never committed public/data/shows/*.json — ROOT CAUSE
- **Severity:** Critical — root cause of 90 minutes of "deploys not landing"
- **What:** The "Commit and push changes" step in `rebuild-fast.yml` staged only `data/audit/*.json` and `public/opening-night-status.json`. NEVER staged `public/data/shows/*.json`. Every fast rebuild ran `generate-mobile-show-details.js` (which writes the public files) but the commit step ignored those changes. Next git checkout reverted them.
- **Impact:** Live site was stale for ~90 minutes while internal data was correct. I made multiple "surgical edits" to push public files manually before realizing the workflow was the problem.
- **Detection:** Git log on `public/data/shows/death-of-a-salesman-2026.json` showed the latest commit was my surgical edit, NOT any of the rebuilds. Yet rebuild logs said "Generated 1242 show detail files".
- **Fix shipped:** Added `git add public/data/shows/ 2>/dev/null || true` to commit step in `rebuild-fast.yml` (commit `14de5275a2`).
- **Prevention TODO:** Add a CI test that fails if a workflow runs `generate-mobile-show-details.js` without subsequently staging `public/data/shows/`.

### 2. mergeReviews wiped manual wrongShow / humanReviewedWrongProduction on URL change
- **Severity:** Critical — every URL update wiped human flags
- **What:** `scripts/lib/review-normalization.js` mergeReviews unconditionally deleted `wrongShow`, `wrongProduction`, etc. on URL change. The variety--unknown wrongShow flag (Harry Potter article) was wiped repeatedly.
- **Fix shipped:** Preserve flags when `humanReviewedWrongProduction === false` OR `wrongShowReason` is set (commit `e5b7ef63ff`). Tested with 3 cases.
- **Followup:** None — this fix is comprehensive.

### 3. gather-reviews.js junk override REPLACED human-flagged files entirely
- **Severity:** Critical — every poller cycle could wipe a human-flagged file
- **What:** Lines 2532-2545 of `gather-reviews.js` had a "junk override" path: if an existing file had `wrongShow` or `wrongProduction` AND a new URL came in for the same outlet+critic, the code REPLACED the entire file (not merged), losing all human metadata. Variety unknown was a constant casualty.
- **Fix shipped:** Skip the replacement if `wrongShowReason`, `humanReviewedWrongProduction === false`, OR `humanReviewScore` is set (commit `9a5e034a70`).
- **Followup:** None — this fix is comprehensive.

### 4. collect-review-texts.js skipped human-verified files marked wrongProduction
- **Severity:** Critical — text could never be re-fetched on human-verified files
- **What:** Line 5096: `isWrongContent = data.wrongAttribution || data.wrongProduction || data.wrongShow` — caused the collector to skip ANY file with wrongProduction set, even if `humanReviewedWrongProduction === false` was set.
- **Fix shipped:** Skip the wrong-content check if `humanReviewedWrongProduction === false` OR `humanReviewScore != null` (commit `40d050da08`).
- **Followup:** None.

### 5. collect-review-texts.js checkpoint used `git pull --rebase -X theirs` — wiped humanReviewScore
- **Severity:** Critical — humanReviewScore on Variety was silently wiped
- **What:** The collector's checkpoint commit (lines ~4960) used `git pull --rebase -X theirs origin main`. The `-X theirs` flag silently drops local changes during conflicts. Same meta-bug as Cats issue #15.
- **Detection:** Variety was set humanReviewScore=52, then later showed 66 (LLM score) on the live site. Git commit history showed `chore: Checkpoint review texts` committed AFTER my fix and BEFORE the LLM scoring run, with humanReviewScore cleared.
- **Fix shipped:** After the rebase, call `scripts/lib/restore-protected-fields.js` to recover dropped fields, then amend the commit (commit `ff7768f042`).
- **Followup:** Audit any other script that uses `-X theirs` in a rebase. The pattern should always pair with restore-protected-fields.

---

## DATA / DISCOVERY BUGS (not yet fixed)

### 6. URL slug guard rejects reviews with creative titles (CRITICAL)
- **Severity:** Critical — silently dropped Theater Pizzazz Ron Fassler tonight
- **What:** When extracting from BWW RR, the URL guard requires the URL slug to contain the show title slug. Theater Pizzazz used `"hes-back-but-has-willy-loman-ever-left-us"` — no `death-of-a-salesman` in URL, so the legit Ron Fassler review was rejected.
- **Pattern:** Many critics use creative review titles that don't repeat the show name in the URL.
- **Fix needed:** Slug guard should also check article TITLE/H1, not just URL. OR trust the BWW RR's outlet attribution since BWW manually curates roundups.
- **Workaround tonight:** Manually created `theater-pizzazz--ron-fassler.json` with full text.

### 7. NYTG domain mismatch poisons new files for that outlet (CRITICAL)
- **Severity:** Critical — silently dropped Austin Fimmano review tonight
- **What:** An existing `nytg--austin-fimmano.json` had a "domain resolves to wolf-entertainment-guide" warning. When a NEW NYTG file tried to be created (different critic, valid URL), the poller rejected it citing the OLD file's domain mismatch.
- **Fix needed:** Domain validation should be per-URL, not per-outlet. One bad URL shouldn't poison new files.
- **Workaround tonight:** Manually created `nytg--austin-fimmano.json`.

### 8. Domain matcher confuses guardian.com paths with observer outlet (CRITICAL)
- **Severity:** Critical — silently dropped Guardian (Adrian Horton) review tonight
- **What:** `theguardian.com/stage/2026/apr/10/death-of-a-salesman-broadway-review` was rejected with "URL domain resolves to observer but attributed to guardian". The domain alias map confuses guardian.com with observer.com.
- **Fix needed:** Fix the domain alias map — `theguardian.com` should not resolve to `observer`. They're different publications.
- **Workaround tonight:** Manually created `guardian--adrian-horton.json`.

### 9. Wrong-production false positives on revival shows (CRITICAL — recurring)
- **Severity:** Critical — same as Cats issue #15, recurring on DoaS
- **What:** The wrong-production detector deleted text from THR, TheaterMania, Slant, TheWrap, and Chicago Tribune reviews of the CORRECT 2026 production because the reviews mention prior productions. Files showed `wordCount > 0` but `textLen = 0` and `contentTier = invalid`.
- **Cats had this same bug** with Guardian (issue #15 in Cats postmortem). Becky Shaw too.
- **Fix needed:** Wrong-production detector must use multiple signals (cast, director, theater, publish date) and require >2 to fail. Currently a single keyword mismatch deletes everything. Also: for shows with `humanReviewedWrongProduction === false`, the detector should NEVER delete text — only the audit should flag.
- **Workaround tonight:** Manually re-fetched and restored text on 5 files. The wrong-production audit RE-FLAGGED some of them after I cleared the flag — TheaterMania required two rounds of `wrongProduction: false` set explicitly (not just None).

### 10. Wrong-production audit ignores `humanReviewedWrongProduction: false`
- **Severity:** High — the audit re-flags files I marked as verified
- **What:** I set `humanReviewedWrongProduction: false` on all 23 active DoaS files preemptively. The rebuild's wrong-production audit at line 1604 of `rebuild-all-reviews.js` DOES check this field and skips. BUT the audit ALSO sets `wrongProduction: true` on files where it doesn't match. TheaterMania was flagged wrongProduction=true after my preemptive marking, blocking LLM scoring.
- **Fix needed:** When `humanReviewedWrongProduction === false`, the audit should skip BOTH the score-priority check AND the wrongProduction flag-setting. Currently it only skips one.

### 11. Stale `wrong_content` cache permanently blocks recollection
- **Severity:** Critical — affected ~5 reviews silently
- **What:** When `collect-review-texts.js` marks a file with `incompleteReason: wrong_content`, that flag is NEVER cleared even after the URL is updated. The collector skips the file forever.
- **Fix needed:** When a review file's URL is updated, the collector MUST clear all stale rejection metadata (`incompleteReason`, `incompleteDetail`, `contentTier`).
- **Workaround tonight:** Manually cleared the cache fields + restored text.

### 12. BWW RR extractor only matches first outlet mention
- **Severity:** Medium — undercounted T2 reviews
- **What:** BWW Review Roundup had 2 NYSR entries (Finkle 5/5 + Scheck 5/5). Only Finkle was extracted on the first scrape. Pipeline auto-discovered Frank Scheck via RSS later, but the BWW extractor should iterate ALL outlet mentions, not just first match per outlet.
- **Fix needed:** Update BWW RR extractor to handle multi-critic outlets.

### 13. RSS discovery assigning wrong URLs to outlet "unknown" files
- **Severity:** Medium — created the entire variety--unknown saga
- **What:** Variety RSS feed kept assigning the file to NEW wrong URLs every cycle (Tom Felton/Harry Potter, then Simu Liu/Stories from the City, etc.). Each time the URL changed, the wrongShow flag was wiped (until Fix #2 in code).
- **Fix needed:** RSS discovery should not assign URLs to existing wrongShow files at all. Or: when URL changes on a wrongShow file, treat the whole file as a new entry.

### 14. Excerpt-only LLM scores get HIGH confidence when they should be LOW
- **Severity:** High — Variety scored 73 from a tiny BWW excerpt when it should have been Mixed
- **What:** LLM scored a Variety review from a single BWW excerpt (small fragment) and assigned 73/Positive. The full review (later fetched) is "Uneven Broadway Show" — Mixed (66 from full text).
- **Fix needed:** Excerpt-only LLM scores should be capped at confidence: low. If the excerpt is < 200 chars and from an aggregator (not the actual outlet page), do NOT score — wait for full text.

### 15. Variety duplicate critic file
- **Severity:** Low — caused a "Variety Legit" outlet name confusion
- **What:** Two files for the same Variety review URL: `variety--naveen-kumar.json` and `variety--payton-turkeltaub.json`. Only Naveen Kumar is the real critic. Also, the Naveen Kumar file's outlet name had been corrupted to "Variety Legit" (from the URL slug).
- **Fix needed:** Outlet name should be normalized from the registry, not derived from URL paths. Critic name discovery should not invent names.
- **Workaround tonight:** Marked Payton Turkeltaub as duplicateOf, fixed outlet name.

### 16. Cookie-based fetching (WSJ, NYT, etc.) blocked by DataDome on CI
- **Severity:** High — WSJ scored from headline only (low confidence LLM)
- **What:** WSJ has DataDome CAPTCHA + paywall. We have valid WSJ cookies in the cookies bundle, but Playwright + cookies still gets blocked by DataDome's bot detection. The only text we got was the title + OG description.
- **Fix needed:** Either (a) use a stealth browser (Browserbase has CAPTCHA solving) for paywalled outlets, or (b) accept that title + OG description is sufficient for scoring on the rare paywalled cases.

---

## SCORING / QUALITY BUGS (not yet fixed)

### 17. LLM ensemble under-scores strong raves (LOGGED IN NOTION P2)
- **Severity:** High — would mis-score every Critics' Pick rave going forward
- **What:** Compared humanReviewScore vs LLM score on 10 DoaS reviews. LLM consistently grades 5-12 points LOW on strong raves. NYT (93 vs 81 = -12), WSJ (-12), Theater Pizzazz (-8). LLM agrees on Mixed/Negative reviews and close calls.
- **Notion card:** [LLM ensemble scoring runs too low — calibration off vs human reads](https://www.notion.so/33e637c5416f8105bba6d99667a040f3)
- **Hypotheses:** (1) No reference anchors, (2) treats craft observations as critical reservations, (3) **doesn't know about Critics' Pick designations**, (4) text-only reviews lack the star-rating anchor that letter grades and stars provide.
- **Fix needed:** Add Critics' Pick boost (+5 or floor at 90), calibration anchors in prompt, reservation weighting.

### 18. NYT pull quote extractor picked the wrong sentence
- **Severity:** Medium — first NYT quote on live site was Helen Shaw's reservation, not her endorsement
- **What:** Auto-extracted pull quote was `"The set is impressive, but nothing could save this salesman from death — we know he's dead from the moment we see the stage"` — that's Shaw's craft observation about the staging concept, not her endorsement. For a Critics' Pick rave, this is misleading.
- **Fix needed:** Pull quote extractor should weight sentences with positive sentiment markers ("triumph", "masterpiece", "magnificent", etc.) higher than neutral observations. Or: skip sentences containing "but" or "however".
- **Workaround tonight:** Manually set `llmPullQuote` to `"Now at the Winter Garden Theater, 'Death of a Salesman' has returned to Broadway, yet again in triumph."`

### 19. Pre-existing duplicate fields like `outlet: "Variety Legit"`
- **Severity:** Low — confused outlet display
- **What:** Outlet names get derived from URL paths in some cases (`variety.com/legit/...` → "Variety Legit"). Should always be normalized via outlet-registry.json.

---

## INFRA / CI BUGS (some fixed, some not)

### 20. VideoReviewsShelf imports kept re-appearing after rebases (FIXED tonight)
- **Severity:** Critical — all deploys blocked for ~30 minutes
- **What:** `src/app/show/[slug]/page.tsx` had imports for `VideoReviewsShelf` and `data-video-reviews` modules that don't exist. A prior fix (`106c6f3412`) removed them, but rebases re-introduced them via stash pop / merge conflict resolution.
- **Fix shipped:** Removed imports again (`1d66d462a1`) and verified after each rebase.
- **Prevention TODO:** Either commit the WIP feature behind a flag, or add a pre-push lint that catches imports of non-existent modules.

### 21. Concurrent CI runs racing each other
- **Severity:** High — every commit risked merge conflict, every conflict risked dropped data
- **What:** During opening night, the orchestrator dispatches a poller every 20 min. The poller triggers gather-reviews → collect-review-texts → rebuild → LLM scoring → rebuild → deploy. Multiple of these run concurrently. They all push to the same private repo. Without proper restore-protected-fields after rebase, fields get silently dropped.
- **Fix shipped:** restore-protected-fields now called from collect-review-texts checkpoint (#5 above)
- **Fix needed:** Audit ALL git rebase/merge usages across the codebase, ensure each one calls restore-protected-fields. Or refactor to a single shared push helper.

### 22. People interview correctly excluded as not-a-review (WORKING AS DESIGNED)
- **Status:** Working correctly — the LLM ensemble correctly classified `people--dave-quinn.json` as "promotional interview, not a review". All 3 models agreed, file was added to rejection list. Not displayed on live site. ✓ This is the rare bright spot.

---

## WHAT WORKED (don't break these)

- **DTLI extraction** worked once the slug map was updated (death-of-a-salesman-3 for the 2026 production)
- **BWW RR date guard** correctly rejected the 2022 BWW Roundup (42-month gap)
- **SERP date filter** (added today) prevented cross-production contamination during opening night
- **Star ratings** correctly displayed 100 for 5/5, 100 for 4/4 (NYP), 90 for "A" grade (EW)
- **Critics' Pick designation** displays correctly on live site once `isCriticsPick: true` and `designation: "Critics_Pick"` are set on the source file
- **Restore protected fields** logic in `push-review-texts/action.yml` works when called

---

## PRE-OPENING CHECKLIST FOR NEXT SHOW (Apr 11)

Before the next opening night, verify:

1. **Source files clean:**
   - DTLI slug mapped: `node -e "const m=require('./data/dtli-slug-map.json'); console.log(m.shows['{show-id}'])"`
   - All existing review files for the show are correctly flagged (run validate-data.js)
   - Existing wrongProduction files are explicitly `wrongProduction: true` (not `null`)
   - New show has `humanReviewedWrongProduction: false` set on every file proactively if revival

2. **Code fixes deployed:** verify the 5 fixes from this session are on main:
   - `rebuild-fast.yml` stages public/data/shows/ ✓
   - `mergeReviews` preserves human flags ✓
   - `gather-reviews.js` junk override checks human flags ✓
   - `collect-review-texts.js` skip-check respects humanReviewedWrongProduction ✓
   - `collect-review-texts.js` checkpoint calls restore-protected-fields ✓

3. **Code fixes still needed before opening:**
   - URL slug guard accepts non-show-name slugs (#6)
   - NYTG domain validation per-URL not per-outlet (#7)
   - Guardian domain alias map fix (#8)
   - Wrong-production detector multi-signal (#9)
   - Wrong-production audit honors humanReviewedWrongProduction in flag-setting (#10)
   - wrong_content cache cleared on URL update (#11)
   - LLM scorer Critics' Pick boost (#17)

4. **Have these URLs ready** (revivals especially) — paste manually if pipeline fails:
   - BWW RR URL for the show
   - DTLI slug
   - Talkin' Broadway URL
   - List of expected critics

5. **Monitoring:**
   - Live site URL handy with cache buster
   - Watch for the "rebuild internally has X reviews but public file has Y" mismatch
   - If pollers start racing each other, pause orchestrator (`gh variable set ORCHESTRATOR_PAUSED --body true`)

---

## Orphan stashes in review-texts repo (cleanup TODO)

As of Apr 10 handoff, `data/review-texts` has **8 stashes** accumulated from multiple sessions. Some reference my commits (stash@{1}, stash@{2}) but on inspection contain 200+ files across unrelated shows plus file DELETIONS in angels-in-america-2018, beetlejuice-2022, blithe-spirit-2009, etc. Labels are misleading — git labels by commit-at-time-of-stash, not by whose work it is.

**Don't drop any of these without careful file-by-file inspection.** The deletions in stash@{2} especially could represent intentional dedup cleanup from a prior session that never got committed.

Cleanup approach (30-60 min in a focused session):
1. `git stash show stash@{N} -p` for each stash
2. Compare each file to origin/main — is this CI drift or unique work?
3. Commit the unique work; drop the rest
4. Do NOT do this during opening night monitoring

---

## TIMELINE (Apr 9–10)

- **9:18 PM ET:** Pipeline ready, no real reviews yet
- **9:35 PM ET:** Discovered DTLI slug missing, fixed
- **9:50 PM ET:** First false review (LA Times regional production) appearing on site, fixed
- **10:00 PM ET:** First real reviews dropping, deploy chain busy
- **10:30 PM ET:** Discovered rebuild-fast.yml never stages public files — root cause of "deploys not landing"
- **10:46 PM ET:** Fix landed, live site jumped to 22 reviews
- **11:30 PM ET:** Second wave of fixes — Theater Pizzazz, NYTG, Guardian manually created (slug/domain bugs)
- **12:00 AM ET:** Variety humanReviewScore wiped by collect-review-texts checkpoint bug, traced to `-X theirs`
- **12:30 AM ET:** Live site at 23 reviews, NYT Critics' Pick correctly displayed
- **6:00 AM ET:** New poller cycles brought variety--unknown (Harry Potter) back, re-fetched text on TheaterMania/THR (which had been wiped), LLM scored most files
- **6:30 AM ET:** Final cleanup — manually deduped Variety/Naveen Kumar vs Variety/Payton Turkeltaub, restored TheWrap text, scored remaining files
- **6:45 AM ET:** 24 reviews live, composite 86.12, all scores legitimate, Notion P2 card filed for LLM calibration
