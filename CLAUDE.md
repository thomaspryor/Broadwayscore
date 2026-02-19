# Broadway Scorecard Project Context

## CRITICAL RULES - READ FIRST

### 1. NEVER Ask User to Run Local Commands
The user is **non-technical and often on their phone**. They cannot run terminal commands.
- Make code changes and push to Git
- Create/update GitHub Actions for automation
- If something truly requires local execution, create a GitHub Action to do it

### 2. ALWAYS ASK: Quick Fix or Preview? (MANDATORY)
**Before making ANY code/design changes, Claude MUST ask:**
> "Is this a **quick fix** (ship directly to production) or do you want to **preview it first** (staging branch)?"

- "Quick fix" / "Ship it" → Work on `main`, push directly
- "Preview" / "Staging" → Work on `staging` branch, provide preview URL
- **Exceptions:** Pure data updates, documentation, clearly broken bug fixes

### 3. Git Workflow - Two Paths
**Path A: Quick Fix** → Work on `main`, push. Vercel deploys via Deploy Hook (~2 min).
**Path B: Preview** → Branch `staging` from `main`, push. Merge to `main` after approval, delete staging.
**Production:** https://broadwayscorecard.com | **Branch:** `main`
**NEVER:** Create PRs or random feature branches (only `main` or `staging`).
**BRANCH CHECK:** Before ANY git commit/push, run `git branch --show-current` to verify you're on the correct branch. Other sessions and stash operations frequently leave the local checkout on `staging` when you need `main` (or vice versa). Don't waste time — check first.

### 3a. Vercel Deployment (IMPORTANT — ALL SESSIONS READ THIS)
**Git-triggered builds are BLOCKED** (`exit 0` in dashboard Ignored Build Step). This prevents data checkpoint commits from burning build minutes.
**Deploys happen ONLY via Vercel CLI** in `.github/workflows/vercel-deploy.yml`:
- The workflow builds on GitHub Actions (`vercel build --prod`), then uploads prebuilt output (`vercel deploy --prebuilt --prod`). This completely bypasses Vercel's git integration.
- Pushes changing `src/`, `public/`, `content/`, config files, or key `data/*.json` → **deploy triggers automatically** (~13 min)
- Pushes changing only `data/review-texts/`, `data/archives/`, etc. → **no deploy** (intentional)
- To force a manual deploy: `gh workflow run "Deploy to Vercel"`
- **DO NOT remove `exit 0`** from dashboard Ignored Build Step — it blocks 30+ checkpoint builds per hour.
- **DO NOT add `ignoreCommand` to `vercel.json`** — it has NO ignoreCommand. Dashboard only.
- **DO NOT use deploy hooks or Deployments API** — both get blocked/auto-canceled. Only the CLI approach works.
- **Secret:** `VERCEL_TOKEN` (CLI auth)

### 4. Automate Everything — SET AND FORGET
All data pipelines must be fully automated via GitHub Actions with dynamic date ranges. Never ask user to manually fetch data or update year constants.

### 5. NEVER Guess or Fake Data
Never give approximate ranges. If you can't access a source, say so.

### 6. NEVER Extract Metadata from URLs
URL structure is wildly inconsistent. NEVER extract years, production info, or identifiers from URL patterns. Use publish date, review text content, and exact URL matching instead.

### 7. Batch Scripts MUST Checkpoint
Any script processing >10 items in CI MUST save progress incrementally.
- Use `if: always()` on archive/commit/push steps (timeouts silently lose ALL data without this)
- Use 5-retry push with `--rebase -X theirs`
- `rebuild-all-reviews.js` writes back to `data/review-texts/` — the `push-review-texts` composite action handles pushing those changes to the private repo

### 7a. Private Review-Texts Repo (IMPORTANT — ALL SESSIONS READ THIS)
**`data/review-texts/` is in a private repo** (`thomaspryor/broadway-review-texts`), NOT the public repo. This protects 24,000+ copyrighted full-text reviews from DMCA exposure.
- **CI workflows** automatically check out and push review-texts via composite actions:
  - `.github/actions/checkout-review-texts/` — checks out private repo into `data/review-texts/`
  - `.github/actions/push-review-texts/` — commits + pushes changes to private repo (5-retry, `if: always()`)
- **Secret:** `REVIEW_TEXTS_TOKEN` (PAT with `repo` scope, no expiration)
- **Public repo:** `data/review-texts/` is in `.gitignore`. `git add data/review-texts/` is a no-op.
- **Scripts unchanged:** No script modifications needed. Workflow-level composite actions handle the private repo.
- **New workflows** that read or write `data/review-texts/` MUST include both composite actions.
- **Local dev:** Files may exist on disk from before migration but aren't git-tracked. To get fresh data locally, clone the private repo into `data/review-texts/`.

### 8. Design System — Use Shared Components
**NEVER create custom versions of existing UI components.** Library: `src/components/show-cards/`
- `ScoreBadge`, `StatusBadge`, `FormatPill`, `ProductionPill`, `getScoreTier()`, `ShowImage`, `getOptimizedImageUrl()`
- Import: `import { ScoreBadge, StatusBadge, ... } from '@/components/show-cards';`
- New pages MUST use these. Add new components to `show-cards/` barrel — never inline.

### 9. Roadmap Discipline
Before starting work, run `gh issue view 50 --repo thomaspryor/Broadwayscore`.
When finishing: update the issue body + post a comment summarizing what was done.
**Rabbit hole prevention:** New discoveries → Backlog comment. Don't context-switch.

### 10. Planning & Testing for Infrastructure Changes (MANDATORY)
For any change touching **3+ workflow files**, **CI/CD infrastructure**, **data pipelines**, or **cross-repo operations**:

**Planning phase:**
1. Write the plan (what changes, where, why)
2. Have a separate agent review the plan for gaps (use `/critique` for high-stakes changes)
3. **Explicitly list assumptions** that could be wrong (e.g., "git add on gitignored path is a no-op" — it's NOT, it returns exit code 1)
4. **Include a testing phase in the plan itself** — not as afterthought, but as a numbered phase with specific workflows to test

**Testing phase (before declaring done):**
1. **Test at least 3 representative workflows** — one simple (NYSR), one complex (rebuild), one write-heavy (collect-review-texts)
2. **Wait for runs to complete** and check ALL step statuses (not just overall pass/fail)
3. **Check for interaction effects** — gitignore + git add, nested repos + file size checks, composite actions + error handling
4. **Test the failure path** — what happens when a step fails? Does `if: always()` work? Do subsequent steps still run?

**Common gotchas to check:**
- `git add <gitignored-path>` → exit code 1 (not a silent no-op)
- Nested `.git` directories from multi-repo checkouts → triggers size checks, confuses git commands
- `set -e` in bash steps → any non-zero exit kills the step, even from benign commands
- Parallel sessions switching branches → always verify branch before commit, or use Git Data API

### 11. Pipeline Operations — Test, Monitor, Parallelize
**MANDATORY: End-to-end test before ANY large dispatch.** Never dispatch 5+ runs or 50+ reviews without first running a tiny test (5 reviews, 1 batch, same params) and verifying data lands in the private repo. We lost a full week of credits (Feb 18-19, 2026) running 3 rounds of 5 runs that all failed for different infrastructure bugs — each taking hours to discover because the runs themselves take hours. The test takes 10 minutes and catches everything.
- Verify: did checkpoint push to private repo work? (`gh api repos/thomaspryor/broadway-review-texts/commits`)
- Verify: did final push-review-texts step succeed?
- Verify: no `git add` errors on gitignored paths?
- Only THEN dispatch at scale. Check within 30 min after dispatch.

**Before:** Verify secrets (test 1 workflow first), check slots (<35 in-progress), 10s+ spacing between `gh workflow run`, shard scoring to 10 (`-f shard=N -f total_shards=10`).
**During:** Check within 15 min. Verify chaining created next run.
**After:** Trigger rebuild if needed. Verify data landed **in the private repo**.
**Collection MUST be chained:** Always use `-f chain=true -f remaining_batches=10`. `remaining_batches` defaults to 0 = NO CHAINING.
For launch patterns and known pitfalls, read `memory/CLAUDE-reference.md`.

### 12. Visual Preview Before Deploying UI Changes (MANDATORY)
**NEVER deploy UI changes to staging/production without visually verifying them first.** The user is non-technical and on their phone — every broken deploy wastes their time reviewing garbage.

**Workflow for ANY visual/layout change:**
1. Start dev server: `PORT=3456 npm run dev > /tmp/dev-server.log 2>&1 &` (~2 sec startup, hot-reloads on save)
2. Screenshot with Playwright script (MCP Playwright often fails — use this instead):
   ```js
   node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:420,height:900}});await p.goto('http://localhost:3456/PAGE',{waitUntil:'networkidle'});await p.screenshot({path:'/tmp/ss.png'});await b.close();})()"
   ```
3. Review the screenshot yourself — check layout, spacing, alignment, overflow, text wrapping
4. If it looks wrong, fix and re-screenshot. Dev server hot-reloads changes automatically.
5. Only after visual confirmation: commit, push, and trigger deploy
6. Kill the server when done: `kill $(lsof -ti:3456)`

**Why dev server over full build:** `npm run dev` starts in ~2 seconds vs ~4 minutes for `npm run build` + `npx serve out`. Pages are identical for visual/layout work. Use full build only if you need to verify static export behavior.

**What to check in screenshots:**
- Score badges are in the same position/size as production (never shift badge position)
- Cards have consistent spacing and don't look squished or bloated
- New elements don't overflow their containers or push other elements around
- Text wraps correctly, doesn't clip, and is readable
- Toggle states all look correct (check each mode)

**If you can't build locally** (e.g., branch conflicts), at minimum describe exactly what will change visually and flag any uncertainty to the user before deploying.

### 13. UI Change Principles
- **Score badges are sacred** — never change their size, position, or shape. The score column (`w-20 sm:w-24`) is fixed. New elements go around it, not inside it.
- **Card layout is `[Thumbnail] [Info] [Score]`** — three flex children. Add new elements between Info and Score as separate flex children, not nested inside existing ones.
- **Test with real data** — long show titles, missing images, shows in previews, closed shows, shows with/without audience scores. Edge cases break layouts.
- **Padding changes cascade** — changing `p-4` to `p-3` affects every card. Always check the visual result.

---

## Project Overview

Broadway review aggregator. Next.js 14, TypeScript, Tailwind CSS, static export.
**Production:** https://broadwayscorecard.com (Vercel, auto-deploys from `main`)
**State:** 727+ shows, 14,000+ scored reviews, 420+ outlets, 870+ critics. Critics-only scoring (V1).

## Scoring

- **Composite = Critic Score** (tier-weighted average)
- **Tier 1** (NYT, Vulture, Variety): 1.0 | **Tier 2** (TheaterMania, NY Post): 0.75 | **Tier 3** (blogs): 0.45
- Letter grade map: `src/config/scoring.ts`
- Hierarchy: P0 (explicit ratings) → P0.5 (humanReviewScore) → P0b (originalScore) → P1 (LLM high/med) → P2 (aggregator override) → P3 (LLM low)
- Excerpt-only reviews (<100 chars) get confidence downgraded to "low". `scoreSource` tracks method.

## Data Structure

> **Querying:** `npm run db:build` then `node scripts/query.js "SQL"`. Use `db:build:full` for fullText.

```
data/
  shows.json                 # Source of truth (status: "open"|"previews"|"closed")
  reviews.json               # Derived from review-texts/ via rebuild
  review-texts/{show-id}/    # PRIVATE REPO (thomaspryor/broadway-review-texts) — see §7a
  grosses.json / grosses-history.json / commercial.json / audience-buzz.json
  critic-consensus.json / critic-registry.json / aggregator-archive/
```

**Not displayed on site:** `cast` field (not rendered yet), `creativeTeam` design roles (Scenic, Costume, etc.)
For full schemas, read `memory/CLAUDE-reference.md`.

## Key Files

**App:** `engine.ts` (scoring), `data-core.ts` (shows/reviews), `page.tsx` (homepage), `show/[slug]/page.tsx` (show pages), `scoring.ts` + `commercial.ts` (config), `ShowImage.tsx`
**Data modules:** `data-types.ts`, `data-core.ts`, `data-grosses.ts`, `data-awards.ts`, `data-audience.ts`, `data-commercial.ts`, `data-consensus.ts`, `data-lottery.ts`
**Core scripts:** `gather-reviews.js`, `collect-review-texts.js`, `rebuild-all-reviews.js`, `validate-data.js`, `discover-new-shows.js`, `enrich-ibdb-dates.js`, `scrape-grosses.ts`, `generate-critic-consensus.js`, `fetch-show-images-auto.js` (has PINNED_IMAGES — never overwrite)
**Tests:** `tests/unit/`, `tests/e2e/`
For full library/audit script listings, read `memory/CLAUDE-reference.md`.

## Content Quality

5 tiers: `complete` → `truncated` → `excerpt` → `stub` → `invalid`. Classified by `content-quality.js`.
5-layer quality gates run automatically on rebuild. Details in `memory/CLAUDE-reference.md`.
Quality flags: `wrongProduction`, `wrongShow`, `isRoundupArticle` — excluded from reviews.json.
4-layer wrong-production prevention (scraper → write-time → rebuild-time → audit).

## Automation

**Source of truth:** `data/review-texts/` (private repo — see §7a) → **Derived:** `data/reviews.json`
See `.github/workflows/CLAUDE.md` for workflow descriptions and schedules.
**Always run `node scripts/validate-data.js` before pushing.**
**Secrets MUST be passed via `env:` blocks** (NOT auto-available). **Local keys:** `.env` at project root.

## Web Scraping & Collection

Scraper fallback: Bright Data → ScrapingBee → Playwright (`scripts/lib/scraper.js`).
6 aggregator sources: Show Score, DTLI, BWW Roundups, BWW Reviews Pages, Playbill Verdict, NYC Theatre Roundups.
**Per-show:** `gh workflow run "Collect Review Texts" -f show_filter=SHOW_ID -f max_reviews=0`
For detailed source info, secrets table, and subscription access, read `memory/CLAUDE-reference.md`.

## Commercial (`/biz`)

Config: `src/config/commercial.ts` (designation criteria source of truth). Components: `src/components/biz/`.
**Recoupment rules:** Never mark `recouped: true` without trade press citation. Deep Research shows protected from automated overwrites.
For schemas, designation table, and validation gotchas, read `memory/CLAUDE-reference.md`.
