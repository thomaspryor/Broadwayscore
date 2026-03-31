# Broadway Scorecard Project Context

## Repo Layout
- **Web:** `~/Broadwayscore/` → GitHub: `thomaspryor/Broadwayscore`
- **iOS app:** `~/BroadwayScorecard-app/` → GitHub: `thomaspryor/BroadwayScorecard-app`

## CRITICAL RULES

### 1. Git Workflow
Global rules apply (worktree-first, branch check, commit frequently). Project additions:
- **Worktree scope:** `src/` or config files → worktree. Pure data/CI/docs → skip.
- **Push** every ~30 min or after milestones.
- **15+ min without committing** → stop and commit NOW.
- **`git pull` before every shows.json edit.** CI commits to shows.json every ~30 min. In long sessions, your local copy goes stale and `git rebase` silently re-introduces deleted entries. Always pull immediately before reading shows.json for edits, and verify fixes survived after rebase.

### 2. Vercel Deployment
Git-triggered builds are BLOCKED. Deploys ONLY via `vercel-deploy.yml`.
- Pushes touching `src/`, `public/`, config, key `data/*.json` → auto-deploy (~5 min, up to ~10 min if queued behind another deploy).
- Manual deploy: `gh workflow run "Deploy to Vercel"`.
- **"Pushed" ≠ "Deployed"** — confirm workflow triggered. If failed → fix. If in-progress → tell user the run ID.

### 3. Core Data Rules
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- **Copyrighted text, PII, API keys** → private repos, all gitignored (see §11).
- **Session data check:** `npm run data:check` at start. Missing → `./scripts/setup-local-data.sh`.

### 4. Design System
Use shared components from `src/components/show-cards/` — never create custom versions.
- Components: `ScoreBadge`, `StatusBadge`, `FormatPill`, `ProductionPill`, `ShowImage`, `getOptimizedImageUrl()`, `getScoreTier()`
- Import from `@/components/show-cards`. Add new components to barrel, never inline.
- **Per-market branding:** `src/config/branding.ts` is single source of truth. Never hardcode brand colors.

### 5. Visual QA (MANDATORY for UI Changes)
**Never deploy UI changes without visual verification.** Playwright screenshots at 390px + 1440px → confirm before commit.
- **Score badges are sacred** — never change size/position/shape. Score column: `w-20 sm:w-24`.
- **ANY change to files that render visible HTML needs before/after screenshots** — not just "UI" changes. Perf refactors, code moves, SSR migrations all change rendering.

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
**If any check fails, fix before committing.** Never push broken code.

### 13. Prompt Changes Require A/B Check (MANDATORY)
Never rescore >100 reviews without the built-in A/B comparison. Aborts if bucket shift >5% or mean drift >5pts.

### 14. Opening Night Readiness Check (MANDATORY)
When asked "is everything ready for opening night?", check the AUTOMATION CHAIN, not just the data:
1. `gh run list --limit 50 --json name,createdAt --jq '.[] | select(.name == "Opening Night Orchestrator") | .createdAt'` — confirm the 3 AM UTC Broadway cron has actually fired before for this market (not just the 10 PM UTC West End cron)
2. Verify `opening-night-orchestrator.yml` is in `check-cron-health.yml`'s CRITICAL_CRONS list
3. `gh workflow run opening-night-orchestrator.yml -f show_id=SHOW_ID -f market=broadway` to manually trigger if the cron is late (GitHub crons can lag 15-30 min or miss entirely on new workflows)
4. **ScrapingBee credits:** `gh workflow run check-secrets-health.yml` and check output — needs >25% remaining. Check-secrets-health warns at 50% (monitor) and 75% (opening nights at risk).
5. **Wrong-production pre-scores:** `ls data/llm-scores/{show-id}/` — verify every pre-existing score file is from the correct production (not a prior West End/OB/regional run). If any are wrong, add `wrongProduction: true` to those source files.
6. **DTLI slug verification (Broadway only — DTLI doesn't cover WE):** `node -e "const m=require('./data/dtli-slug-map.json'); console.log('DTLI slug:', m.shows['{show-id}'])"` — verify slug maps to the current-season DTLI page, not an old production (e.g., `giant-2` not `giant`). For revival shows (year in ID), expect a numbered suffix.
7. **Bright Data zone:** `gh workflow run check-secrets-health.yml` covers this — it now checks zone status directly. Or manually: `curl https://api.brightdata.com/zone?zone=mcp_unlocker -H "Authorization: Bearer $BRIGHTDATA_TOKEN"` — `disable` field must be absent. If zone is disabled: UI recovery only (Recover + enable toggle in Configuration tab). API cannot fix it.
8. **BWW RR URL (Broadway primarily — rare for WE):** Find the BWW Review Roundup URL for the show BEFORE opening night. Pattern: `https://www.broadwayworld.com/article/Review-Roundup-{TITLE-SLUG}-Opens-on-Broadway-{YYYYMMDD}`. If Google hasn't indexed it yet (same-day openings), the SERP fallback may return the wrong production. Have the URL ready to pass as `--bww-roundup-url` to the opening-night-poller.
9. **Talkin' Broadway URL (Broadway only — TB doesn't review WE shows):** TB is an outlet (not an aggregator). Direct URL pattern is `https://www.talkinbroadway.com/page/world/{titleslug}{year}.html` (e.g., `giant2026.html`). SERP returns forum posts (All That Chat) instead of the review. TB is T2 outlet — don't miss it.

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

### Web Scraping
Fallback chain: Bright Data → ScrapingBee → Playwright (`scripts/lib/scraper.js`).
**Rule:** All new scraping scripts MUST use `fetchPage()` from `scripts/lib/scraper.js` — never call BD/SB APIs directly. Workflows that scrape must pass both `BRIGHTDATA_TOKEN` AND `SCRAPINGBEE_API_KEY`. CI enforces this in `test.yml` (`lint-workflows` job). If a new workflow is legitimately exempt (health check, credential validator), add it to the exempt list in test.yml with a comment.
**Broadway aggregators:** Show Score, DTLI, BWW Roundups, BWW Reviews Pages, Playbill Verdict, NYC Theatre Roundups.
**WE aggregators:** WestEndTheatre.com (WET), theatre.reviews (TR), Stagedoor (SD), The Stage roundups (TS), London Box Office (LBO). Integrated in both `gather-reviews.js` and `opening-night-poller.js`.

For full details on any subsystem: `memory/CLAUDE-reference.md`

### 15. Test Extraction Pattern (MANDATORY for new logic tests)
**Never copy logic into test files — always `require()` the real function.**
- Extract pure decision functions to `scripts/lib/review-guards.js` (or a new lib file)
- `module.exports` the function; `require()` it in the test
- If production code changes, updating the function will make the test fail — that's the point
- See `scripts/lib/review-guards.js` for the established pattern (Fix #12/13/14)
- **When you fix inline logic in a pipeline script:** extract it → export → wire back → test

### 16. Email Broadcast Safety (MANDATORY — NO EXCEPTIONS)
See `memory/email-broadcast-rules.md` for full incident history and rules.
- **NEVER call `POST /broadcasts/{id}/send` directly** — all sends via `send-opening-night-broadcast.js` only
- **NEVER broadcast to test or validate anything** — use `--send-to=your@email.com` (transactional, never broadcast)
- **NEVER send to any Resend audience with >5 real contacts for any test purpose**
- The Giant broadcast sent correctly to ~161 unique subscribers (158 delivered, 98.14%). The "3x duplicate" claim from the previous session was wrong.

---

## File Hygiene
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) load every session.
New topics → `memory/{topic}.md` + one-line pointer. Completed tasks → `memory/completed-migrations.md`.
