# Sprint Plan: 2026 Data Audit Fixes

Source: `2026-data-audit-report.md` (audit, 2026-09-28) and `plan-review-synthesis.md` (six-reviewer plan review, revised plan Phases 0-4). Linear: BRO-4204. Owner approved the revised plan, the two-unit ramp (continue on success), and critic-slug redirects. Pending owner decisions: (D3) removal of the 77 non-theatre rows; (D4) low-confidence weighting (recommended: hybrid).

## Overview
Fix the 15 live data defects found by the 2026 audit and the seven pipeline mechanisms that produce them. Data corrections land first behind safety rails and a two-unit ramp; pipeline fixes follow, one PR per concern; the two destructive batches (id renames, non-theatre removals) run last, through purpose-built tools.

Repo split: web repo `/home/user/Broadwayscore` (code, workflows, public derived files); core data `/root/broadway-scorecard-data` (shows.json, slug maps, aliases; symlinked from `data/`); review texts `/home/user/broadway-review-texts` (one file per review, `_pending/` strand; linked at `~/broadway-review-texts`). CI rebuilds `reviews.json` (`rebuild-reviews.yml`), never local.

Edit protocol for every data task (from the plan review and the sprint critique): `git pull` the target repo immediately before editing; one batch per commit; push immediately; after the first origin/main commit that follows ours (for review texts that is the next `collect-review-texts.yml` or any workflow using the `push-review-texts` action), re-read `origin/main` and assert the change survived; review-file edits only through `safeWriteReview` with the field's breadcrumb (`wrongProductionOverride`/`wrongShow` clear/`originalScoreCleared` + reason; `llmScore` and `isNonReview` are protected too); every deleted shows.json row archived to `deleted-shows.json` **in the core-data repo** beside `retired-show-ids.json` (never in the web repo's tracked `data/audit/`, §11); closing-date edits stamped `humanCorrectedClosingDate`.

**Single writer rule (sprint critique):** in data sprints, subagents never commit. Each subagent writes a patch or a JSON list of intended edits to the scratchpad; the coordinator applies them serially, one batch per commit, one push at a time, so `S1-T7`-style survival checks can attribute any revert.

**§18 note:** `.github/actions/push-core-data/action.yml` is in `infra-review-scope.js`; the plan-review verdict is keyed per session, so the session that executes S0-T4 records its own `review-gate.mjs --query=record-plan` first (this session already has one). The workflows edited in Sprints 4 and 7 are outside the gated regex (warn-only).

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 0 | Safety rails, dedup stopgap and parser fix landed; ramp proven on one review and one row; 24h gate | 12 | 8S, 4M |
| 1 | Listing-page guard landed; wrong scores and misfiled outlets corrected on the live site | 8 | 6S, 2M |
| 2 | Missing shows added, dates and text corrected | 12 | 9S, 3M |
| 3 | Hidden and stranded reviews recovered | 5 | 3S, 2M |
| 4 | Discovery and ingestion stop producing junk and going dark silently; inclusion policy written | 14 | 9S, 5M |
| 5 | Dedup, id minting, rename tool, critic-slug redirects | 9 | 4S, 5M |
| 6 | Scoring guards (cross-market, listing pages, relays, thumbs) and the confidence root cause | 14 | 8S, 6M |
| 7 | One critic-name path; fixers include closed shows; tooling | 11 | 7S, 4M |
| 8 | Follow-on batches through the new tools; wrap-up | 5 | 2S, 3M |

Sprint 0 is the manual pass for the automation that follows (retirement tool, rename tool): one review file and one row are done by hand before any batch tool exists.

---

## Sprint 0: Safety rails and ramp
**Demo:** `validate-data.js --dry-run` leaves shows.json untouched; a retired id cannot be re-discovered; Romeo & Juliet (NYC) shows 57 on the live site and the flag survives CI; the phantom "?tab=dates" row is gone and stays gone.
**Risks:** validate-data has four write sites and an audit-artifact writer, easy to miss one; the retired-id check must sit in three places (discovery, reconcile, validate) or a re-add slips through; the ramp verification depends on CI timing (rebuild + deploy gate ~30 min).
**MODEL:** Sonnet for T1-T6 (clear specs), Opus for T7-T9 (multi-repo ramp with CI verification).

### Task S0-T1: Add `--dry-run` to validate-data.js through the write-guard seam
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/validate-data.js (:154 guard creation, :769/:842/:981/:1218 saveShows, :176/:183 writeAuditArtifact), scripts/lib/shows-write-guard.js (:65 createShowsWriteGuard, add `dryRun` option), tests/unit/validate-data-dry-run.test.mjs (new)
- **Description:** `createShowsWriteGuard(path, {dryRun})` returns a `saveShows` that records the intended write and returns without touching disk; validate-data passes the flag and prints "DRY RUN: N writes suppressed". Exit code unchanged. Use `--dry-run` (repo convention), not `--check`.
- **Acceptance criteria:**
  - VERIFY: `sha256sum data/shows.json; node scripts/validate-data.js --dry-run; sha256sum data/shows.json` shows identical hashes and the log line "DRY RUN"
  - VERIFY: `node --test tests/unit/validate-data-dry-run.test.mjs` passes

### Task S0-T2: Create the retired-show-ids registry
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/retired-show-ids.js (new: `loadRetiredIds()`, `isRetiredId(id)`, `retireId(id, {reason, archivedRow})`), core-data repo: retired-show-ids.json and deleted-shows.json (new, seeded empty), tests/unit/retired-show-ids.test.mjs (new)
- **Description:** A small JSON list `{id, reason, retiredAt}` plus a loader. `retireId` appends to the list and to the archive (full row). Both files live in the core-data repo (they are core data, §11), resolved the same way `shows.json` is.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/retired-show-ids.test.mjs` passes (load, isRetired, retire appends both files)

### Task S0-T2b: Cross-linked ids are never duplicates (stopgap for Sprint 2)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/deduplication.js (`checkForDuplicate` :655, before Check 1), tests/unit/show-dedup-crosslink.test.mjs (new)
- **Description:** A candidate whose `transferOf` or `priorRuns` names the existing row (or vice versa) is not a duplicate. Without this, `isMultiProduction` (:447-453) only exempts closed-vs-announced pairs, so Into the Woods (previews since 09-22), Arcadia (Duke of York's, open), Lost in Del Valle (return, open) and the one-part Cursed Child would fail `validate-data.js:365` and the push sentinel would refuse Sprint 2. S5-T1 replaces this with the full temporal rule; the exemption stays as a safety net.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/show-dedup-crosslink.test.mjs tests/unit/show-dedup-temporal.test.mjs` pass (new fixture: open same-title pair cross-linked is not a duplicate; un-linked open pair still is)

### Task S0-T2c: Fix the Playbill Broadway schedule parser (moved from S4-T1)
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/playbill-broadway-schedule.js (:101 titleRe, :119-131 field loop), tests/fixtures/broadway-discovery/playbill-broadway-2026-09-28.html (new, from agentA/playbill-schedule-article.html), tests/unit/broadway-schedule-discovery.test.mjs
- **Description:** Code-only and dependency-free, and the parser feeds `discover-new-shows.js` itself (not only the coverage guard), so Broadway discovery stays dark until this lands. Widen the title character class (digits, `;`, quotes, `/`), tolerate `<strong>` letter splits, terminate each segment at the next anchor regardless of title match. Fixture asserts 33 entries incl. 860, Blue Man Group, School Girls, and Other Desert Cities = Hudson/09-29/10-18. Hand-entered dates from S2-T9 survive because `discovery-reconcile.js:60` recrawls only RECRAWLABLE sources.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/broadway-schedule-discovery.test.mjs` passes with the new fixture

### Task S0-T3: Discovery refuses retired ids
- **Complexity:** S
- **Depends on:** S0-T2
- **Parallel:** Yes
- **Files:** scripts/discover-new-shows.js (:2319 top of candidate loop), tests/unit/discovery-retired-id.test.mjs (new)
- **Description:** At the top of the candidate loop, skip candidates whose minted id, or whose exact normalized title+venue, matches a retired entry; log `retired-skip`.
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/discovery-retired-id.test.mjs` passes with a fixture candidate matching a retired id

### Task S0-T4: Reconcile and push action honour retired ids
- **Complexity:** M
- **Depends on:** S0-T2
- **Parallel:** Yes
- **Files:** scripts/lib/reconcile-shows-fields.js (:101-110), .github/actions/push-core-data/action.yml (:429-444 inline node; :59 `CORE_FILES` add `retired-show-ids.json` and `deleted-shows.json` so CI writes to them are pushed), tests/unit/reconcile-retired-ids.test.mjs (new)
- **Description:** `reconcileShowsJson` never re-adds an id present in the retired list even when the base snapshot lacks it. The action passes the retired list through and pushes the two new core files. (Composite action is §18-gated: the executing session records `review-gate.mjs --query=record-plan` first.)
- **Acceptance criteria:**
  - VERIFY: `node --test tests/unit/reconcile-retired-ids.test.mjs` passes (remote has id, base lacks it, id retired: not re-added; same without retirement: re-added)

### Task S0-T5: validate-data warns on retired ids present in shows.json
- **Complexity:** S
- **Depends on:** S0-T2
- **Parallel:** Yes
- **Files:** scripts/validate-data.js (new check next to the duplicate check at :342-372)
- **Description:** A WARN line per retired id found in shows.json so a resurrection is loud in CI logs and the digest.
- **Acceptance criteria:**
  - VERIFY: with a temporary retired entry for an existing id, `node scripts/validate-data.js --dry-run` prints the warning; removed afterwards

### Task S0-T6: Land Sprint 0 code
- **Complexity:** S
- **Depends on:** S0-T1, S0-T2b, S0-T2c, S0-T3, S0-T4, S0-T5
- **Parallel:** No
- **Files:** none new
- **Description:** tsc, lint, node tests; push `land/audit-s0-safety-rails`; follow `land.yml` to success; seed `data/retired-show-ids.json` in the core-data repo.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit && npx next lint` clean; `land.yml` run reports success; `git -C /root/broadway-scorecard-data log -1 --format=%s` shows the seed commit

### Task S0-T7: Ramp unit 1: flag Romeo & Juliet's Stage review by hand
- **Complexity:** M
- **Depends on:** None (review-texts repo only)
- **Parallel:** Yes
- **Files:** /home/user/broadway-review-texts/romeo-and-juliet-off-broadway-2026/thestage--sam-marlowe.json (via `safeWriteReview`, scripts/lib/review-write-guard.js:1074)
- **Description:** One-off node call setting `wrongProduction: true`, `wrongProductionReason: "Theatre Record relay of the Harold Pinter (Icke) production; text names Robert Icke"`, `wrongProductionSource: "manual-audit-2026-09-28"`, `humanReviewedWrongProduction: true`, following the field set `classify-wrong-production.js:614-652` writes. Commit and push to the review-texts repo main.
- **Acceptance criteria:**
  - VERIFY: `git -C /home/user/broadway-review-texts show origin/main:romeo-and-juliet-off-broadway-2026/thestage--sam-marlowe.json | grep wrongProduction` shows true

### Task S0-T8: Ramp unit 1: rebuild, deploy, confirm 64 to 57, confirm the flag survives
- **Complexity:** M
- **Depends on:** S0-T7
- **Parallel:** No
- **Files:** none
- **Description:** Dispatch `rebuild-reviews.yml`; after it commits, `node scripts/check-prod-deploy.js HEAD --wait`; read the live `public/data/shows/romeo-and-juliet-off-broadway-2026.json`; then wait for the next `push-review-texts` run and re-read the file on origin/main.
- **Acceptance criteria:**
  - VERIFY: live show JSON `rc` is 26 (was 27) and carries no The Stage row; `cs` moves down (the audit's 57 assumes all ten West End relays removed, which is S1-T1's batch)
  - VERIFY: after the first origin/main commit in the review-texts repo that follows ours (any workflow using the `push-review-texts` action, e.g. `collect-review-texts.yml`), the file still has `wrongProduction: true`
  - RESULT 2026-09-28: review-texts commit 7fd45367; rebuild run 10487 succeeded 16:34 UTC; web main and the live site both serve rc 26, no Stage row, cs 63.06 (was 63.71). Survival: a later CI commit (a067cc5a) re-tiered the file to invalid/wrong_content and kept wrongProduction:true and the revoked override; S0-T10 re-checks at 24h.

### Task S0-T9: Ramp unit 2: retire the phantom row by hand and confirm it stays gone
- **Complexity:** S
- **Depends on:** S0-T6
- **Parallel:** No
- **Files:** /root/broadway-scorecard-data/shows.json, data/retired-show-ids.json, data/deleted-shows.json
- **Description:** Remove `tabdates-off-west-end-2026` (title "?tab=dates"), archive the row, add the retired entry, commit and push core data. Wait for one `update-show-status` run.
- **Acceptance criteria:**
  - VERIFY: after the next `update-show-status` run, `git -C /root/broadway-scorecard-data show origin/main:shows.json | grep -c tabdates-off-west-end-2026` prints 0
  - RESULT 2026-09-28: the row was already gone. The owner deleted it on 2026-09-22 (core-data f5f7a1c, BRO-3915); the audit saw it because the container's core-data clone dated from 2026-09-22 01:06 UTC and was first refreshed at 14:59 UTC on 09-28 (reflog). Ramp 2 therefore registered the retirement instead of deleting: the archived row was pulled from `f5f7a1c^:shows.json` and `retireId(..., {blockTitleVenue: true})` wrote `retired-show-ids.json` + `deleted-shows.json`; pushed as core-data df15a61. `matchesRetired` hits by id and by title+venue ("?TAB=DATES"/"hampstead theatre"), and not for a real Hampstead show. The grep prints 0 on origin/main now; the 24h check confirms the registry entry survives CI's push-core-data (CORE_FILES gained both files in S0-T6) and the row stays absent.
  - AUDIT SNAPSHOT NOTE: every shows.json count in the audit report's §3.1/3.2/3.5 that came from `scratchpad/agentE` (validate-data errors, duplicates, titleCase fields, date/status counts) was computed on that 09-22 snapshot. A fresh `validate-data.js --dry-run` on 09-28 reports 0 errors (was 17: both duplicate clusters and all 14 titleCase rows were fixed by other sessions in the interval) and 98 upcoming-with-null-openingDate rows (was 109). Sprint 2 (S2-T*) re-verifies each shows-level count against a freshly pulled shows.json before touching a row; counts taken from the live site (`public/data`) or from the review-texts repo are unaffected.

### Task S0-T10: 24-hour gate re-check
- **Complexity:** S
- **Depends on:** S0-T8, S0-T9
- **Parallel:** No
- **Files:** none (scheduled with `send_later`, 24h)
- **Description:** Re-run the two survival checks 24 hours after the ramp: S0-T8's file on origin/main still carries `wrongProduction: true` and the revoked override; S0-T9's registry entry is still on origin/main of core data (`git show origin/main:retired-show-ids.json | grep -c tabdates` prints 1) and the row is still absent from shows.json (`grep -c` prints 0). Owner decision: continue into Sprint 1 automatically on success; stop and report on any revert.
- **Acceptance criteria:**
  - VERIFY: both greps still pass 24h later, output pasted on BRO-4204

---

## Sprint 1: Score and outlet corrections
**Demo:** R&J, Much Ado, Every Brilliant Thing, Rocky Horror and the listing-page shows show corrected scores and outlets on the live site.
**Risks:** each file edit must carry the right breadcrumb or CI restores it; the 20 about-entertainment rows are historical (2005-2013) and rename across outlet dirs, so use `safeRenameReview`; a rebuild is one CI run for all of them, so verify per show.
**MODEL:** Sonnet.

### Task S1-T0: Listing-page URL guard with a human breadcrumb (moved from S6-T3)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (code track; lands via `land/` before S1-T3 runs)
- **Files:** scripts/lib/is-scoreable.js (:11), scripts/lib/review-guards.js (:853 urlLooksLikeReview, :1786 isNonReview demotion, :3281 explainExclusion), tests
- **Description:** `explainExclusion` returns `listing-page-url` when `urlLooksLikeReview` is false for `/shows/…`, `index.html`, bare hosts; star extraction from such pages is refused. Also: `isNonReview` is demoted at :1786 when a fresher CV pass says "review", so S1-T3's hand flags need a `humanReviewedNonReview: true` breadcrumb the demoter honours.
- **Acceptance criteria:**
  - VERIFY: tests: the talkinbroadway index URL and the londontheatrehub `/shows/` URL are excluded; a hand-flagged `isNonReview` with the breadcrumb is not demoted

### Task S1-T1: Flag the remaining Theatre Record leaks on R&J and Much Ado
- **Complexity:** S
- **Depends on:** S0-T8
- **Parallel:** Yes
- **Files:** the 36 remaining files with `wrongProductionOverrideSetBy: "migrate-reroute-backlog.js"` (scratchpad `migration-override-hits.json`): 9 more on romeo-and-juliet-off-broadway-2026 and 5 on much-ado-about-nothing-2026 (Theatre Record, unflagged: flag exactly as S0-T7); 15 Theatre Record files on a-christmas-carol/macbeth/medea (already flagged but still carrying `wrongProductionOverride: true`: revoke the override the same way so the state is no longer self-contradictory); 7 with URLs on older NYC shows (a-christmas-carol-2022 nytg, beetlejuice-2019 artsfuse, falsettos-2016 nytg, how-to-succeed-2011 ew, little-shop-2019 nytg, macbeth-off-broadway-2026 broadwayworld, tru-off-broadway-2026 theater-life: read each; keep the ones whose URL is a review of that production, revoke the rest).
- **Description:** Same field set as S0-T7 (flag + revoked override + `humanReviewedWrongProduction`), one commit. Lesson from the ramp: the flag alone does not exclude while `wrongProductionOverride` is true; revoking it with `false` is a value, not a clear, so the push guard leaves it.
- **Acceptance criteria:**
  - VERIFY: a node one-liner over the corpus counts 0 files with `wrongProductionOverride === true` and `wrongProductionOverrideSetBy === "migrate-reroute-backlog.js"` on NYC-market shows with a Theatre Record source; `explainExclusion` returns `wrongProduction` for every flagged file

### Task S1-T2: Flag the four other wrong-production reviews
- **Complexity:** S
- **Depends on:** S0-T8
- **Parallel:** Yes
- **Files:** the-car-man-west-end-2026 (Stage/Oresteia URL), romeo-and-juliet-west-end-2026 (Stage/Almeida URL), cats-the-jellicle-ball-2026 (TheaterMania 2024 URL), and-juliet-2022 (WSJ 2026 Delacorte URL)
- **Description:** Re-read each file's URL and text first; flag with reason citing the URL slug.
- **Acceptance criteria:**
  - VERIFY: each file on origin/main has `wrongProduction: true` and a reason

### Task S1-T3: Delist listing pages and invalid-tier reviews
- **Complexity:** M
- **Depends on:** S0-T8, S1-T0
- **Parallel:** Yes
- **Files:** talkinbroadway index.html files (3 shows), londontheatrehub /shows/ files (3), the 10 `contentTier: invalid` scored files (list from agentF/llm-signals.json)
- **Description:** Set `isNonReview: true`, `isNonReviewReason`, and the `humanReviewedNonReview: true` breadcrumb from S1-T0 through `safeWriteReview` (the listing pages are also caught by the URL guard once S1-T0 lands; the flag makes the exclusion explicit and survivable).
- **Acceptance criteria:**
  - VERIFY: `node -e` calling `explainExclusion(data, show, path)` on each file returns an exclusion reason

### Task S1-T4: Clear the 11 numeric Show-Score relays
- **Complexity:** S
- **Depends on:** S0-T8
- **Parallel:** Yes
- **Files:** 10 files under the-rocky-horror-show-2026/, 1 under titanique-2026/ (numeric `originalScore`)
- **Description:** Delete `originalScore`, set `originalScoreCleared: true`, `originalScoreClearedReason: "bare numeric aggregator relay, outlet publishes no 0-100 rating"` (review-write-guard.js:904-906).
- **Acceptance criteria:**
  - VERIFY: files on origin/main have no `originalScore` and carry the breadcrumb

### Task S1-T5: Re-file misattributed outlets
- **Complexity:** M
- **Depends on:** S0-T8
- **Parallel:** Yes
- **Files:** every-brilliant-thing-2026/nytimes--adam-feldman.json to timeout--adam-feldman.json; 20 about-entertainment--{brantley,isherwood}.json files to nytimes--…; 3 sunday-telegraph files to telegraph; 13 the-lion-king-1997 jasonraize files (set outletId to the real newspaper only if the text is the newspaper's review, else flag nonReview with the S1-T0 breadcrumb)
- **Description:** `safeRenameReview` (review-write-guard.js:2571) plus outletId/outlet fields; keep `url` unchanged. Review files only: `data/outlet-registry.json` is web-repo tracked, so removing `jasonraize` from it happens in S7-T5 (which already edits that file).
- **Acceptance criteria:**
  - VERIFY: `node -e` with `hostMatchesOutletDomain` (scripts/lib/outlet-domain-validation.js) over the touched files reports 0 mismatches

### Task S1-T6: Rebuild and verify every touched show
- **Complexity:** S
- **Depends on:** S1-T1, S1-T2, S1-T3, S1-T4, S1-T5
- **Parallel:** No
- **Files:** none
- **Description:** Dispatch `rebuild-reviews.yml`, `check-prod-deploy.js --wait`, compare live `cs`/`rc` per show against the expected list written in the scratchpad before the rebuild.
- **Acceptance criteria:**
  - VERIFY: Every Brilliant Thing has one nytimes row (Shaw) and one timeout row (Feldman) in `public/data/shows/every-brilliant-thing-2026.json`
  - VERIFY: Rocky Horror rows show `scoreSource` llm-v6/anchored-v6, none `originalScore-priority0` with numeric rating

### Task S1-T7: Post-push survival check
- **Complexity:** S
- **Depends on:** S1-T6
- **Parallel:** No
- **Files:** scripts/audit/… none; scratchpad script
- **Description:** After the next scheduled `push-review-texts` run, re-read all touched files on origin/main and diff against the committed state.
- **Acceptance criteria:**
  - VERIFY: 0 files reverted (script prints the count)

---

## Sprint 2: Show additions, dates, text
**Demo:** Into the Woods and Cursed Child pages exist before their press nights; Arcadia/Damn Yankees/Caterpillar/Repro Eco/Lost in Del Valle exist; Gruffalo shows closed; Lost Boys synopsis reads as an open show.
**Risks:** `validate-show-venue.js` is Playbill-based and cannot validate London rows (mark `noPlaybillProductionPage: true` with the OLT/venue URL in `revivalSourceUrl`/`links`); no scraper keys locally, so fetch with plain curl -L; every stub must pass `validate-data.js --dry-run` and `check-opening-night-readiness.js`.
**MODEL:** Sonnet.

### Task S2-T1: Add Into the Woods (Noël Coward)
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** /root/broadway-scorecard-data/shows.json
- **Description:** Stub from OLT + TodayTix ttid: previews 2026-09-22, press night 2026-10-07, venue Noël Coward Theatre, category west-end, `priorRuns` pointing at into-the-woods-west-end-2025 (Bridge), `discoverySource: manual-user-request`, `provisional: true`.
- **Acceptance criteria:**
  - VERIFY: `node scripts/validate-data.js --dry-run` 0 errors; `node scripts/check-opening-night-readiness.js --show=into-the-woods-noel-coward-west-end-2026` 0 fail

### Task S2-T2: Add Harry Potter and the Cursed Child (one part, Palace)
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** From 2026-10-09; `priorRuns`/`transferOf` link to the both-parts row; type play.
- **Acceptance criteria:** VERIFY: as S2-T1 for the new id

### Task S2-T3: Add Arcadia (Duke of York's) with a prior-run link
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** Transfer of arcadia-west-end-2026 (Old Vic); LBO review 2026-07-02 gives the opening window; `transferOf` set; the Old Vic row gets `transferredTo`.
- **Acceptance criteria:** VERIFY: `validate-data.js --dry-run` 0 errors; both rows cross-link

### Task S2-T4: Add Damn Yankees (Marquis, 2027)
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** previews 2027-03-24, opening 2027-04-20, id `damn-yankees-2027`; `validate-show-venue.js --show=damn-yankees-2027` (Playbill page exists).
- **Acceptance criteria:** VERIFY: validate-show-venue reports match

### Task S2-T5: Add The Very Hungry Caterpillar Show (DR2), Repro Eco, Lost in Del Valle return
- **Complexity:** M | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** Three Off-Broadway stubs; Lost in Del Valle return gets `priorRuns` referencing the April run; Caterpillar is distinct from the closed MMAC interactive show (different venue, note in `_note`).
- **Acceptance criteria:** VERIFY: `validate-show-venue.js --show=<id>` for each (Playbill lists all three) reports match or a documented no-page

### Task S2-T6: Add the four masked London transfers
- **Complexity:** M | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** Choir of Man (Arts at Marble Arch, from 2026-12-10), Cinderella (Lyric Hammersmith, 2026-11-19), Jane Eyre (Rose Kingston, 2026-10-13), The Cherry Orchard (Riverside Studios, Sept 2026), each with `priorRuns`/`transferOf` to the row that masked it.
- **Acceptance criteria:** VERIFY: `validate-data.js --dry-run` 0 duplicate errors (the dedup check must not fire; if it does, note the case for S5-T1's fixture)

### Task S2-T7: Merge the Human Voice / Seven Deadly Sins pair
- **Complexity:** M | **Depends on:** S0-T9 | **Parallel:** No
- **Files:** shows.json, review-texts dirs for both ids
- **Description:** Keep `the-human-voice-the-seven-deadly-sins-west-end-2026` (open, 5 reviews); move the 6 review files from the off-west-end id with `safeRenameReview` (dedupe by outlet+critic); add the old id to `aliases[]`; retire the old id (S0-T2 tool). Rebuild in S3.
- **Acceptance criteria:** VERIFY: surviving dir has 11 or fewer files with no duplicate outlet+critic; retired list contains the old id; `build-slug-redirects.js` emits the alias

### Task S2-T8: Link the five unlinked transfer pairs
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** Jesus Christ Superstar, Pride, Garry Starr, I'm Every Woman, Abigail's Party: `transferOf` on the later row, `transferredTo` on the earlier.
- **Acceptance criteria:** VERIFY: node one-liner lists 5 reciprocal pairs, 0 dangling ids

### Task S2-T9: Broadway opening dates by hand
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** now-you-see-me-live-2026 and blue-man-group-a-new-holiday-surprise-2026 from their Playbill production pages (curl -L); `openingDateSource: "playbill-manual"`. Also `akaTitles: ["860"]` on billy-crystal-860-2026.
- **Acceptance criteria:** VERIFY: `validate-show-venue.js --show=<id>` reports match for both

### Task S2-T10: West End closing dates
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** the-gruffalo-west-end-2026 closing 2026-09-08 (OLT), status closed; closing dates for im-sorry-prime-minister, deep-azure-globe, here-there-are-blueberries-stratford-east from OLT/venue pages; each stamped `humanCorrectedClosingDate: true`, `closingDateSource`.
- **Acceptance criteria:** VERIFY: `validate-data.js --dry-run` shows 0 "closed with null closingDate" for these ids

### Task S2-T11: Closed Off-Broadway opening dates through the real fixer
- **Complexity:** M | **Depends on:** S0-T9 | **Parallel:** Yes (code part in a worktree, landed before the data run)
- **Files:** scripts/enrich-off-broadway-dates.js (:744 Phase-3 candidates, :874 ELIGIBLE_STATUSES: add `--include-closed-when-year-matches`), tests/unit/enrich-ob-dates-closed-year-match.test.mjs (new), shows.json
- **Description:** No scratchpad re-implementation (§15). The fixer gains a flag that admits closed rows only when the Playbill production page's year equals the show's opening year (keeps the R&J Suite guard at :866-874); run it once for the 73 rows; `openingDateSource: "playbill"`; skipped ids logged. S7-T7 later only swaps the status filter for `isRecentlyLive`.
- **Acceptance criteria:** VERIFY: unit test: closed row + matching year is eligible, closed row + other year is not; run summary prints applied/skipped; `validate-data.js --dry-run` 0 new errors; 5 ids spot-checked against Playbill by hand

### Task S2-T12: Synopses, provisional flags, venue placeholders and spelling
- **Complexity:** M | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** shows.json
- **Description:** Rewrite the 7 future-tense synopses (present tense, same facts); clear `provisional` on the 29 opened rows whose Playbill page matches; set the-comedy-about-spies venue to Adelphi Theatre and category west-end; normalize the 19 venue spelling clusters to the dominant spelling (SoHo Playhouse, 59E59 Theaters - Theater C, St. Ann's Warehouse, Garrick Theatre, The Old Vic…).
- **Acceptance criteria:** VERIFY: the stale-synopsis one-liner from the audit prints 0 ids; `validate-data.js --dry-run` 0 errors; `git diff --stat` on shows.json touches only the intended ids (count them)

---

## Sprint 3: Review recovery
**Demo:** Every Brilliant Thing and Death of a Salesman map to their 2026 DTLI pages; the 32 hidden tier-1/2 reviews count; the 27 stranded files are diagnosed and fixed; Sabrage and Othello have scores.
**Risks:** dtli-slug-map.json and show-score-urls.json have no reconciliation and are rewritten by scrape workflows: commit and push within minutes of editing; clearing flags needs the exact breadcrumb; the pending drain and gathering need scraper keys, so they run in CI (Sprint 7 adds the workflow input) and are tracked in Sprint 8.
**MODEL:** Opus (judgement calls per review file).

### Task S3-T1: Re-map DTLI slugs for 2026 shows
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** /root/broadway-scorecard-data/dtli-slug-map.json
- **Description:** every-brilliant-thing-2026 to `every-brilliant-thing-2`, death-of-a-salesman-2026 to `death-of-a-salesman-3`, celebrity-autobiography-2026 and the-maids to their 2026 pages if they exist; for the other 48 unsuffixed 2026 slugs, curl `-2`/`-3` variants and accept the one whose review-item years are 2026. Commit immediately.
- **Acceptance criteria:** VERIFY: `curl -sL https://didtheylikeit.com/shows/every-brilliant-thing-2/ | grep -c 2026` is positive; file on origin/main has the new slugs

### Task S3-T2: Fix the three wrong Show-Score URLs
- **Complexity:** S | **Depends on:** S0-T9 | **Parallel:** Yes
- **Files:** /root/broadway-scorecard-data/show-score-urls.json
- **Description:** the-other-place-off-broadway-2026, the-peculiar-patriot-off-broadway-2026, pre-existing-condition-off-broadway-2026 pointed at the 2026 pages.
- **Acceptance criteria:** VERIFY: each URL returns 200 and the page title contains the show and a 2026 date

### Task S3-T3: Un-hide the false-positive tier-1/2 reviews
- **Complexity:** M | **Depends on:** S0-T8 | **Parallel:** Yes
- **Files:** the 32 files listed in agentC/flagged-misses-classified-2026.json (in-window URL date), review-texts repo
- **Description:** For each: read the file, confirm the text names the right production, then clear through the breadcrumb (`wrongProductionOverride: true` + `wrongProductionOverrideReason` + `SetAt`/`SetBy`, or the `wrongShow` clear per review-guards.js:1254). Skip and note any that are genuinely wrong.
- **Acceptance criteria:** VERIFY: `node scripts/verify-review-recovery.js --show=<id> --production` exits 0 for each touched show

### Task S3-T4: Diagnose and fix the stranded clean files
- **Complexity:** M | **Depends on:** S0-T8 | **Parallel:** Yes
- **Files:** the 27 files in the "clean but absent" list (Cats Variety, Bug EW, An Ark WSJ, Misanthrope Stage, John Proctor WhatsOnStage, 11 to Midnight TheaterMania…)
- **Description:** `explainExclusion` on each; apply the matching fix (unknown-critic dedup: recover byline from URL/text; duplicate-text: confirm and keep the canonical; cross-market: leave flagged). Record the reason per file in the scratchpad.
- **Acceptance criteria:** VERIFY: `verify-review-recovery.js --show=<id> --production` exits 0; the count of the 27 now scoreable is printed

### Task S3-T5: Rebuild, verify, investigate Sabrage and Othello
- **Complexity:** S | **Depends on:** S3-T1, S3-T2, S3-T3, S3-T4, S2-T7 | **Parallel:** No
- **Files:** none
- **Description:** Dispatch `rebuild-reviews.yml`; confirm live `cs` on the touched shows; dispatch the gather workflow (`gather-reviews.yml`) for every-brilliant-thing-2026 and death-of-a-salesman-2026 so the DTLI remap is exercised now; for sabrage-off-west-end-2026 and othello-off-broadway-2026 read `reviewsRemainingForScore` and the min-review rule to explain the missing score and fix the data cause if any.
- **Acceptance criteria:** VERIFY: after the gather run, Every Brilliant Thing and Death of a Salesman `rc` are higher than before it; Sabrage/Othello either show `cs` or the reason is written in the scratchpad

**PROGRESS 2026-09-28 (review-texts 11084bf5, 83dcefe8; web data maps in this batch):**
- S3-T1: DTLI map: every-brilliant-thing-2026 -> every-brilliant-thing-2, death-of-a-salesman-2026 -> death-of-a-salesman-3 (35/33 mentions of 2026 vs 1). The other 47 unsuffixed 2026 slugs were probed for -2/-3 pages: none exists, and 35 of the 47 base pages carry no 2026 review items (DTLI has no page for them yet). The maps live in the web repo's data/, not core data as the plan said.
- S3-T2: only the-other-place needed a change (-> the-other-place-the-shed); the-peculiar-patriot and pre-existing-condition already point at pages that carry the 2026 production.
- S3-T3: 15 files cleared (8 wrongProduction, 7 wrongShow). The wrongShow ones were CV "preview/feature" verdicts at high confidence with no human hatch in explainExclusion, so review-guards.js gained cvWrongArticleManuallyCleared() (wrongArticleManualClear / humanReviewedWrongArticle:false, both already PROTECTED) at both CV gates, and their "invalid" tier (derived from the same verdict) was restored to complete. Kept flagged: Mother Russia (pre-opening), Paranormal Activity (roundup), The Receptionist Marshall (pre-opening), The Unknown NYT pair (byline unresolved; text duplicated under two bylines). NYSR Garry Starr byline fixed from the article text.
- S3-T4: the local "clean but absent" recomputation is too noisy (165 hits: unknown-critic and excerpt-only duplicates the rebuild dedups); the authoritative list needs the CI rebuild's exclusion ledger, which is not committed anywhere reachable. Deferred to S7-T? tooling (persist the ledger as an artifact) rather than guessed.
- S3-T5: Sabrage (2 reviews) and Othello (2 live, 34 in the no-byline pending strand) sit under the minimum-review threshold; the strand drain (replay-pending-bylines.js) needs the CI workflow input from S7 and is tracked in S8.

---

## Sprint 4: Discovery and ingestion hardening
**Demo:** A CI run with the Playbill Broadway feed dark goes red; the parser handles 860/Blue Man/School Girls; concerts at Carnegie Hall and rugby at Twickenham are rejected at ingest; the Off-West End promoter exists and promotes staged candidates in dry-run.
**Risks:** `.github/workflows/**` edits (recorded plan-review verdict covers §18); making the coverage step fail must not stop the status flips in the same job, so use a final failing step; `fetchPage()` for OLT changes the fetch tier and may need the Playwright fallback in CI.
**MODEL:** Opus for T1, T11, T12; Sonnet for the rest.

### Task S4-T1: (moved to S0-T2c)

### Task S4-T2: Coverage guard honours "rotted"
- **Complexity:** S | **Depends on:** S0-T2c | **Parallel:** Yes
- **Files:** scripts/check-broadway-source-coverage.js (:65), tests/unit/broadway-source-coverage-rotted.test.mjs (new)
- **Description:** When `checkSilentRot` returns `'rotted'`, write `{blind: true, count: null}` state, skip the gaps file, exit 1.
- **Acceptance criteria:** VERIFY: test passes; running the script against an empty-entries fixture exits 1 and writes `blind: true`

### Task S4-T3: Workflow goes red when a source is blind
- **Complexity:** S | **Depends on:** S4-T2 | **Parallel:** No
- **Files:** .github/workflows/update-show-status.yml (:250-256 and a new final step)
- **Description:** Keep `continue-on-error` on the guard step so status flips still run; add a last step "Fail if a discovery source is blind" that reads `data/audit/discovery-source-coverage.json` (zeroStreak ≥ 3 on playbillBroadway/olt/theatremonkey) or the blind state and exits 1.
- **Acceptance criteria:** VERIFY: `node scripts/lib/discovery-source-coverage.js`-based check script exits 1 on the current file (streaks 22-23) and 0 on a healthy fixture; workflow YAML validates (`npx yaml-lint` or `node -e` parse)

### Task S4-T4: Port the OLT fetch to `fetchPage()`
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/discover-new-shows.js (:820 raw https.get)
- **Description:** Replace the raw fetch with `fetchPage()` (scraper.js) per the scraper rule; keep the JSON-LD parse.
- **Acceptance criteria:** VERIFY: `node scripts/discover-new-shows.js --dry-run --source=olt` (or the equivalent flag) logs a non-zero OLT count locally

### Task S4-T5: Last-success markers for Theatremonkey and Lortel; fix the Theatremonkey venue gap
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/discover-new-shows.js (Theatremonkey index path, ~:749 TM_INDEX_URL and its candidate filter), scripts/enrich-west-end-dates.js, scripts/promote-ob-venue-candidates.js (Lortel :539), scripts/lib/playbill-broadway-schedule.js (reuse the marker pattern at :34)
- **Description:** Root cause seen in the Sprint 0 dry-run: "Theatremonkey: skipped 80 candidates — index has no venue data (card #1060)", so the source has returned 0 in every run since it was added; the index page lists titles only and each show page carries the venue. Fetch venue from the show page (bounded, cached) or drop the venue requirement for Theatremonkey candidates that match an OLT/TodayTix title. Also: OLT returned 100 shows locally in the same run, so its 22-run zero streak is a CI-fetch problem, which S4-T4's `fetchPage()` port addresses. Write `data/audit/<source>-last-success.json` on a non-empty parse; log a soft-404 warning after 3 consecutive empties.
- **Acceptance criteria:** VERIFY: unit test for the marker helper; a run against the current Lortel 404 logs the warning

### Task S4-T6: `NON_THEATRE_VENUE_RE` and the ingest gate
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/venue-classification.js (beside :78), scripts/discover-new-shows.js (:254 isNonTheaterContent, :363-376 OB admission, :652-690 and :817-927 London paths), tests/unit/non-theatre-venue.test.mjs (new)
- **Description:** One regex for stadiums, arenas, concert halls, cabaret rooms (both markets); `isNonTheaterContent` consults it; TodayTix Off-Broadway rows at a matching venue require category Plays or Musicals; London paths reject matches outright.
- **Acceptance criteria:** VERIFY: test covers Carnegie Hall + Concerts (reject), New Victory + Plays (accept), Twickenham (reject), Sadler's Wells + "musical" (accept)

### Task S4-T7: "West End" is a placeholder venue
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/placeholder-venue.js (new home for `UNKNOWN_MARKERS` + `isPlaceholderVenue`), scripts/audit-placeholder-venues.js (:66/:90 import from the lib; this is the copy `venue-classification.js:16` and `sanitizeVenueForWrite` :257 consume today), scripts/lib/venue-write-guard-detector.js (:145 source-lint copy, import the same set)
- **Description:** Add `west end`, `off-broadway`, `various` to the markers; move the set into `scripts/lib` and import it from both consumers so the write-time check and the lint agree.
- **Acceptance criteria:** VERIFY: `node scripts/audit-placeholder-venues.js` reports the-comedy-about-spies (before S2-T12 lands) or 0 after; `sanitizeVenueForWrite("West End")` returns the placeholder result in a unit test

### Task S4-T8: One-night and validate-data checks for non-theatre rows
- **Complexity:** S | **Depends on:** S4-T6 | **Parallel:** Yes
- **Files:** scripts/validate-data.js, scripts/discover-new-shows.js (isOneNightShow bypass when TodayTix returns "null" dates)
- **Description:** validate-data WARNs on rows matching `NON_THEATRE_VENUE_RE` that have no review, are not opera and are not at a theatre venue (the owner's keep rule); discovery skips one-night rows even when dates arrive as the string "null".
- **Acceptance criteria:** VERIFY: `validate-data.js --dry-run` warning count equals the length of the retire list in `non-theatre-decision-d3.json` (39) before Sprint 8 and 0 after

### Task S4-T9: West End promoter title and match fixes
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/we-listing-discover.js (matchWestEndVenueFromSlug), scripts/lib/candidate-dedup.js (:53-60 findExistingMatch), scripts/promote-we-aggregator-candidates.js, tests
- **Description:** Strip venue tokens and `review\d*` from slug-derived titles; when venue strings don't match, fall back to normalized-title match within the London pool; persist rejected candidate hashes so one bad candidate can't block the batch.
- **Acceptance criteria:** VERIFY: test: "dracula-noel-coward-review2" resolves to Dracula and matches dracula-west-end-2025; `--dry-run` on the current log's 16 ids promotes 0 duplicates

### Task S4-T10: West End promotion workflow fails loudly
- **Complexity:** S | **Depends on:** S4-T9 | **Parallel:** No
- **Files:** .github/workflows/promote-we-aggregator.yml (:73-92)
- **Description:** Drop `set +e … exit 0`; let validate-data's exit code fail the job; surface the refused ids in the digest.
- **Acceptance criteria:** VERIFY: YAML parses; a dry-run dispatch reports success with the fixed promoter

### Task S4-T11: Build the Off-West End promoter
- **Complexity:** M | **Depends on:** S4-T6 | **Parallel:** Yes
- **Files:** scripts/promote-owe-venue-candidates.js (new, mirrors promote-we-aggregator-candidates.js: `decideOffWestEndVenuePromotion`, `buildOffWestEndVenueShowEntry`, `collectCandidates`, `main` with `--dry-run`), scripts/lib/owe-venue-staging.js (add `updateStaging`), tests/unit/promote-owe-venue-candidates.test.mjs
- **Description:** Confirmation = candidate venue is one of `VENUE_LISTING_PAGES` (discover-new-shows.js:1056) and the venue page still lists the title; `findExistingMatch` for dedup; retired-id check; writes with the shows write guard.
- **Acceptance criteria:** VERIFY: `node scripts/promote-owe-venue-candidates.js --dry-run` lists the 38 staged candidates with no row and 0 duplicates; unit test passes

### Task S4-T12: Schedule the Off-West End promoter
- **Complexity:** S | **Depends on:** S4-T11 | **Parallel:** No
- **Files:** .github/workflows/promote-we-aggregator.yml (add a step) or a new workflow
- **Description:** Daily run after the venue-page discovery; same failure semantics as S4-T10.
- **Acceptance criteria:** VERIFY: first CI run promotes at least one staged candidate and validate-data passes

### Task S4-T14: Listing policy for future shows (owner D3: turn the list into a rule)
- **Complexity:** S | **Depends on:** S4-T6 | **Parallel:** Yes
- **Files:** docs/show-inclusion-policy.md (new), tests/fixtures/inclusion-policy/examples.json (new, drawn from `non-theatre-accounting.json`), tests/unit/inclusion-policy.test.mjs (new, requires `isNonTheaterContent` and `NON_THEATRE_VENUE_RE`)
- **Description:** One page stating the rule the code enforces: admit staged productions (plays, musicals, opera, dance-theatre) at theatre venues and anything TodayTix tags Plays or Musicals; reject at ingest stadiums, arenas, concert halls and cabaret rooms unless tagged Plays/Musicals, TodayTix categories Concerts/Events/Landmarks/Films/Conversations, festival/panel/screening/Q&A titles, one-night bookings, and receiving-house tour stops in London categories; safety valve: anything a registered outlet reviews or an aggregator roundup lists is admitted by the aggregator promoters regardless. The fixture holds 20 keep and 20 reject examples from this audit so the rule cannot drift silently.
- **Acceptance criteria:** VERIFY: `node --test tests/unit/inclusion-policy.test.mjs` passes on all 40 examples; `validate-data.js --dry-run` warns on any live row the policy rejects (S4-T8)

### Task S4-T13: Synopsis refresher gets its key; stale regex widened
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** .github/workflows/update-show-status.yml (:333-343 add `env: ANTHROPIC_API_KEY`), scripts/lib/synopsis-validation.js (:78 STALE_FUTURE_RE add `\bupcoming\b`, `is coming`), its unit test
- **Description:** The job currently no-ops for lack of a key; the detector misses "is an upcoming 2026 musical".
- **Acceptance criteria:** VERIFY: unit test asserts `classifyBadSynopsis` flags the Lost Boys sentence; workflow YAML parses

---

## Sprint 5: Dedup, ids, rename tool, critic redirects
**Demo:** A same-title candidate starting after the old run's closing date creates a new row; a wrong-year id is warned at validate time; `rename-show-id.js --dry-run evita-2026 evita-2027` lists every file it would touch across three repos; `/critics/<old-slug>` redirects.
**Risks:** dedup has three tests suites and NT parent/child cases (deduplication.js:499-540) that must keep passing; the rename tool spans three repos and a Supabase table; middleware matcher change touches every request.
**MODEL:** Opus.

### Task S5-T1: Extend `isMultiProduction` with start-after-close semantics
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/deduplication.js (:419 isMultiProduction, :900 startsAfterClosedTwin, :911 twin guard), tests/unit/show-dedup-temporal.test.mjs
- **Description:** A candidate whose `previewsStartDate`/`unconfirmedStartDate` is after the existing row's `closingDate` (or at a different venue 120+ days after its opening) is a new production; the twin guard delegates to the same rule. Fixtures: Into the Woods (Bridge closed May, Noël Coward Sept), Arcadia (Old Vic to DoY), Lost in Del Valle (Apr to Sept), and the existing NT parent/child cases stay duplicates.
- **Acceptance criteria:** VERIFY: `node --test tests/unit/show-dedup-*.test.mjs tests/unit/discovery-production-match.test.mjs` all pass incl. the 3 new fixtures

### Task S5-T2: Title-order swap detection
- **Complexity:** S | **Depends on:** S5-T1 | **Parallel:** Yes
- **Files:** scripts/lib/deduplication.js (Check 7 area :745-759), test
- **Description:** Compare sorted title-token sets when venues match, so "The Human Voice / The Seven Deadly Sins" equals its swapped form.
- **Acceptance criteria:** VERIFY: test with the Charing Cross pair returns duplicate

### Task S5-T3: `stripIdSuffix` uses `stripMarketSuffix`
- **Complexity:** S | **Depends on:** S5-T1 (same file, same track) | **Parallel:** No
- **Files:** scripts/lib/deduplication.js (:694), scripts/validate-shows-prebuild.js (:35), scripts/lib/market-slug.js (:23)
- **Description:** Replace both local regexes with the shared helper so `-off-west-end-2026` strips correctly.
- **Acceptance criteria:** VERIFY: test: `holy-fool-off-west-end-2026` strips to `holy-fool`

### Task S5-T4: Id year from dates; validate-data warning
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/todaytix-dates.js (:95-101 productionIdYear), scripts/discover-new-shows.js (:2417-2428), scripts/validate-data.js
- **Description:** `productionIdYear` already prefers opening, then previews, then unconfirmed start (:95); the drift comes from candidates that had no date at minting. Add `idYearProvisional: true` when the fallback year is used, a validate-data WARN when a non-closed id's year matches neither date year, and a per-id root-cause note for the 22 (which source minted each, and why no date was present).
- **Acceptance criteria:** VERIFY: unit test for the provisional stamp; `validate-data.js --dry-run` lists the 22 known drifted ids; the root-cause table is in the PR description

### Task S5-T5: London transfer-pair detector
- **Complexity:** S | **Depends on:** S5-T1 | **Parallel:** Yes
- **Files:** scripts/lib/transfer-detection.js, test
- **Description:** Extend the existing pair detector to same-title London rows at different venues within 120 days, emitting `transferOf`/`transferredTo` suggestions (applied by the existing driver).
- **Acceptance criteria:** VERIFY: test detects the Pride (Bridge to West End) pair

### Task S5-T6: `rename-show-id.js` (core data + review texts)
- **Complexity:** M | **Depends on:** S0-T2 | **Parallel:** Yes
- **Files:** scripts/rename-show-id.js (new), scripts/lib/show-id-keyed-files.js (new: the list from the seam report: dtli-slug-map, show-score-urls, show-score, todaytix-ids, todaytix-showtimes, show-schedules, image-sources, ibdb-image-cache, opening-night-sent, playbill-urls, audience-buzz, audience-reviews-lbo, awards, grosses, grosses-history, critic-consensus, commercial*, related-shows, gold-lists-computed, lottery-rush, cast-changes, aggregator-truth*, aggregator-summary, fantasy-*, tony-*, westend-slug-map, bww/lbo-roundup-urls, video-reviews, designations; arrays with `showId`: audience, buzz, diary-shows, new-shows-pending, llm-evaluation-results, llm-scoring-garbage-skips, tony-nominations; id-named dirs: data/cast, data/llm-scores, data/opening-night-timeline, data/social-pulse, data/reviews/by-show, public/data/shows, public/images/shows), tests/unit/rename-show-id.test.mjs
- **Description:** `--dry-run` prints every path and key it would change; apply mode renames the review-texts dir (git mv), rewrites keys, sets `aliases[]` on the show, retires nothing. Refuses if the target id exists.
- **Acceptance criteria:** VERIFY: on a temp copy of all three trees, rename a fixture id, then `grep -rl <old-id>` across the copies returns only `aliases`/redirect entries

### Task S5-T7: Alias fallback in the web app and badge route
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** src/lib/data-core.ts (:374 getShowBySlug), src/app/api/badge/[slug]/route.ts (:102)
- **Description:** Resolve `aliases[]` when the exact slug misses (middleware covers `/show/*`; the badge route has no middleware).
- **Acceptance criteria:** VERIFY: `npx tsc --noEmit` clean; a unit test resolves an alias to its show

### Task S5-T8: Supabase migration for renamed ids
- **Complexity:** S | **Depends on:** S5-T6 | **Parallel:** Yes
- **Files:** supabase/migrations/<ts>_rename_show_ids.sql (new, parameterized template), scripts/rename-show-id.js (emits the SQL for every table with a `show_id` column)
- **Description:** First confirm the table names: `supabase-schema.sql` declares `reviews.show_id`, `watchlist.show_id`, `list_items.show_id`, but `supabase/migrations` only shows user_show_stubs, unmatched_imports and fantasy_*; the live schema wins (read it through the existing Supabase path in scripts/ or ask the owner). The tool then prints the migration for the owner to apply.
- **Acceptance criteria:** VERIFY: `--dry-run` output includes one UPDATE per confirmed `show_id` table for the fixture id

### Task S5-T9: Critic-slug redirects
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** data/critic-slug-aliases.json (new, core data), src/middleware.ts (:29 matcher add `/critics/:slug+`), src/lib/data-reviews.ts (getCriticBySlug alias fallback), scripts/build-slug-redirects.js (emit critic aliases into the compact file)
- **Description:** Owner chose redirects. Old critic slugs (diacritic-broken, merged spellings) map to the canonical slug with a 301.
- **Acceptance criteria:** VERIFY: `npx tsc --noEmit && npx next lint` clean; e2e test hits `/critics/jose-sol-s` and lands on `/critics/jose-solis`

---

## Sprint 6: Scoring guards
**Demo:** A null-URL London relay on a NYC show with a same-critic sibling on the West End twin is excluded at rebuild; a listing page cannot be scored; a bare number is not a rating; a `UP` thumb counts; scoring-delta shows only the intended movement.
**Risks:** every file here is on the scoring-logic watchlist (§12.7): `scoring-delta.js` and `test-temporal-override-regression.js` must run against the full corpus (now cloned) and the summary pasted; the sibling index is a corpus-wide pre-pass so watch rebuild time.
**MODEL:** Opus.

### Task S6-T1: `classifyDualMarketNullUrl` in cross-market-guard.js
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/cross-market-guard.js (beside :500), scripts/rebuild-all-reviews.js (pre-pass beside :1336 crossShowUrlIndex; call near :3417), scripts/lib/review-guards.explain.test.mjs or tests/unit/cross-market-null-url.test.mjs
- **Description:** Pure classifier `({hasUrl, outletIsDualMarket, siblingInOtherMarket, source})` returning `{shouldFlag, reason}`; the rebuild builds a `(critic, publishDate)` index per normalized title across markets in the pre-pass. Theatre Record source with no URL on a NYC show and a London sibling is flagged.
- **Acceptance criteria:** VERIFY: unit test with the R&J case flags, with a Broadway-only critic does not

### Task S6-T2: Guard the cross-market reroute in `migrate-reroute-backlog.js`
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/migrate-reroute-backlog.js (`--cross-market` mode, :112-160: reroutes a file to a same-title sibling in the other market by publish-year proximity and stamps `wrongProductionOverride: true`), tests
- **Description:** Root cause found during the ramp (S0-T7): the R&J Stage file had been routed by title to `romeo-and-juliet-1977`, then the migration's cross-market rescue moved it to the NYC 2026 show because the publish year matched, and set the override, which makes `explainExclusion` include the review whatever the flag says. 37 files carry `wrongProductionOverrideSetBy: migrate-reroute-backlog.js`, all on NYC-market shows, 30 from Theatre Record. Fix: a cross-market reroute may only target a show in the SAME market as the review's source/outlet region (a Theatre Record or London-outlet file never lands on a NYC show unless `priorRuns` names a London run), and a reroute never sets `wrongProductionOverride`; it records a `rerouteNote` only and leaves the classifier to decide.
- **Acceptance criteria:** VERIFY: unit test: a theatre-record file with a NYC target is refused, a London target accepted, and no override field is written; the 37 files are listed in the PR

### Task S6-T3: (moved to S1-T0)

### Task S6-T4: In-window veto for wrongProduction and wrongShow
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/review-guards.js (:203 applyTemporalOverrides, :271 isReviewWithinOwnProductionWindow), tests/unit/hamlet-off-broadway-2026-wrongProduction.test.mjs and a new fixture test
- **Description:** Wire `isReviewWithinOwnProductionWindow` into `applyTemporalOverrides`; extend to `wrongShow`; when the URL slug matches the show title and the date is within the window, downgrade CV confidence regardless of tier (tier gating stays out of the guard layer).
- **Acceptance criteria:** VERIFY: test: Abigail's Party Time Out (URL 2026-08-01, opening 08-19) is not excluded; a review 14 months early still is

### Task S6-T5: Ambiguity check on the numeric path; expose the effective rating
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/rebuild-helpers.js (:549 P0.5 block, :30 isUnambiguousRatingString, :660 call site of `parseOriginalScore`, which is defined in scripts/lib/score-parsers.js:156 and is on the §12.7 watchlist), scripts/rebuild-all-reviews.js (:4805-4809 emit `originalRating` from the effective source), tests
- **Description:** P0.5 requires `isUnambiguousRatingString` (or an OUTLET_VERIFIED source) for non-letter, non-star strings; when `aggregatorStars` drives the score, emit it as `originalRating` and label `scoreSource: "aggregatorStars-relay"`.
- **Acceptance criteria:** VERIFY: test: `55` (number) is rejected, `"3/5"` accepted, `"B+"` accepted; `audit-scores.js` no longer crashes (fix the `startsWith` at :94)

### Task S6-T6: Case-insensitive thumbs and two-bucket disagreement routing
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/rebuild-helpers.js (:46 normalizeThumb, :785-792), tests
- **Description:** `UP/MEH/DOWN` normalize; when both aggregator thumbs disagree with the v6 verdict by two buckets, set `needsAdjudication: true` (the existing adjudication queue consumes it).
- **Acceptance criteria:** VERIFY: test: `UP` equals `Up`; Dog Day Afternoon THR fixture (17, bww Up) sets needsAdjudication

### Task S6-T7: Manual-entry buckets via `scoreToBucket`
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/manual-review-direct.js (:107), scripts/lib/score-extractors.js (:1570)
- **Description:** Replace the hardcoded 75/30 thresholds; add a regression test.
- **Acceptance criteria:** VERIFY: test: 74 maps to Positive, 48 to Negative

> **Delegated 2026-09-28:** S6-T8a through S6-T8e are owned by a separate session (owner handed it a standalone prompt). This session does not touch scripts/lib/text-quality.js, scripts/lib/llm-confidence.js, the adjudication queue, or the rescore flag until that session reports back on BRO-4204. S6-T8f (residual weighting) stays here. Notes for that session from the sprint critique: `llmScore` is a PROTECTED field, so S6-T8c's re-cap must follow the S0-T7 ramp pattern (one file, confirm it survives the next review-texts push, then batch), and S6-T8d is independent of the rest and can run first.

### Task S6-T8a: Diagnose the confidence cap on unanimous verdicts (owner D4: attack the root cause)
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scratchpad script only (reads /home/user/broadway-review-texts; calls `scripts/lib/text-quality.js getBestTextForScoring` and `scripts/lib/llm-confidence.js capLlmConfidence` offline, no model calls)
- **Description:** 1,021 of the 1,607 low-confidence 2026 reviews are unanimous three-model verdicts (median spread 3 points); 847 of them have complete text over 400 words. `ensemble-scorer.ts:761-766` caps confidence to the lower of agreement and input quality, and `input-builder.ts:296-304` rates input "high" only when `getBestTextForScoring` returns `complete`. Tabulate, per file, the status the classifier returns today versus the file's `contentTier`, and whether `fullText` changed after `llmScore` was written (compare `textFetchedAt`/`scoredAt` style stamps if present, else file mtime vs llmScore timestamp).
- **Acceptance criteria:** VERIFY: the script prints two counts that sum to 1,021: "classifier says complete now" (stale cap) and "classifier still says truncated/corrupted" (classifier defect), with 10 example files each

### Task S6-T8b: Fix the text-quality status for real complete text
- **Complexity:** M | **Depends on:** S6-T8a | **Parallel:** Yes
- **Files:** scripts/lib/text-quality.js (status rules), tests/unit/text-quality-status.test.mjs (new, fixtures drawn from S6-T8a's "classifier defect" examples)
- **Description:** Whatever rule marks 400+ word, properly terminated reviews as truncated or corrupted (ending-punctuation heuristic, chrome detector, length ratio against an excerpt) is corrected so `complete` text rates `high`. No change to the cap itself: the cap is right when the input really is a fragment.
- **Acceptance criteria:** VERIFY: the new test passes on the defect fixtures and the existing text-quality tests still pass; re-running S6-T8a's script reports 0 "classifier defect" files

### Task S6-T8c: Re-cap stored confidence offline (no model calls)
- **Complexity:** M | **Depends on:** S6-T8a, S6-T8b | **Parallel:** No
- **Files:** scripts/recap-llm-confidence.js (new; reads each file's stored `ensembleData` agreement and today's input confidence, recomputes `capLlmConfidence`, writes `llmScore.confidence` through `safeWriteReview` with a `confidenceRecappedAt` stamp), test
- **Description:** For files whose text is complete today, the honest confidence is the ensemble's own (high or medium). Files whose text changed materially since scoring are not re-capped; they are queued for a rescore in CI (S6-T8e) instead, because the score itself may be stale.
- **Acceptance criteria:** VERIFY: `--dry-run` prints how many of the 1,607 would move to high/medium and how many go to the rescore queue; after apply and rebuild, the 2026 low-confidence count printed by the audit one-liner drops accordingly

### Task S6-T8d: Adjudicate the 86 genuinely split verdicts in CI (no local key needed)
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** data/audit/needs-human-review.json (the queue `scripts/adjudicate-review-queue.js:32` reads), .github/workflows/adjudicate-review-queue.yml (already has `ANTHROPIC_API_KEY`; dispatch)
- **Description:** Enqueue the 86 reviews with no bucket consensus, a bucket disagreement, or |delta| ≥ 30 (Beetlejuice/Theatre South East 30 vs "Rave", Dog Day Afternoon/Theater Life, The Fear of 13/NYSR…); dispatch the workflow; the stronger model re-reads each and writes `adjudicatedScore`.
- **Acceptance criteria:** VERIFY: workflow run succeeds; Beetlejuice/Theatre South East `scoreSource` becomes `adjudicated` and its bucket is no longer Pan

### Task S6-T8e: Recover text for low-confidence fragments; rescore in CI
- **Complexity:** S | **Depends on:** S6-T8c | **Parallel:** Yes
- **Files:** none new; existing recovery (`verify-review-recovery.js`, the review-refresh workflow) and the rescore queue (`needsRescore` flag consumed by the scoring workflow)
- **Description:** The 184 low-confidence 2026 reviews on truncated/excerpt/stub text get a text-recovery pass in CI, then a rescore; the files S6-T8c queued because their text changed since scoring join the same queue. This is the part that needs the API key, and CI has it.
- **Acceptance criteria:** VERIFY: after the CI runs, the count of 2026 reviews with `contentTier` in {truncated, excerpt, stub} and `scoreConfidence: low` is below 100, and none of the S6-T8c queued files still carries the old `llmScore` timestamp

### Task S6-T8f: Residual weighting decision
- **Complexity:** S | **Depends on:** S6-T8c, S6-T8d, S6-T8e | **Parallel:** No
- **Files:** scripts/lib/compute-critic-score.js (:186-192), src/lib/engine.ts (:475-483), parity test (only if the owner wants it)
- **Description:** After the root-cause fixes, report the residual low-confidence count to the owner. Apply a 0.75 weight only if the residual is still material (guide: above 5% of scored reviews); otherwise no weighting change.
- **Acceptance criteria:** VERIFY: residual count reported on BRO-4204; if weighting ships, the parity test passes and scoring-delta shows only the intended movement

### Task S6-T9: Scoring-delta and temporal regression
- **Complexity:** S | **Depends on:** S6-T1…S6-T7, S6-T8b, S6-T8c | **Parallel:** No
- **Files:** none
- **Description:** `REVIEW_TEXTS_DIR=/home/user/broadway-review-texts node scripts/scoring-delta.js` and `node scripts/test-temporal-override-regression.js`; paste the summaries in the PR and the Linear comment; only intended movement allowed.
- **Acceptance criteria:** VERIFY: both commands exit 0; delta summary pasted

---

## Sprint 7: Critic canonicalization, fixer scope, tooling
**Demo:** One `displayCriticName` produces every critic string on the site and in the mobile JSON; "Archive" and outlet names no longer have critic pages; the pending drain runs for closed shows; validate-data no longer needs six flags to be safe.
**Risks:** critic pages are ISR (12h) so verify after a deploy plus revalidate; `TOP_CRITICS` is an exact-string set; the alias file is rewritten weekly by `weekly-integrity.yml`, so the picker fix must land in the same PR as the alias-file cleanup.
**MODEL:** Opus for T1-T3, Sonnet for the rest.

### Task S7-T1: `displayCriticName` helper
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/critic-display-name.js (new), scripts/lib/review-normalization.js (:217 CRITIC_ALIASES, :326-341 loader, :465 JUNK_BYLINES), scripts/lib/placeholder-byline.js (:28, :71), scripts/lib/critic-canonicalization.js (:90), tests/unit/critic-display-name.test.mjs
- **Description:** `displayCriticName(raw, outlet, registryEntry)` = canonicalizeCritic → alias table (CRITIC_ALIASES + auto file + the 37 `CRITIC_NAME_FIXES` moved in) → merged placeholder list (JUNK_BYLINES ∪ GENERIC_BYLINE_TERMS ∪ archive/uncredited/condé nast/written by/reviewed by) → `null`. Suffix stripping (job titles, pronouns, HTML residue) happens once, at capture time in S7-T4, not here; the helper only canonicalizes and filters.
- **Acceptance criteria:** VERIFY: test table: "Archive" → null; "The Stage" (outlet The Stage) → null; "Ben Brantly" → "Ben Brantley"; "Juan A. Ramirez" and "Juan A. Ramírez" → one value

### Task S7-T2: Single call site at emission; consumers drop their own maps
- **Complexity:** M | **Depends on:** S7-T1 | **Parallel:** No
- **Files:** scripts/rebuild-all-reviews.js (:4774-4780), src/lib/data-reviews.ts (:18 remove CRITIC_NAME_FIXES, :287, :321 filter null), scripts/generate-mobile-show-details.js (:393 TOP_CRITICS on canonical, :520)
- **Description:** reviews.json carries the display name or null; the site groups by it and filters null; mobile JSON emits it unchanged.
- **Acceptance criteria:** VERIFY: `npx tsc --noEmit` clean; unit test on data-reviews grouping excludes null; scoring-delta unchanged (names only)

### Task S7-T3: Diacritic-safe slugs
- **Complexity:** S | **Depends on:** S5-T9 | **Parallel:** Yes
- **Files:** src/lib/data-core.ts (:602 slugify), data/critic-slug-aliases.json (entries for the 12 non-ASCII names)
- **Description:** NFKD fold before slugifying; old slugs go into the alias file so S5-T9 redirects them.
- **Acceptance criteria:** VERIFY: unit test: "José Solís" → `jose-solis`; alias file has `jose-sol-s`

### Task S7-T4: Byline capture accepts curly apostrophes and strips suffixes
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/byline-extraction.js (:31-41), scripts/lib/byline-normalization.js (:24), tests
- **Description:** Character class includes `’` and `&rsquo;`; trailing ", Chief Theatre Critic", "(she/her)", `<br>`/`>` stripped at capture.
- **Acceptance criteria:** VERIFY: test: "Holly O’Mahony" captured whole; the five artifacts from the audit normalize

### Task S7-T5: Alias picker refuses alias-as-canonical; clean the alias file
- **Complexity:** S | **Depends on:** S7-T1 | **Parallel:** No
- **Files:** scripts/detect-critic-typos.js (:93, :139-143), data/auto-critic-aliases.json (15 conflicts, 9 typo canonicals), data/outlet-registry.json (thereviewshub defaultCritic → null)
- **Description:** The picker never chooses a canonical that is itself an alias elsewhere and prefers the registry spelling; the file is cleaned in the same PR so the weekly run cannot re-poison it.
- **Acceptance criteria:** VERIFY: unit test; `node scripts/detect-critic-typos.js --dry-run` proposes 0 changes on the cleaned file

### Task S7-T6: URL-host vs outlet-id advisory at rebuild
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/rebuild-all-reviews.js (:4759-4762), scripts/lib/outlet-domain-validation.js (:52 VALIDATED_INGEST_SOURCES)
- **Description:** When the URL host belongs to another registered outlet and tiers differ, log an advisory line and set `outletHostMismatch: true` in the emitted row (audit consumes it); exempt wire services, newspapers.com, web.archive.org.
- **Acceptance criteria:** VERIFY: unit test with the Feldman/timeout case; `reviews.json` stats print the mismatch count

### Task S7-T7: `isRecentlyLive` helper and fixer adoption
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/lib/show-liveness.js (new, `isRecentlyLive(show, {withinDays, allowClosed, today})`), scripts/lib/zero-review-catchup.js (:74), scripts/lib/opening-night-completeness.js (:20/:48), scripts/replay-pending-bylines.js (:135 add `--closed-within-days`), scripts/enrich-off-broadway-dates.js (:874 keep closed exclusion; Phase-3 same-date queue may include closed rows only when the Playbill page year matches), tests
- **Description:** One predicate, four callers; the OB date fixer's deliberate guard is preserved by construction.
- **Acceptance criteria:** VERIFY: unit test for the helper; each caller's existing test still passes; `replay-pending-bylines.js --closed-within-days=120 --dry-run` lists the 86 closed strand shows

### Task S7-T8: Weekly drain of the full pending backlog
- **Complexity:** S | **Depends on:** S7-T7 | **Parallel:** No
- **Files:** .github/workflows/enrich-reviews.yml (:181-189; add a weekly `--all-pending` step and a `workflow_dispatch` input)
- **Description:** The existing `--all-pending` flag is scheduled; a dispatch input lets Sprint 8 drain on demand.
- **Acceptance criteria:** VERIFY: YAML parses; a dispatch with the input runs the drain for one closed show and its `_pending` count drops

### Task S7-T9: DTLI slug year check; reproduce the Show-Score 8-tile cap
- **Complexity:** M | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/discover-dtli-slugs.js (:380), scripts/lib/review-guards.js (:44-66 pickBestDtliSlug), tests; Show-Score: investigation only (pagination is already followed at `gather-reviews.js:713` and `show-score-discover.js:122`, and `fetch-aggregator-pages.ts:271` scrolls the carousel)
- **Description:** Reject a DTLI slug whose review-item years all predate the show's year; `--force` re-probes 2026 ids. For Show-Score, reproduce the "extracted exactly 8 of N" result on bug-2026 and name the path that stops early; fix only if the reproduction shows a real defect (otherwise record the finding and drop it).
- **Acceptance criteria:** VERIFY: unit test for the year rule; a written reproduction note for bug-2026 naming the stopping path (or "no defect")

### Task S7-T10: West End closing-date and age-guidance backfill from OLT
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/enrich-west-end-dates.js (OLT JSON-LD already fetched in discovery; add closing + `ageRecommendation` fill), tests
- **Description:** Fill `closingDate` (source `olt`) and `ageRecommendation` when null; never overwrite `humanCorrectedClosingDate` rows.
- **Acceptance criteria:** VERIFY: `--dry-run` proposes closings for open WE shows OLT lists as closed; unit test for the guard

### Task S7-T11: Tooling fixes
- **Complexity:** S | **Depends on:** None | **Parallel:** Yes
- **Files:** scripts/audit-scores.js (:94), scripts/rebuild-all-reviews.js (:1020-1036 stats keys), scripts/audit-placeholder-venues.js (use the lib), scripts/lib/score-conversion-rules.js (`NN%`)
- **Description:** Four small fixes found by the audit tooling.
- **Acceptance criteria:** VERIFY: `node scripts/audit-scores.js` runs to completion; `_meta.stats.scoreSources` has non-null llm-v6/anchored-v6/adjudicated after the next rebuild; `audit-score-conversions.js` reports 0 unparseable

---

## Sprint 8: Follow-on batches and wrap-up
**Demo:** Evita, Gloria, Paddington, Purple Rain, Wanted and Dolly live at correct-year URLs with the old ones redirecting; the 39 non-show rows are gone and the 83 kept rows are untouched (D3); Off-West End coverage includes the ~65 missing productions; the pending backlog for closed 2026 shows is drained.
**Risks:** one rename per land run (pre-mortem); removals only after S4-T6/T8 are live in CI; OWE adds only through the promoter.
**MODEL:** Sonnet.

### Task S8-T1: Rename the 22 wrong-year ids, one per land run
- **Complexity:** M | **Depends on:** S5-T6, S5-T7, S5-T8 | **Parallel:** No
- **Files:** three repos via `rename-show-id.js`
- **Description:** Order: wanted-2022, dolly-an-original-musical-2026, evita-2026, gloria-2026, purple-rain-2026, paddington-the-musical-2026, then West End, then Off. After each: `check-prod-deploy.js --wait`, curl old and new URLs, per-id review-count diff.
- **Acceptance criteria:** VERIFY: for each id, old URL 301s to new, new page has the same `rc` as before

### Task S8-T2: Retire the 39 non-show rows (owner D3: keep anything that gets or might get reviewed)
- **Complexity:** M | **Depends on:** S4-T6, S4-T8, S4-T14, S0-T2 | **Parallel:** No
- **Files:** shows.json, retired list, archive; list in scratchpad `non-theatre-decision-d3.json`
- **Description:** Owner rule: keep a row if it has any critic review, is opera, or sits at a theatre venue (it might get reviewed). Remove only rows that never get theatre reviews: the 10 junk rows (panels, festivals, NT Live screenings, a rugby match, the phantom), 5 tour stops at receiving houses, 5 student showcases and arena kids shows, 1 stand-up WIP night, and 18 zero-review cabaret or concert bookings at Joe's Pub, 54 Below, Carnegie Hall and the like. 83 rows stay. The 10 junk rows go first and are confirmed gone through one discovery cycle before the other 29.
- **Acceptance criteria:** VERIFY: after two `update-show-status` runs, `validate-data.js --dry-run` prints 0 retired ids present; the 83 kept ids are all still in shows.json

### Task S8-T3: Off-West End additions through the promoter
- **Complexity:** M | **Depends on:** S4-T11, S4-T12 | **Parallel:** Yes
- **Files:** data/audit/owe-venue-candidates.json, shows.json
- **Description:** Stage the ~45 reviewed and ~20 announced productions from the audit's list (agentB/findings-summary.json) as candidates with venue and dates; let the promoter admit them; reviews arrive via the poller and drain. Runs after S8-T1's renames finish (both write shows.json; the coordinator serializes).
- **Acceptance criteria:** VERIFY: promoter run adds them with 0 validate-data errors (the week-later coverage check moves to S8-T5)

### Task S8-T4: Drain and gather in CI
- **Complexity:** S | **Depends on:** S7-T8 | **Parallel:** Yes
- **Files:** none
- **Description:** Dispatch the drain for the 86 closed strand shows; dispatch gather for the ~12 real zero-review shows (The Peculiar Patriot, Myra's Story, Midnight in the Toyshop, You're a Good Man Charlie Brown…).
- **Acceptance criteria:** VERIFY: othello-off-broadway-2026 `_pending` count drops from 34 and the show gets a `cs`

### Task S8-T5: Wrap-up
- **Complexity:** S | **Depends on:** all | **Parallel:** No
- **Files:** memory/completed-migrations.md (one line), Linear BRO-4204
- **Description:** `/wrap-up`: verify deploys live, re-run the audit's headline one-liners (should print 0 for each class), Outcome comment on BRO-4204, state Done with `PR-EVIDENCE` lines.
- **Acceptance criteria:** VERIFY: the 15 symptom checks from `2026-data-audit-report.md` §1 each print 0 or the documented residual; at least 70% of the reviewed Off-West End additions from S8-T3 have `rc > 0` (checked here, a week after S8-T3)

---

## Dependencies Graph
S0-T1, S0-T2 → S0-T3/T4/T5 → S0-T6 → S0-T9 (ramp 2). S0-T7 → S0-T8 (ramp 1, independent of code). Gate 24h → Sprint 1 (all on S0-T8) → S1-T6 → S1-T7.
Sprint 1: S1-T0 lands first; S1-T3 ← S1-T0. Sprint 2 tasks depend on S0-T9 and S0-T2b (dedup stopgap); S2-T11's code part lands before its run; S2-T7 feeds S3-T5. Sprint 3 depends on S0-T8/S0-T9. Sprint 4 has no data dependencies (code only); S4-T3 ← S4-T2 ← S0-T2c; S4-T13 ← S4-T3 (same workflow file); S4-T10 ← S4-T9; S4-T12 ← S4-T11 ← S4-T6; S4-T14 ← S4-T6. Sprint 5: S5-T2/T3/T5 ← S5-T1; S5-T8 ← S5-T6. Sprint 6: S6-T5 ← S6-T1 (same file); S6-T8f ← the delegated S6-T8a-e; S6-T9 ← all. Sprint 7: S7-T2 ← S7-T1; S7-T5 ← S7-T1; S7-T3 ← S5-T9; S7-T8 ← S7-T7. Sprint 8: S8-T1 ← S5-T6/T7/T8; S8-T2 ← S4-T6/T8/T14 + S0-T2; S8-T3 ← S4-T11/T12 and after S8-T1; S8-T4 ← S7-T8.

## Subagent Execution Map (within one /execute-plan session)
Rule for data sprints (1, 2, 3, 8): subagent tracks produce patches or edit lists in the scratchpad; only the coordinator writes to shows.json or the review-texts repo, serially, one batch per commit. Rule for code sprints: no two tracks edit the same file.

Session 1 (Sprint 0):
Subagent track 1:  S0-T1 → S0-T5 (validate-data.js)
Subagent track 2:  S0-T2 → S0-T3 → S0-T4 (retired ids, discovery, reconcile + action)
Subagent track 3:  S0-T2b → S0-T2c (deduplication.js, playbill parser)
Subagent track 4:  S0-T7 → S0-T8 (review-texts ramp, coordinator commits)
Sync:              ──── S0-T6 land ──── S0-T9 ──── S0-T10 (24h) ────

Session 2 (Sprint 1): code track S1-T0 (land first); analysis tracks S1-T1/T2 | S1-T3/T4 | S1-T5 produce edit lists; coordinator applies and commits serially; S1-T6, S1-T7.
Session 3 (Sprint 2): analysis tracks S2-T1/T2/T3/T4 | S2-T5/T6/T8 | S2-T9/T10 | S2-T12 produce stub JSON and diffs; S2-T11 code part lands first, then its run; coordinator applies all shows.json edits serially; S2-T7 last.
Session 4 (Sprint 3): analysis tracks S3-T1/T2 | S3-T3 | S3-T4 produce edit lists; coordinator applies; S3-T5.
Session 5 (Sprint 4): track A S4-T2→T3→T13 (coverage guard, update-show-status.yml) | track B S4-T4→T6→T8→T14 (discover-new-shows.js, venue-classification.js, policy) | track C S4-T9→T10→T11→T12 (promoters, promote-we-aggregator.yml) | track D S4-T5→T7 (markers, placeholder lib).
Session 6 (Sprint 5): track A S5-T1→T2→T3→T5 (deduplication.js, transfer-detection.js) | track B S5-T4 | track C S5-T6→T8 (rename tool) | track D S5-T7→T9 (web app aliases, middleware).
Session 7 (Sprint 6): track A S6-T1→T5 (rebuild-all-reviews.js, cross-market-guard.js, rebuild-helpers.js) | track B S6-T2 | track C S6-T4→T6→T7 | S6-T8f after the delegated session reports; sync S6-T9.
Session 8 (Sprint 7): track A S7-T1→T2→T6→T11 (helper, rebuild-all-reviews.js, tooling) | track B S7-T4→T5 (byline capture, alias picker + registry) | track C S7-T7→T8→T10 (liveness helper, workflows, OLT backfill) | track D S7-T3→T9.
Sessions 9-10 (Sprint 8): S8-T1 one rename per land run; then S8-T3; S8-T4 in parallel (CI dispatches only); S8-T2 after S4 is live; S8-T5 last.

**Parallel sprints (subagent-level, same session):** none; every sprint has file overlap with its neighbours (`discover-new-shows.js`, `validate-data.js`, `rebuild-all-reviews.js`).
**Critical path:** S0 → gate (24h) → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8: 10 sessions minimum (Sprint 8 spans two).
**Max subagent parallelism:** 4.
**Cross-session plan:** one sprint per session, each shipped to main via `land/<name>` before the next starts; Sprint 0's gate is wall-clock (24h), so Session 2 starts the next day.

## Known Edge Cases
- `push-review-texts` restores any PROTECTED field lacking its breadcrumb; `verify-review-recovery.js` reads the working tree, not origin/main, so the survival check must read origin/main.
- `reconcileShowsJson` re-adds remote-only ids when the base snapshot lacks them; the retired list closes that.
- `enrich-off-broadway-dates.js` excludes closed shows on purpose (R&J Suite 2026 was overwritten by a future same-title production); S2-T11 and S7-T7 keep that guard by requiring a year match.
- Playbill has no Off-West End pages: `validate-show-venue.js` cannot validate London stubs; mark `noPlaybillProductionPage` and cite the OLT/venue URL.
- Theatre Record files carry `source: "theatre-record"` and no URL; 49 of 64 in NYC folders are already flagged, 15 are not.
- Critic pages are ISR (12h revalidate); `TOP_CRITICS` is an exact-string set; the auto-alias file is rewritten weekly.
- Ids appear in ~40 data files plus five id-named directories and three Supabase tables.
- `noReviewsExpected` has no consumer in `src/`; hiding is not an option, only removal.
- `update-show-status.yml` has 17 `continue-on-error` steps; a failing guard must not stop the status flips, hence the final failing step.
- The email channel is draft-only (`send-opening-night-broadcast.js` never calls send).
- `llmScore.confidence` is the lower of ensemble agreement and input quality (`ensemble-scorer.ts:761`, `lib/llm-confidence.js`); input quality is "high" only when `text-quality.js` returns `complete` (`input-builder.ts:296-304`). Stored `ensembleData` in each review file allows recomputing confidence offline without model calls.
- `noReviewsExpected` is not a hiding mechanism; the owner's keep rule is "gets or might get reviewed", encoded in S4-T14 and enforced by S4-T6/T8.
- Adjudication runs in CI (`adjudicate-review-queue.yml`, queue `data/audit/needs-human-review.json`) with the repo's `ANTHROPIC_API_KEY`; no local key is needed.

## Changes from Critique
| Change | Reason | Source |
|--------|--------|--------|
| Sprint 0 safety rails precede all data edits | validate-data mutates; no tombstone; push guard restores clears | plan-review (Structure, Pre-mortem, GPT, Gemini) |
| Ramp is one review file + one row with a 24h gate | first increment too large | plan-review Phase 0 + Structure |
| Removals moved to Sprint 8 behind the ingest filters | re-discovery | plan-review (Structure, Pre-mortem) |
| Renames moved to Sprint 8 behind a purpose-built tool with alias, badge and Supabase coverage | no tool exists | plan-review (Structure, Pre-mortem, User impact) |
| Critic naming collapsed into one helper; manual name pass dropped | design P0 | plan-review (Design) |
| Dedup extends `isMultiProduction`; transfer links via detector | design P0 | plan-review (Design) |
| Coverage guard honours "rotted"; final failing step instead of dropping continue-on-error mid-job | third rot mechanism; job semantics | plan-review (Design) + seam report |
| Non-theatre rule as a regex beside `NON_NYC_VENUE_RE` | codebase fit | plan-review (Design) |
| One `isRecentlyLive` helper; OB date fixer keeps its closed exclusion | deliberate guard | plan-review (Structure, Design) |
| Critic-slug redirects added | owner decision 5 | owner |
| Theatre Record ingest guarded at the writer | corpus check found 64 files | this session |

## Key Risks
1. **Silent reverts by CI sync.** Mitigation: breadcrumbs on every clear, per-batch commit+push, origin/main survival check (S1-T7 pattern reused in every data sprint).
2. **Concurrent CI commits to shows.json.** Mitigation: pull immediately before each edit, small batches, RECONCILABLE_FIELDS awareness, retired-id list for deletions.
3. **Scoring-logic regressions.** Mitigation: scoring-delta and temporal regression on the full corpus before Sprint 6 lands; parity tests for every scripts/src pair.

## Progress log

**2026-09-28 (session 01JhF7pK, BRO-4204).**
- **Landed on main:** Sprint 0 (safety rails, ramps 1 and 2 verified), S1-T0 listing-page guard (reviews rebuild dropped the clydes-2021 BWW, great-society Deadline and something-rotten BWW rows), S2-T11 flag, S3-T1..T3 (CV wrongArticle hatch, DTLI/Show-Score remaps). Sprint 1 review-text batch, Sprint 2 core-data batch (10 stubs, 7 priorRuns links, dates, synopses, venues, Human Voice merge) and Sprint 3 clears are live in the private repos.
- **Landing:** the INFLIGHT stop-hook gate (owner request: SAFE TO EXIT must mean the session can be killed; blocks while a background agent has no hand-back or a self-bound Routine is ahead of its fire time). Ref `land/audit-inflight-gate-3` after a cancelled Land job and a CLOUD.md conflict with BRO-4238.
- **Ready to land next (`worktree-audit-s0-safety-rails`, one batch):** S4-T2/T3/T6/T7/T8/T9/T10/T13/T14, S5-T1/T2/T3/T5/T6/T7/T8/T9, S6-T1/T2/T4/T5/T6/T7, S7-T1/T4/T5/T6/T7/T8/T10 from ten isolated agents, cherry-picked and re-verified together: tsc and lint clean, 894 node + 26 tsx tests green, `validate-data --dry-run` 0 errors, workflow lints and concurrency audit clean, temporal-override regression green.
- **Decisions taken while merging:**
  - S4-T6: TodayTix "Events" is not in the category reject set. On the NYC feed it also carries NYU Skirball's reviewed international theatre; the owner's D3 rule keeps anything that gets or might get reviewed. Junk on "Events" still falls to the title regex, the venue gate and the one-night gate.
  - S4-T3: the blind-source verdict runs as its own `discovery-source-blind` job (`needs: update-shows`, `if: always()`), so a blind source turns the run red without skipping create-issue, trigger-data-agent, catch-up dispatch or opening-night readiness. Today's streaks (playbillBroadway/olt/theatremonkey at 24/23/23 zero-candidate runs) will make the run red until S0-T2c's parser fix and S7-T10's OLT reader show up in a live run.
  - S6-T5: the strict published-rating gate would have replaced ~50 T1 star relays (Time Out 60/80, Guardian 80/100, Times 80) with LLM reads. Added the `star-ladder` evidence class: a bare number on the outlet's registry `starScale` ladder is that outlet's published star. New York Daily News gained `starScale: 5` (its Playbill Verdict relays read "3/5 stars"). Scoring-delta vs main: 1,539 source/score changes across 363 shows, 400 T1 rows all label-only (`originalScore-priority0 → aggregatorStars-relay`, thumb-boost relabels), 0 T1 score changes; 14 bare numerics at T2/T3 outlets with no star scale (EW 88, NYPost 60 off the 4-star ladder, a raw "5" at NYSR) now score from the LLM ensemble or assignedScore. One adjudication marker (good-night-and-good-luck timeout, thumbs Down/Down vs anchored 71).
  - S6-T1 corpus scan (scoring-delta cannot execute the rebuild's inline loop): the null-URL relay gate flags 145 theatre-record relays (Oh Mary, Oliver 1984, R&J 1977/1986, Starlight 1987, Playboy 1971, Producers 2001, Tempest 1995, Titanique), every one already excluded as wrongProduction, so reviews.json does not change today; the gate stops the next migration from re-admitting them. S6-T4 in-window veto: 0 currently flagged files change.
  - `audit-scores.js` crash on numeric ratings fixed (S6-T5 acceptance line).
- **Still open:** S4-T4/T5 (OLT fetchPage, Theatremonkey/Lortel markers), S4-T11/T12 (Off-West End promoter), S5-T4, S7-T2 (emission call sites for displayCriticName), S7-T3 (diacritic fold; feeds critic-slug-aliases.json), S7-T9/T11, S6-T8f, S6-T9, Sprint 8 (renames one per land, retire the 39 non-show rows, OWE additions through the promoter, CI drains). Deferred data items: Caterpillar stub (date conflict), about-entertainment pairs (S7-T5 chooser), 10 invalid-tier scored files, S3-T4 stranded list, the-unknown NYT byline pair, Othello/Sabrage below the review minimum.

**2026-09-29 (same session, wave 2).**
- **Batch 1 land (run 36492174430) failed on nine CI gates** none of the ten agents could see in isolation: a test.yml push-path floor (we-promotion-job-summary.js), five venue-write-guard sites that only carry venues into logs/ledgers/evidence (file-level `venue-write-guard-ok` markers), `data/critic-slug-aliases.json` committed by mistake while also shipped by checkout-core-data (untracked), two matchers stripping non-ASCII without folding diacritics (cross-market-guard keys, critic-alias-picker outlet slugs), tmp-repo teardowns without rmSync retries (rename-show-id test), and two tests reading derived data without the structural exemption. Fixed and re-landed as `land/audit-agent-batch-2`. Also: four concurrent agent fetches filled the disk with 8.4 GB of abandoned temp packs and grafted a false shallow boundary onto the branch; cleaned.
- **Wave 2 merged** (`worktree-audit-s0-safety-rails`): S4-T4 (OLT through fetchPage; the raw https.get was HTTP 403 from the Actions runner since 2026-08-14), S4-T5 (Theatremonkey venues from show pages, bounded + cached; per-source last-success markers for olt/theatremonkey/lortel with a 3-empty-run soft-404 warning; markers staged in CI), S4-T11/T12 (Off-West End venue-page promoter + daily `promote-owe-venue-candidates.yml` in the shows-json-writer group; dry-run against the live pages: 20 promote / 78 drop / 8 hold of 106 staged; the seven recitals and talks it would have confirmed are now refused by VENUE_PAGE_EXCLUDE_PATTERNS), S5-T4 (idYearProvisional stamp; validate-data WARNs 45 drifted ids, 22 of them the audit's class A; docs/audit/id-year-drift-2026.md), S7-T2 (one displayCriticName call at emission; critic pages grouped by folded slug; 51 retired slugs seeded into the private critic-slug-aliases.json; 54 placeholder pages such as "Archive" and outlet names go away), S7-T3 (diacritic-safe slugify shared by app and scripts; also moves 46 director/creative/theatre slugs with no redirect — follow-up: extend the redirect map to those routes), S7-T9 (DTLI slug rejected when its review years all predate the show; `--force` unmaps; Show-Score archive: the carousel scroll never triggered pagination, so 357 archives held exactly 8 tiles — fixed with same-origin paginate fetches, bug-2026 archives 19/19), S7-T11 (score-source stats seeded for every label; `NN%` parses, 0 unparseable).
- **Re-verified together:** tsc and lint clean, 675 node + 43 tsx + 310 opening-night tests, all nine gates, workflow lints, validate-data 0 errors, scoring-delta vs main unchanged (400 T1 relabels, 0 score moves), temporal regression green.
- **Still open:** S5-T4's 45 drifted ids need S8-T1 renames (one per land); S8-T3 hand-staged candidates at venues outside VENUE_LISTING_PAGES cannot be confirmed by the promoter (needs an admin path); redirects for folded director/creative/theatre slugs; S6-T8f, S6-T9, Sprint 8 removals and drains; BRO-4204 close-out.

**2026-09-29 (same session, wave 3 and Sprint 8).**
- **Batch 4 landed** (P's name-slug redirects, run 36515141619, after one refusal on `audit-tests-vs-derived-data` — the TS parity test now carries the structural exemption). Production 301s `/creative/jos-quintero` and `/west-end/theater/no-l-coward-theatre` to the folded slugs; batch 3's critic aliases were already live.
- **S8-T2 done in two batches.** The ten junk rows (27c1b42) survived a full Update Shows cycle (run 36514213162, dispatched for the check); the remaining buckets then went (642e9fd): 26 retired, 83 kept rows all present, registry at 38. Kept on the owner's rule: I'm Every Woman, Jack and the Beanstalk. Kept by the script's own guard: the Choir of Man New Wimbledon stop, because the Marble Arch row's priorRuns names it.
- **S8-T3.** Q's evidence-backed promoter path landed with 53 hand-prepared rows staged — and the staged copy was lost before the promoter ran: Update Shows (checked out at 02:47) pushed its own staging over the landed rows at 03:49 (BRO-4268). Recovered by running the promoter locally from the additions file: 49 promoted, 4 already discovered (c9beb67). Root cause fixed: `audit/owe-venue-candidates.json` is now an active union merge (one factory shared with the OB file, `apiFallbackMerge`, seeded apiFallbackSafe count 131→130) and the promoter's commit step opts into `PUSH_RECONCILE_MERGED_JSON`; second-opinion review recorded. Hand adds outside the promoter: Guess How Much I Love You? (Royal Court, west-end), America the Beautiful: Chapter 1 (+ dates on the Chapter 2 ghost), the 2025 Apollo run of Christmas Carol Goes Wrong (priorRuns on the Wyndham's row), and Dick Whittington: Adults Only beside the family panto via the new `distinctFrom` cross-link (dedup exempts concurrent siblings at one venue that are neither transfer nor prior run).
- **Main red after batch 4, all addressed:** the Broadway-category predicate audit (page-name-sources.js takes the documented intentional-strict form, landed run 36519910840); two empty West End Wilma stagedoor stubs flagged `duplicateOf` in review-texts (c9072874); the branch-protection live test stays red by design (BRO-4269, owner call). Filed: BRO-4266 (readiness job 3-min timeout), BRO-4268, BRO-4269.
- **Still open:** S8-T1 renames (rename-show-id.js blocked by the auto-mode classifier here; 96 off-west-end rows carry a `-west-end-` id suffix from discovery, e.g. dick-whittington-and-his-cat-west-end-2026, on top of the 45 wrong-year ids); S8-T2 acceptance wants a second Update Shows run over the 26 (24h survival check 19:02 UTC); the four provisional hand adds await CI's `--all-provisional` Playbill sweep (no SERP keys here).

### 2026-09-29 (session close) — all sprints landed except S8-T1 renames

- Landed on main: batches 1–4 plus the follow-ups (`land/audit-owe-staging-merge-3` run 36526998219, `-4` run 36533631863): BRO-4268 staging union merge, London listing title gate on every loop, venue-based OLT category, ampersand-blind matching/dedup, the LondonTheatre `titleLower` regression (caught by ship-check before landing), venue-complex orphan slugs, cast-manifest-tolerant redirects test, promoter gate order.
- Core data: 27 non-show rows retired (incl. the Kiln festival Q&A row the new title gate flagged), 49 evidence promotions recovered, 3 hand adds, closing dates, consensus key re-homed. Review-texts: wrong-production flags (incl. the 2019 Gentlemen Prefer Blondes review misfiled on the 2027 Palladium row), Wilma duplicate stubs, BWW hub URLs.
- Gathering: the promoted closed rows never reach the open-only zero-review catch-up, so a 5-show test (run 36527208309, success) and the remaining 44 (run 36533317543) were dispatched by hand; systemic fix filed as BRO-4290.
- Not done: S8-T1 id renames (96 Off-West End rows with a west-end suffix, 9 Broadway ids, 45 drifted) — `rename-show-id.js` is denied by the cloud auto-mode classifier; needs an owner-run or a desktop session. Root cause (OLT loop hardcoding west-end) is fixed, so the class does not grow.
- Filed: BRO-4290 (P1, promoter → gather gap), BRO-4291 (P2, provisional-row label), BRO-4269 (branch-protection test), BRO-4270 (BWW hub URLs), BRO-4266 (readiness timeout).
