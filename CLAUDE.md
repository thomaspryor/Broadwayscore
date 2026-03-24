# Broadway Scorecard Project Context

## Repo Layout
- **Web:** `~/Broadwayscore/` → GitHub: `thomaspryor/Broadwayscore`
- **iOS app:** `~/BroadwayScorecard-app/` → GitHub: `thomaspryor/BroadwayScorecard-app`

## CRITICAL RULES

### 1. Git Workflow
- **Worktree isolation (MANDATORY):** If editing `src/` or config files, create a worktree first. Prevents concurrent sessions from clobbering each other. Skip for pure data/CI/docs work.
- **Branch check:** `git branch --show-current` before ANY commit/push.
- **Commit frequently.** After each logical unit. Never >2 uncommitted files. 15+ min without committing → stop and commit NOW. WIP commits are fine.
- **Push** every ~30 min or after milestones.

### 2. Vercel Deployment
Git-triggered builds are BLOCKED. Deploys ONLY via `vercel-deploy.yml`.
- Pushes touching `src/`, `public/`, config, key `data/*.json` → auto-deploy (~13 min).
- Manual deploy: `gh workflow run "Deploy to Vercel"`.
- **"Pushed" ≠ "Deployed"** — confirm workflow triggered. If failed → fix. If in-progress → tell user the run ID.

### 3. Core Data Rules
- **Never guess/fake data.** If you can't access a source, say so.
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- **Never commit copyrighted text, PII, or API keys to public repo.** Review texts, aggregator archive, core data → private repos, all gitignored.
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

### 6. Roadmap Discipline
See `memory/reference_notion_roadmap.md` for roadmap location and schema.
- **Finishing session:** Add completed items to roadmap with Status=Done. Add new discoveries as Not started.
- **New discoveries:** Add to roadmap. Don't context-switch.

### 7. Infrastructure Change Planning (MANDATORY)
For 3+ workflow/CI changes: plan → review → test 3 representative cases → verify all steps.

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
4. **For scripts that fetch URLs or parse data:** run with `--limit 1` (or equivalent smallest flag), confirm the output contains non-zero results and a sample looks semantically correct. `node --check` is syntax only — it does NOT count as testing.
5. **For script migrations (refactoring existing logic):** compare output against the old behavior. Check that the same input produces equivalent output. Empty results after a migration = broken, not "no data."
6. For UI: visual verification per §5
**If any check fails, fix before committing.** Never push broken code.

### 13. Prompt Changes Require A/B Check (MANDATORY)
Never rescore >100 reviews without the built-in A/B comparison. Aborts if bucket shift >5% or mean drift >5pts.

### 14. Opening Night Readiness Check (MANDATORY)
When asked "is everything ready for opening night?", check the AUTOMATION CHAIN, not just the data:
1. `gh run list --limit 50 --json name,createdAt --jq '.[] | select(.name == "Opening Night Orchestrator") | .createdAt'` — confirm the 3 AM UTC Broadway cron has actually fired before for this market (not just the 10 PM UTC West End cron)
2. Verify `opening-night-orchestrator.yml` is in `check-cron-health.yml`'s CRITICAL_CRONS list
3. `gh workflow run opening-night-orchestrator.yml -f show_id=SHOW_ID -f market=broadway` to manually trigger if the cron is late (GitHub crons can lag 15-30 min or miss entirely on new workflows)

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
6 aggregators: Show Score, DTLI, BWW Roundups, BWW Reviews Pages, Playbill Verdict, NYC Theatre Roundups.

For full details on any subsystem: `memory/CLAUDE-reference.md`

### 15. Email Broadcast Safety (MANDATORY — NO EXCEPTIONS)
See `memory/email-broadcast-rules.md` for full incident history and rules.
- **NEVER call `POST /broadcasts/{id}/send` directly** — all sends via `send-opening-night-broadcast.js` only
- **NEVER broadcast to test or validate anything** — use `--send-to=your@email.com` (transactional, never broadcast)
- **NEVER send to any Resend audience with >5 real contacts for any test purpose**
- The Giant broadcast sent correctly to ~161 unique subscribers (158 delivered, 98.14%). The "3x duplicate" claim from the previous session was wrong.

---

## File Hygiene
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) load every session.
New topics → `memory/{topic}.md` + one-line pointer. Completed tasks → `memory/completed-migrations.md`.
