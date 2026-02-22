# Broadway Scorecard Project Context

## CRITICAL RULES

### 1. NEVER Ask User to Run Local Commands
User is **non-technical, often on phone**. Push to Git, use GitHub Actions. Create a workflow if local execution is needed.

### 2. ALWAYS ASK: Quick Fix or Preview?
Before ANY code/design changes, ask: **quick fix** (→ `main`) or **preview** (→ `staging`)?
Exceptions: Pure data updates, documentation, clearly broken bug fixes.

### 3. Git Workflow
- **Quick fix** → `main`, push. Auto-deploy via `vercel-deploy.yml` (~13 min).
- **Preview** → `staging` branch, push. Get preview URL: `gh run view $(gh run list --workflow=vercel-preview.yml --limit=1 --json databaseId -q '.[0].databaseId') --log 2>&1 | grep 'Preview URL:'`. After approval, merge to `main`.
- **Production:** https://broadwayscorecard.com | Only `main` or `staging` — no PRs, no feature branches.
- **BRANCH CHECK:** `git branch --show-current` before ANY commit/push. Sessions frequently leave wrong branch checked out.

### 3a. Vercel Deployment
Git-triggered builds are **BLOCKED** (`exit 0` in dashboard). Deploys ONLY via Vercel CLI in `vercel-deploy.yml`:
- Builds on GitHub Actions (`vercel build --prod`) → uploads (`vercel deploy --prebuilt --prod`). Free, bypasses Vercel git integration.
- Pushes touching `src/`, `public/`, `content/`, config, key `data/*.json` → auto-deploy. Data-only pushes → no deploy.
- Manual deploy: `gh workflow run "Deploy to Vercel"`. Secret: `VERCEL_TOKEN`.
- **DO NOT:** remove `exit 0` from dashboard, add `ignoreCommand` to vercel.json, use deploy hooks/API, remove `--prod` flag.
- **Preview:** `vercel-preview.yml` — same approach without `--prod`, triggers on `staging`.
- **"Pushed" ≠ "Deployed"** — confirm workflow triggered, check status before ending session. If failed → fix. If in-progress → tell user the run ID.

### 3b. Commit Frequently (MANDATORY)
Multiple concurrent sessions. Context expires without warning. Uncommitted work WILL be lost.
- **Commit** after each logical unit (one component, one fix). Never >2 uncommitted files.
- **Push** every ~30 min or after milestones. Pushes to `main` touching `src/` trigger deploys.
- **15+ min without committing → stop and commit NOW.** WIP commits are fine.
- **Before QA/testing → commit AND push first.**

### 4–6. Core Data Rules
- **§4 Automate everything** — GitHub Actions with dynamic dates. Never ask user to fetch data.
- **§5 Never guess/fake data** — if you can't access a source, say so.
- **§6 Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.

### 7. Batch Scripts MUST Checkpoint
Scripts processing >10 items in CI: save progress incrementally, `if: always()` on commit/push steps, 5-retry push with `--rebase -X theirs`.

### 7a. Private Review-Texts Repo
**NEVER commit copyrighted text or API keys to public repo** (DMCA risk).
- `data/review-texts/` → private repo `thomaspryor/broadway-review-texts`, gitignored.
- CI: `.github/actions/checkout-review-texts/` and `push-review-texts/` composite actions.
- Secret: `REVIEW_TEXTS_TOKEN` (PAT, `repo` scope). Guard: `test.yml` fails if review-text files leak.
- New workflows reading/writing review-texts MUST include both composite actions.
- **Local changes MUST be synced:** After ANY local modification to `data/review-texts/` files (scoring, flagging, extracting, etc.), run `bash scripts/sync-review-texts.sh` before ending the session. This handles commit, conflict resolution, and push to the private repo. **Never leave local review-text changes uncommitted.**

### 7b. Private Core Data Repo
9 sensitive JSON files in private repo `thomaspryor/broadway-scorecard-data`:
`shows.json`, `reviews.json`, `grosses.json`, `grosses-history.json`, `commercial.json`, `audience-buzz.json`, `critic-consensus.json`, `critic-registry.json`, `outlet-registry.json`
- CI: `.github/actions/checkout-core-data/` and `push-core-data/` (with `if: always()`).
- Same PAT (`REVIEW_TEXTS_TOKEN`). All 9 files gitignored. Staleness canary in `test.yml`.
- Deploy: terminal workflows dispatch deploys directly (not path-triggered).
- New workflows: MUST include `checkout-core-data`. Writers MUST also include `push-core-data`.
- **Session data check:** Run `npm run data:check` at session start. If files missing/stale → `./scripts/setup-local-data.sh`. Never make data-dependent claims without verifying data is present.

### 8. Design System
Use shared components from `src/components/show-cards/` — never create custom versions.
- Components: `ScoreBadge`, `StatusBadge`, `FormatPill`, `ProductionPill`, `ShowImage`, `getOptimizedImageUrl()`, `getScoreTier()`
- `ToggleBar<T>` — labeled toggle row. `size='compact'` for dense pages, `'default'` for main (36px tap targets).
- `ScoreToggle` — Critics/Audience control. `audienceFirst` for NVP, `size='large'` for NVP. Side effects in parent `onChange`.
- Import from `@/components/show-cards`. Add new components to barrel, never inline.

### 8a. Visual QA (MANDATORY for UI Changes)
**Never deploy UI changes without visual verification.** User is non-technical — broken deploys waste their time.
1. Dev server: `PORT=3456 npm run dev > /tmp/dev-server.log 2>&1 &` (~2s startup)
2. Screenshot with Playwright at 375px (mobile) and 1280px (desktop) for affected pages
3. Check: score badge position, card spacing, overflow, text wrapping, toggle states
4. For multi-file changes: screenshot production BEFORE changes for comparison
5. Only after visual confirmation → commit, push, deploy. Kill server: `kill $(lsof -ti:3456)`
- **Score badges are sacred** — never change size/position/shape. Score column: `w-20 sm:w-24`.
- **Card layout: `[Thumbnail] [Info] [Score]`** — three flex children. Test with real data edge cases.
- **Padding changes cascade** — changing `p-4` to `p-3` affects every card.

### 9. Roadmap Discipline
Read roadmap: `gh issue view 50 --repo thomaspryor/Broadwayscore`
- **Finishing session:** Move completed items to "Recently Done" (with date). Post comment summarizing work.
- **New discoveries:** Add to Backlog section + comment. Don't context-switch.

### 10. Infrastructure Change Planning (MANDATORY)
For changes touching 3+ workflows, CI/CD, data pipelines, or cross-repo operations:
- **Plan:** Write changes, agent review for gaps, list assumptions, include testing phase.
- **Test:** 3 representative workflows (simple, complex, write-heavy). Wait for completion. Check all step statuses. Test failure paths.
- **Gotchas:** `git add <gitignored>` → exit code 1; nested `.git` dirs confuse git; `set -e` kills on any non-zero; parallel sessions switch branches.

### 11. Pipeline Operations
**E2E test before any large dispatch** (5+ runs or 50+ reviews). Test 5 reviews, 1 batch, verify data lands in private repo.
- **Before:** Verify secrets, check slots (<35), 10s+ spacing, shard scoring to 10.
- **During:** Check within 15 min. Verify chaining.
- **After:** Rebuild if needed. Verify data in private repo.
- **Collection:** Always `-f chain=true -f remaining_batches=10` (default=0=no chaining).

### 12. Expansion Playbook (MANDATORY for new markets/categories)
Aggregators first, web search second. See `memory/expansion-playbook.md` for the full process. Never skip aggregator scraping — it captures 70-90% of reviews. Web search is the cherry on top, not the foundation.

### 13. Always Recommend Next Steps
When wrapping up a task, recommend the best next task or follow-up. Don't just say "done" — tell the user what you'd prioritize next and why.

### 14. Fix Systematically, Not One-Off
When fixing an issue, also fix it **at the pipeline/automation level** so it never recurs. This project runs continuous automated processes for new shows, historical backfills, and geographic expansion. One-off fixes are wasted work — the same issue will reappear next run. Every fix should ask: "How do I prevent this class of problem permanently?" Update scripts, add validation gates, improve error handling in workflows.

---

## Project Reference

**Stack:** Next.js 14, TypeScript, Tailwind CSS, static export. Production: https://broadwayscorecard.com
**Scale:** 727+ shows, 14,000+ scored reviews, 420+ outlets, 870+ critics. Critics-only scoring (V1).

### Scoring
Composite = tier-weighted average. **T1** (NYT, Vulture, Variety): 1.0 | **T2** (TheaterMania, NY Post): 0.75 | **T3** (blogs): 0.45
Hierarchy: P0→P0.5→P0b→P1(LLM)→P2(aggregator)→P3(LLM low). Config: `src/config/scoring.ts`.

### Data Structure
`data/` — `shows.json` (source of truth), `reviews.json` (derived via rebuild), `review-texts/{show-id}/` (private repo §7a), grosses/commercial/audience-buzz/critic-consensus/critic-registry JSON files.
Query: `npm run db:build` then `node scripts/query.js "SQL"`. Use `db:build:full` for fullText.

### Key Files
**App:** `engine.ts`, `data-core.ts`, `page.tsx`, `show/[slug]/page.tsx`, `scoring.ts`, `commercial.ts`, `ShowImage.tsx`
**Data:** `data-types.ts`, `data-core.ts`, `data-grosses.ts`, `data-awards.ts`, `data-audience.ts`, `data-commercial.ts`, `data-consensus.ts`, `data-lottery.ts`
**Scripts:** `gather-reviews.js`, `collect-review-texts.js`, `rebuild-all-reviews.js`, `validate-data.js`, `discover-new-shows.js`, `enrich-ibdb-dates.js`, `scrape-grosses.ts`, `generate-critic-consensus.js`, `fetch-show-images-auto.js` (PINNED_IMAGES — never overwrite)

### Content Quality
5 tiers: complete → truncated → excerpt → stub → invalid (`content-quality.js`). 5-layer quality gates on rebuild.
Flags: `wrongProduction`, `wrongShow`, `isRoundupArticle` → excluded. 4-layer wrong-production prevention.

### Automation
Source: `data/review-texts/` → Derived: `reviews.json`. See `.github/workflows/CLAUDE.md`.
Run `node scripts/validate-data.js` before pushing. Secrets via `env:` blocks. Local keys in `.env`.

### Web Scraping
Fallback: Bright Data → ScrapingBee → Playwright (`scripts/lib/scraper.js`).
6 aggregators: Show Score, DTLI, BWW Roundups, BWW Reviews Pages, Playbill Verdict, NYC Theatre Roundups.
Per-show: `gh workflow run "Collect Review Texts" -f show_filter=SHOW_ID -f max_reviews=0`

### Commercial (`/biz`)
Config: `src/config/commercial.ts`. Components: `src/components/biz/`. Never mark `recouped: true` without citation.

For full details on any subsystem: `memory/CLAUDE-reference.md`.

---

## File Hygiene — Preventing Bloat (MANDATORY)
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) are loaded every session — bloat wastes tokens.
- **CLAUDE.md**: Rules that apply to EVERY session. One-line preferred. No backstory/post-mortems — put in memory topic files.
- **MEMORY.md**: Gotchas, API details, lessons learned. Don't duplicate CLAUDE.md. New topics → `memory/{topic}.md` + pointer.
- **Before editing either file**: `wc -l FILE`. If over limit, compress or move to topic files first.
- Completed one-time tasks → `memory/completed-migrations.md`. Session handoffs → delete after pickup.
