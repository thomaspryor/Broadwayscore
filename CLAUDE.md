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

**"Pushed" ≠ "Deployed" — NEVER declare work complete after just pushing.** Deploys take ~13 min and often fail (rate limits, build errors, timeouts). After pushing code that triggers a deploy:
1. **Confirm the workflow triggered:** `gh run list --workflow=vercel-deploy.yml --limit=1 --json status,conclusion,createdAt,databaseId`
2. **If you have other work to do**, do it while the deploy runs. Check back before wrapping up.
3. **Before ending the session**, check deploy status: `gh run list --workflow=vercel-deploy.yml --limit=1 --json status,conclusion -q '.[0]'`
   - If `completed` + `success`: verify production looks correct, THEN say "done"
   - If `completed` + `failure`: investigate and fix. Do NOT leave a failed deploy for the next session.
   - If still `in_progress`: tell the user "Deploy is still running (run #ID). Check back in X minutes." Do NOT say "all done."

### 3b. Commit Frequently — Uncommitted Work WILL Be Lost (MANDATORY)
**Multiple sessions run concurrently. Any session can run out of context at any time. Uncommitted changes are destroyed by: context expiration, other sessions doing git operations, stash pops, branch switches, or linters.**

**Commit vs Push — different cadences:**
- **Commit locally after each logical unit of work** — one component extracted, one bug fixed, one page updated. Never accumulate more than 1-2 changed files without committing. Commits are free and instant.
- **Push at natural checkpoints** — after completing a sprint task, after a feature works end-to-end, or before starting QA. Pushes to `main` that touch `src/` trigger a ~13 min deploy workflow, so don't push every 5 minutes. But DO push at least every 30 min or after each major milestone — a local-only commit is still vulnerable to other sessions doing `git checkout` or `git stash pop`.

**Other rules:**
- **If you've been working for 15+ minutes without committing, stop and commit NOW.** A WIP commit is infinitely better than lost work.
- **Before starting visual QA or testing, commit AND push first.** QA often runs out of context. If changes aren't committed, the QA session's feedback is useless because the code it reviewed no longer exists.
- **Commit messages for WIP are fine:** `git commit -m "wip: extract StatGrid component"` — clean up later with a final commit message if needed.
- **Never batch all changes into one final commit.** This is the #1 cause of lost work. A session that modifies 25 files across 4 features and never commits WILL lose everything.

**Why this rule exists:** A session completed 4 component extractions across ~25 files but never committed. The session ran out of context. Another session's git operation overwrote the working tree. Hours of work permanently lost.

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

### 7a. Private Review-Texts Repo (CRITICAL — ALL SESSIONS READ THIS)
**NEVER commit copyrighted review text, scraped full-text content, or third-party API keys to the public repo.** This is a legal/DMCA risk. All 24,000+ full-text reviews live in a private repo only.
- **`data/review-texts/`** → private repo (`thomaspryor/broadway-review-texts`), gitignored from public repo.
- **`reviews.json`** → public repo, but contains ONLY metadata (scores, outlets, URLs) — NO `fullText` field.
- **CI workflows** use composite actions to check out / push review-texts:
  - `.github/actions/checkout-review-texts/` — checks out private repo into `data/review-texts/`
  - `.github/actions/push-review-texts/` — commits + pushes changes to private repo (5-retry, `if: always()`)
- **Secret:** `REVIEW_TEXTS_TOKEN` (PAT with `repo` scope, no expiration)
- **Public repo:** `data/review-texts/` is in `.gitignore`. `git add data/review-texts/` is a no-op.
- **Scripts unchanged:** No script modifications needed. Workflow-level composite actions handle the private repo.
- **New workflows** that read or write `data/review-texts/` MUST include both composite actions.
- **Automated guard:** `test.yml` data-validation job verifies zero review-text files are tracked in the public repo. Fails the build if any leak in.
- **Local dev:** Files may exist on disk from before migration but aren't git-tracked. To get fresh data locally, clone the private repo into `data/review-texts/`.

### 8. Design System — Use Shared Components
**NEVER create custom versions of existing UI components.** Library: `src/components/show-cards/`
- `ScoreBadge`, `StatusBadge`, `FormatPill`, `ProductionPill`, `getScoreTier()`, `ShowImage`, `getOptimizedImageUrl()`
- `ToggleBar<T>` — generic labeled toggle row for sort/filter controls. Props: `label`, `options`, `value`, `onChange`, `size?: 'default' | 'compact'`, `className?`. Use `compact` for dense pages (critics, outlets, creatives). Use `default` (has 36px mobile tap targets) for main pages.
- `ScoreToggle` — Critics/Audience segmented control. Props: `value`, `onChange`, `audienceFirst?`, `size?: 'default' | 'large'`, `className?`. Side effects (like forcing sort on audience switch) go in the parent's `onChange` handler, not the component.
- Import: `import { ScoreBadge, StatusBadge, ToggleBar, ScoreToggle, ... } from '@/components/show-cards';`
- New pages MUST use these. Add new components to `show-cards/` barrel — never inline.

### 8a. Visual QA for UI Changes (MANDATORY)
**When changing UI across 2+ files, you MUST do before/after screenshot comparison BEFORE committing.**
1. **Before making changes**: Screenshot production (`broadwayscorecard.com`) at mobile (375px) and desktop (1280px) for every affected page
2. **After making changes**: Build locally (`npx next build`), serve (`npx serve out -l 3099`), screenshot same pages at same sizes
3. **Compare**: View before/after pairs side-by-side. Only commit if layout is identical (data count differences from pipeline runs are OK)
4. **Playwright script pattern**:
```js
const { chromium } = require('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: '/tmp/before-pagename-375.png' });
```
**This rule exists because** a session proposed this exact testing plan, then skipped it and pushed without comparing. The refactor happened to be pixel-perfect, but we got lucky.

### 9. Roadmap Discipline
Before starting work, run `gh issue view 50 --repo thomaspryor/Broadwayscore`.

**When finishing a session**, you MUST:
1. **Update the roadmap issue body** — move completed items to "Recently Done" with a one-line summary and date. Move newly started items to "In Progress."
2. **Post a comment** summarizing what was done in this session.

**When you discover work that should be done but WON'T do now**, you MUST:
1. **Add it to the roadmap** — put it in the appropriate Backlog section (UI/Design, New Features, Infrastructure, etc.) with a one-line description.
2. **Post a comment** explaining why it matters and why you're not doing it now.
3. This prevents good ideas from being lost when sessions compact, get distracted, or fail. If it's not on the roadmap, it doesn't exist.

**Rabbit hole prevention:** New discoveries → Backlog entry + comment. Don't context-switch.

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
