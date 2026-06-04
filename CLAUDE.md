# Broadway Scorecard Project Context

## Repo Layout
- **Web:** `~/Broadwayscore/` → GitHub: `thomaspryor/Broadwayscore`
- **iOS app:** `~/BroadwayScorecard-app/` → GitHub: `thomaspryor/BroadwayScorecard-app`

## CRITICAL RULES

### 1. Git Workflow
Global rules apply (worktree-first, branch check, commit frequently). Project additions:
- **Worktree scope (MANDATORY for ANY tracked code edit):** `src/`, `scripts/`, `.github/workflows/`, `next.config.js`, `tsconfig.json`, `package.json`, `CLAUDE.md` → **must be in a worktree before the first edit.** Local git hooks and parallel CI commits silently revert uncommitted edits. Memory and data files can skip. See `memory/feedback_worktree_code_changes.md`. Advisory warnings (session-start.sh, script-edit-check.sh) are advisory only — act on them.
- **Push** every ~30 min or after milestones. **15+ min without committing** → stop and commit NOW.
- **`git pull` before every shows.json edit.** CI commits to it every ~30 min; stale local copy + rebase silently re-introduces deleted entries. Pull immediately before edits and verify fixes survived after any rebase.

### 2. Vercel Deployment
Git-triggered builds are BLOCKED. Deploys ONLY via `vercel-deploy.yml`.
- **Cron deploys main HEAD every 5 min** (auto-skips ticks where HEAD hasn't moved). After a push to main, the deploy lands within ~5-10 min — DO NOT run `gh workflow run "Deploy to Vercel"` after a normal push; it races with the cron and re-triggers the cascade we just fixed.
- **Manual deploy** is for "ship NOW" only (opening night, broken page, post-rebuild data ship that can't wait): `gh workflow run "Deploy to Vercel"`. Auto-triggered post-rebuild via `workflow_run` already exists — manual dispatch is rarely needed.
- **"Pushed" ≠ "Deployed"** — confirm via `gh run list --workflow="Deploy to Vercel" --limit 1`. If failed → fix.
- **CI monitoring after multi-repo pushes:** Push ALL repos first, then get one final run ID and watch it once. Never watch intermediate cancelled runs. If you've already done >1 `gh run watch` call, switch to `ScheduleWakeup(270s)` + single `gh run view <id>` — do not keep chasing new run IDs synchronously.

### 3. Core Data Rules
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- **Copyrighted text, PII, API keys** → private repos, all gitignored (see §11).
- **Session data check:** `npm run data:check` at start. Missing → `./scripts/setup-local-data.sh`.
- **Never add stub shows.json entries without running `scripts/validate-show-venue.js` first.** Provisional/manual entries (`discoverySource: manual-user-request` or `venue-page:*`, or `provisional: true`) must be cross-validated against Playbill before commit. Run `node scripts/validate-show-venue.js --show=ID` (or `--all-provisional`). Catches wrong-year revivals (Sunset Baby 2014 vs 2024 Signature, 2026-05-26) and stub-from-memory dates. Audit log: `data/audit/venue-date-mismatches.json`.
- **Critic Score for external claims:** use `getCriticScore(showId)` from `scripts/lib/canonical-critic-scores.ts` only. Reads `public/data/shows/{id}.json:cs` so it's parity-by-definition with the live site. Never raw-mean `reviews.json` and never use `getAllShows()/engine.ts compositeScore` — both diverged in shipped copy. Full rationale + 2026-05-30 / 2026-06-02 incidents: `memory/feedback_critic_score_canonical_helper.md`.

### 4. Design System (MANDATORY — read `memory/design-system.md` before ANY UI work)
Use shared components from `src/components/show-cards/` — never create custom versions.
- **Components:** ScoreBadge, ScoreBreakdownBar, ShowListCard, MiniShowCard, StatusBadge, FormatPill, ProductionPill, AudienceChip, CategoryBadge, ToggleBar, ScoreToggle, StatGrid, ColumnHeader, Modal, ShowSearchDropdown. Import from `@/components/show-cards`.
- **Surface colors:** `bg-surface` (page), `bg-surface-raised` (cards), `bg-surface-overlay` (hover), `bg-surface-elevated` (modals). **NEVER use `zinc-*`, `slate-*`, or hardcoded dark hex values.**
- **Score colors:** Always use `getScoreBucket()` from `score-buckets.ts` or `getScoreTier()` from show-cards. Never hardcode tier colors.
- **Cards:** Use `.card` / `.card-interactive` / `.card-premium` CSS classes. Never build custom card borders/backgrounds.
- **Status colors:** Use domain tokens — `status-open` (success), `score-tepid` (warning), `score-skip` (danger). Never invent custom red/yellow/green.
- **Per-market branding:** `src/config/branding.ts` is single source of truth. Never hardcode brand colors.
- **When adding new shared components or tokens**, update `memory/design-system.md`.

### 5. Visual QA (MANDATORY for UI Changes — gate ENFORCES)
**Run `/visual-qa` before any push touching UI files** (`src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`, `src/app/**`). Element crops at full resolution + structural overflow probe + two-model LLM diff vs user-supplied references. Stop hook blocks claims of visual correctness without a fresh verdict; pre-push hook blocks `git push`/`gh pr merge` without `APPROVED: <verdictHash>` from the user. Bypass: `NO-VERIFY: <reason>` or `ship immediately for: <reason>`. **Score badges remain sacred** (`w-20 sm:w-24`). Full rules: `memory/feedback_local_preview_before_push.md` and `.claude/skills/visual-qa/skill.md`.

### 6. Notion Brain (MANDATORY — every session)
**Notion is the single source of truth for project state.** See `memory/notion-brain-workflow.md` for IDs, schema, and full lifecycle.
- **Session start:** Create a new Notion card for this session's work → set "In progress." Output card URL. Check for stale "In progress" cards.
- **Session end:** Append Outcome (what/why/approach/gotchas) + Key Files + Tags → set "Done" or "Paused."
- **New discoveries:** Create Notion card (Not started). Don't context-switch.
- **If Notion unreachable:** Warn user, continue without tracking. On wrap-up failure, output Outcome text so nothing is lost.

### 7. Infrastructure Change Planning (MANDATORY)
See global CLAUDE.md. Additionally: test 3 representative cases before merging.

### 8. Pipeline Operations
**E2E test before large dispatch** (5+ runs or 50+ reviews). Test 5 reviews first.
- Verify secrets, check concurrency slots, 10s+ spacing, shard scoring to 10.
- **Batch scripts must checkpoint** — save progress incrementally, `if: always()` on commit/push.

### 9. Expansion Playbook (MANDATORY for new markets)
Aggregators first, web search second. See `memory/expansion-playbook.md`. Never skip aggregator scraping.

### 10. Verify External File Modifications (MANDATORY)
When a file is modified externally (linter, other session, hook), `git diff` it immediately. Verify every prior fix survives. External tools silently revert intentional changes.

### 11. Private Repos (see `memory/private-repos.md`)
Review texts, aggregator archive, core data → private repos, all gitignored. CI uses composite actions. Guard: `test.yml` fails if private files leak.

### 12. Test Before Committing (MANDATORY)
Before EVERY commit touching `src/`, `scripts/`, or config:
1. `npx tsc --noEmit` — zero errors in changed files
2. `npx next lint` — no new warnings
3. Auth-aware build with feature flags
4. **Scripts:** run against real data, minimum 3 diverse cases. `node --check` is syntax only — NOT a test.
5. **Script migrations:** compare output before/after on same input. Empty results = broken.
6. For UI: visual verification per §5
7. **Scoring-logic edits** — two watchlists, both trigger `scripts/scoring-delta.js`:
   - Inclusion: `scripts/lib/review-guards.js`, `scripts/rebuild-all-reviews.js`, `src/lib/scoring.ts`, `src/lib/engine.ts`, `src/lib/data-core.ts`.
   - Score-source: `scripts/lib/rebuild-helpers.js`, `scripts/lib/score-extractors.js`, `scripts/lib/score-parsers.js`, `scripts/lib/review-normalization.js`, `scripts/lib/score-routing.js`.
   Unit tests are NOT sufficient. **MUST run** `node scripts/scoring-delta.js` AND `node scripts/test-temporal-override-regression.js`. Paste summary to user before pushing. Stop hook enforces. See `memory/feedback_scoring_delta_required.md`.
8. **Content-quality regex edits** (`scripts/lib/content-quality.js` pattern arrays) — MUST run `node scripts/audit-regex-patterns.js --full` before pushing. Catches bare-keyword FPs that unit tests miss. CI gate in `test.yml` enforces. See `memory/feedback_content_quality_regex_fps.md`.
**If any check fails, fix before committing.** Never push broken code.

### 13. Prompt Changes Require A/B Check (MANDATORY)
Never rescore >100 reviews without the built-in A/B comparison. Aborts if bucket shift >5% or mean drift >5pts.

### 14. Opening Night Readiness Check (MANDATORY)
**TIMING RULE — read first:** Aggregator/outlet review pages (BWW RR, DTLI, Playbill Verdict, Show Score, NYC Theatre Roundups, WET, theatre.reviews, Stagedoor, The Stage roundups) **don't exist until reviews start dropping.** A 404 pre-opening is normal — automation discovers URLs at poll time. **Don't pre-stage these URLs. Don't treat their absence pre-opening as a gap.** Only revisit items 6/8/9 AFTER first reviews land in `reviews.json`. **Exception: Talkin' Broadway can publish early** (24h pre-opening seen) — TB direct-URL discovery handles this; don't reject as "too early."

When asked "is everything ready for opening night?", check the AUTOMATION CHAIN, not just the data:
1. `gh run list --limit 50 --json name,createdAt --jq '.[] | select(.name == "Opening Night Orchestrator") | .createdAt'` — confirm the 3 AM UTC Broadway cron has actually fired before for this market (not just the 10 PM UTC West End cron)
2. Verify `opening-night-orchestrator.yml` is in `check-cron-health.yml`'s CRITICAL_CRONS list
3. `gh workflow run opening-night-orchestrator.yml -f show_id=SHOW_ID -f market=broadway` to manually trigger if the cron is late (GitHub crons can lag 15-30 min or miss entirely on new workflows)
4. **ScrapingBee credits:** `gh workflow run check-secrets-health.yml` and check output — needs >25% remaining. Check-secrets-health warns at 50% (monitor) and 75% (opening nights at risk).
5. **`category` + `status` + pre-scores check:** `category` must be `'broadway'`/`'west-end'` not `null` (orchestrator defaults fragile); verify `status='open'` is actually pushed to private repo (update-show-status.yml has logged-but-not-pushed); `ls data/llm-scores/{show-id}/` and add `wrongProduction:true` to any prior-production scores.
6. **DTLI auto-discovery (Broadway only):** Chain is slug-map → homepage scan → sitemap → URL guessing. Missing slug-map entry pre-opening is expected — homepage scan catches it within seconds of DTLI publishing. Full detail in `memory/opening-night-discovery-chains.md`.
7. **Bright Data zone:** `gh workflow run check-secrets-health.yml` checks zone status. Active zone is `$BRIGHTDATA_ZONE` (`web_unlocker2`); ignore `mcp_unlocker` trial alarms. Disabled zone needs UI recovery. Swap: `printf 'NEW_ZONE' | gh secret set BRIGHTDATA_ZONE`. See `memory/feedback_brightdata_zone_migration.md`.
8. **BWW RR + Talkin' Broadway URLs:** Discovery details and gotchas in `memory/opening-night-discovery-chains.md`. BWW: reviews.php → homepage → SERP, manual `--bww-roundup-url=` if all fail. TB: `tryTbDirectUrl` (year-suffixed + bare-slug), validates title/byline/publish-date; can publish 24h pre-opening.

---

## Project Reference

**Stack:** Next.js 14, TypeScript, Tailwind CSS, static export. Production: https://broadwayscorecard.com
**Scale:** 727+ shows, 14,000+ scored reviews, 420+ outlets, 870+ critics.

### Scoring
Composite = tier-weighted average. T1 (NYT, Vulture, Variety): 1.0 | T2 (TheaterMania, NY Post): 0.75 | T3 (blogs): 0.35
**Score display:** `compositeScore` = critic-only (browse, homepage). `blendedScore` = 50/50 critic+audience (Tony predictions).

### Data Structure
`data/` — `shows.json` (source of truth), `reviews.json` (derived via rebuild), `review-texts/{show-id}/` (private repo §11).
Query: `npm run db:build` then `node scripts/query.js "SQL"`. Use `db:build:full` for fullText.

### Key Files
**App:** `engine.ts`, `data-core.ts`, `scoring.ts`, `ShowImage.tsx`
**Scripts:** `gather-reviews.js`, `collect-review-texts.js`, `rebuild-all-reviews.js`, `validate-data.js`, `discover-new-shows.js`

### Automation
Source: `data/review-texts/` → Derived: `reviews.json`. Run `validate-data.js` before pushing. Secrets via `env:`. Local keys in `.env`.

### Commercial (`/biz`)
Config: `src/config/commercial.ts`. Components: `src/components/biz/`. Never mark `recouped: true` without citation.

### Content Quality
5 tiers: complete→truncated→excerpt→stub→invalid. Flags: `wrongProduction`, `wrongShow`, `isRoundupArticle` → excluded.
**After ANY manual review recovery** (clearing flags, creating stubs, ingesting URLs): run `node scripts/verify-review-recovery.js --show=SHOW_ID --production`. The pipeline has 5 steps that silently fail independently (conflict markers, scoring cancellation, rebuild timing). This script checks all of them and prints the exact fix command for each failure.

### Web Scraping
Fallback chain: Bright Data → ScrapingBee → Playwright (`scripts/lib/scraper.js`).
**Rule:** All new scraping scripts MUST use `fetchPage()` from `scripts/lib/scraper.js` — never call BD/SB APIs directly. Workflows that scrape must pass both `BRIGHTDATA_TOKEN` AND `SCRAPINGBEE_API_KEY`. CI enforces this in `test.yml` (`lint-workflows` job). If a new workflow is legitimately exempt (health check, credential validator), add it to the exempt list in test.yml with a comment.
**Broadway aggregators:** Show Score, DTLI, BWW Roundups, BWW Reviews Pages, Playbill Verdict, NYC Theatre Roundups.
**WE aggregators:** WestEndTheatre.com (WET), theatre.reviews (TR), Stagedoor (SD), The Stage roundups (TS), London Box Office (LBO). Integrated in both `gather-reviews.js` and `opening-night-poller.js`.

For full details on any subsystem: `memory/CLAUDE-reference.md`

### 15. Test Extraction Pattern (MANDATORY for new logic tests)
**Never copy logic into test files — always `require()` the real function.** Extract pure decision functions to `scripts/lib/` (e.g. `review-guards.js`); `module.exports` and `require()` in the test. Production code changes → test fails — that's the point. When fixing inline pipeline logic: extract → export → wire back → test.

### 16. Propose Memory Entries Inline (at session end)
During `/wrap-up` / `/done`, propose a full `memory/feedback_*.md` entry (frontmatter + Why + How-to-apply, quality of `feedback_404_not_terminal.md`) if you saw: 2+ corrections on same topic, 10+ re-reads of same file, or explicit "remember this / always do X / never do Y." Show the proposed entry; user replies `y` to commit. **Why:** post-hoc cron miners ship templated slop; in-session you saw the incident. Teardown rationale: 2026-05-27.

### 17. Email Broadcast Safety (MANDATORY — NO EXCEPTIONS)
See `memory/email-broadcast-rules.md` for full incident history.
- **NEVER call `POST /broadcasts/{id}/send` directly** — all sends via `send-opening-night-broadcast.js` only
- **NEVER broadcast to test or validate anything** — use `--send-to=your@email.com` (transactional, never broadcast)
- **NEVER send to any Resend audience with >5 real contacts for any test purpose**

---

## File Hygiene
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) load every session.
New topics → `memory/{topic}.md` + one-line pointer. Completed tasks → `memory/completed-migrations.md`.

## Cloud sessions
If you're a cloud Claude Code session (iOS, Mac app, claude.ai/code) you don't have `~/.claude/`. Read `.claude/CLOUD.md` first, then `cloud-memory/INDEX.md`. Run `node scripts/check-cloud-secrets.js` to verify required secrets are present.
