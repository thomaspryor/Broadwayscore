# Broadway Scorecard Project Context

## Repo Layout
- **Web:** `~/Broadwayscore/` → GitHub: `thomaspryor/Broadwayscore`
- **iOS app:** `~/BroadwayScorecard-app/` → GitHub: `thomaspryor/BroadwayScorecard-app`

## CRITICAL RULES

### 1. Git Workflow
Global rules apply (worktree-first, branch check, commit frequently). Project additions:
- **Worktree scope (MANDATORY for ANY tracked code edit):** `src/`, `scripts/`, `.github/workflows/`, `supabase/`, `next.config.js`, `tsconfig.json`, `package.json`, `CLAUDE.md` → **must be in a worktree before the first edit** (local hooks + parallel CI silently revert uncommitted edits; memory/data files can skip). See `memory/feedback_worktree_code_changes.md`.
- **Push** every ~30 min or after milestones. **15+ min without committing** → stop and commit NOW.
- **`git pull` before every shows.json edit.** CI commits to it every ~30 min; stale local copy + rebase silently re-introduces deleted entries. Pull immediately before edits and verify fixes survived after any rebase.

### 2. Vercel Deployment
Git-triggered builds are BLOCKED. Deploys ONLY via `vercel-deploy.yml`.
- **5-min cron + content-aware gate.** Deploys only when site-relevant paths changed vs live, or deploy is >6h old (`scripts/lib/should-deploy-gate.js`; kill switch: `DEPLOY_GATE_DISABLED=true`). Lands in ~5-10 min — do NOT `gh workflow run "Deploy to Vercel"` (races the cron, re-triggers cancel-cascade); manual dispatch is emergency-only. Private core-data-only changes ride the next rebuild/6h backstop.
- **"Pushed" ≠ "Deployed" — verify against Vercel, not the GitHub run.** `node scripts/check-prod-deploy.js HEAD` exits 0 only when live on prod (`--wait` to poll; deploys lag 20-30 min in bursts). A cancel-cascade run reports success while its Vercel deploy is CANCELED — READY prod deployment is the only proof (2026-06-26).
- **CI monitoring:** never `gh run watch` (polls every 3s, zeroed the quota twice). Use `scripts/lib/wait-for-run.sh <run-id> [min]`; prefer outcome checks (prod URL, check-prod-deploy.js, raw.githubusercontent.com, data-repo `git log`) — all rate-limit-immune. On 403: `gh api rate_limit` for the reset, don't loop gh. Detail: `memory/feedback_github_polling_rate_limit.md`.

### 3. Core Data Rules
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- **Copyrighted text, PII, API keys** → private repos, all gitignored (see §11).
- **Session data check:** `npm run data:check` at start. Missing → `./scripts/setup-local-data.sh`.
- **Never add stub shows.json entries without running `scripts/validate-show-venue.js` first.** Provisional/manual entries (`discoverySource: manual-user-request`/`venue-page:*`, or `provisional: true`) cross-validate against Playbill before commit: `node scripts/validate-show-venue.js --show=ID` (or `--all-provisional`). Catches wrong-year revivals + stub-from-memory dates. Exception: regional feeder-venue shows auto-promote off their PV/BWW roundup page (`promote-ob-venue-candidates.js --regional-only`) — the roundup IS the validation.
- **Critic Score for external claims:** use `getCriticScore(showId)` from `scripts/lib/canonical-critic-scores.ts` only. Reads `public/data/shows/{id}.json:cs` so it's parity-by-definition with the live site. Never raw-mean `reviews.json` and never use `getAllShows()/engine.ts compositeScore` — both diverged in shipped copy. Full rationale + 2026-05-30 / 2026-06-02 incidents: `memory/feedback_critic_score_canonical_helper.md`.

### 4. Design System (MANDATORY — read `memory/design-system.md` before ANY UI work)
Use shared components from `src/components/show-cards/` — never create custom versions.
- **Components** (import from `@/components/show-cards`): ScoreBadge, ScoreBreakdownBar, ShowListCard, MiniShowCard, StatusBadge, Modal, ShowSearchDropdown, … — full list in `memory/design-system.md`.
- **Surface colors:** `bg-surface` (page), `bg-surface-raised` (cards), `bg-surface-overlay` (hover), `bg-surface-elevated` (modals). **NEVER use `zinc-*`, `slate-*`, or hardcoded dark hex values.**
- **Score colors:** Always use `getScoreBucket()` from `score-buckets.ts` or `getScoreTier()` from show-cards. Never hardcode tier colors.
- **Cards:** Use `.card` / `.card-interactive` / `.card-premium` CSS classes. Never build custom card borders/backgrounds.
- **Status colors:** Use domain tokens — `status-open` (success), `score-tepid` (warning), `score-skip` (danger). Never invent custom red/yellow/green.
- **Per-market branding:** `src/config/branding.ts` is single source of truth. Never hardcode brand colors.
- **When adding new shared components or tokens**, update `memory/design-system.md`.

### 5. Visual QA (MANDATORY for UI Changes — gate ENFORCES)
**Run `/visual-qa` before any push touching UI files** (`src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`, `src/app/**`): element crops + overflow probe + two-model LLM diff vs references. Stop hook blocks visual-correctness claims without a fresh verdict; pre-push hook blocks `git push`/`gh pr merge` without user `APPROVED: <verdictHash>`. Bypass: `NO-VERIFY: <reason>` or `ship immediately for: <reason>`. **Score badges sacred** (`w-20 sm:w-24`). Full rules: `memory/feedback_local_preview_before_push.md`.

### 6. Notion Brain (MANDATORY — every session)
**Notion is the single source of truth for project state.** See `memory/notion-brain-workflow.md` for IDs, schema, and full lifecycle.
- **Session start:** Create a Notion card → "In progress," output URL, check for stale cards. **Session end:** Append Outcome (what/why/approach/gotchas) + Key Files + Tags → "Done"/"Paused."
- **New discoveries:** Create Notion card (Not started). Don't context-switch.
- **P0/P1 cards auto-dispatch at creation (owner rule 2026-07-24):** a technical, self-contained P0/P1 card gets a workspace the moment it's carded — `notion-tasks-sync.js pull` → `bsc-next.js --list` (pending P0/P1s below top-10 print in a tail) → `bsc-next.js --id N` → report `DISPATCHED:`. "I carded it" alone is a process failure; only owner-judgment cards stay parked. Soft cap: >~3 auto-dispatches/session → confirm with owner.
- **If Notion unreachable:** Warn user, continue without tracking. On wrap-up failure, output Outcome text so nothing is lost.

### 7. Infrastructure Change Planning (MANDATORY)
See global CLAUDE.md. Also: test 3 representative cases before merging.

### 8. Pipeline Operations
**E2E test before large dispatch** (5+ runs or 50+ reviews): test 5 first; verify secrets, concurrency slots, 10s+ spacing, shard scoring to 10. **Batch scripts checkpoint** — save incrementally, `if: always()` on commit/push.

### 9. Expansion Playbook (MANDATORY for new markets)
Aggregators first, web search second. See `memory/expansion-playbook.md`. Never skip aggregator scraping.

### 10. Verify External File Modifications (MANDATORY)
When a file is modified externally (linter, other session, hook), `git diff` it immediately. Verify every prior fix survives. External tools silently revert intentional changes.

### 11. Private Repos (see `memory/private-repos.md`)
Review texts, aggregator archive, core data → private repos, all gitignored. CI uses composite actions. Guard: `test.yml` fails if private files leak.

### 12. Test Before Committing (MANDATORY)
Before EVERY commit touching `src/`, `scripts/`, or config:
1. `npx tsc --noEmit` — zero errors in changed files. **`scripts/llm-scoring/` edits: also `npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json`** — CI's gate uses it and it sets `strictNullChecks: true`, unlike the parent config (#516).
2. `npx next lint` — no new warnings
3. Auth-aware build with feature flags
4. **Scripts:** run against real data, minimum 3 diverse cases. `node --check` is syntax only — NOT a test.
5. **Script migrations:** compare output before/after on same input. Empty results = broken.
6. For UI: visual verification per §5
7. **Scoring-logic edits** — two watchlists (unit tests NOT sufficient). Inclusion: `scripts/lib/review-guards.js`, `scripts/rebuild-all-reviews.js`, `src/lib/{scoring,engine,data-core}.ts`. Score-source: `scripts/lib/{rebuild-helpers,score-extractors,score-parsers,review-normalization,score-routing}.js`. **MUST run** `node scripts/scoring-delta.js` AND `node scripts/test-temporal-override-regression.js`, paste summary before pushing (Stop hook enforces). See `memory/feedback_scoring_delta_required.md`.
8. **Content-quality regex edits** (`scripts/lib/content-quality.js` pattern arrays) — **MUST run** `node scripts/audit-regex-patterns.js --full` before pushing (catches bare-keyword FPs unit tests miss; Stop hook enforces; also runs non-blocking in `check-corpus-drift.yml`). See `memory/feedback_content_quality_regex_fps.md`.
**If any check fails, fix before committing.** Never push broken code.

### 13. Prompt Changes Require A/B Check (MANDATORY)
Never rescore >100 reviews without the built-in A/B comparison. Aborts if bucket shift >5% or mean drift >5pts.

### 14. Opening Night Readiness Check (MANDATORY)
**TIMING RULE:** Aggregator/outlet review pages (BWW RR, DTLI, Playbill Verdict, Show Score, NYC Theatre, WET, theatre.reviews, Stagedoor, The Stage) **don't exist until reviews drop** — a pre-opening 404 is normal, don't pre-stage or treat as a gap. Revisit items 6/8/9 only after first reviews land in `reviews.json`. Exception: Talkin' Broadway can publish 24h early (handled by TB direct-URL discovery).

Run `/verify-opening-night <show-id>` for the full 9-point checklist. Check the AUTOMATION CHAIN, not just data: Opening Night Orchestrator cron fired (5 entries: 23:00 UTC BW evening, 08:00 UTC BW morning, 05:00 UTC WE morning, 18:00 UTC WE evening) and is in `check-cron-health.yml` CRITICAL_CRONS (force: `gh workflow run opening-night-orchestrator.yml -f show_id=ID -f market=broadway`); `category` is set, not `null`; `status='open'` pushed to private repo; ScrapingBee >25% credits; BD zone `web_unlocker2` active (ignore `mcp_unlocker` alarms). Gotchas: `memory/opening-night-discovery-chains.md`.

---

## Project Reference

**Stack:** Next.js 14, TypeScript, Tailwind CSS, static export. Production: https://broadwayscorecard.com
**Scale:** 726+ shows, 15,300+ scored reviews, 394+ outlets, 880+ critics (via `getDataStats()`, `src/lib/data-core.ts` — rerun to refresh if stale).

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
5 tiers: complete→truncated→excerpt→stub→invalid. Flags `wrongProduction`, `wrongShow`, `isRoundupArticle` → excluded.
**After ANY manual review recovery** (clearing flags, stubs, ingesting URLs): run `node scripts/verify-review-recovery.js --show=ID --production` — 5 pipeline steps fail silently and independently; it checks all and prints each fix command.

### Web Scraping
Fallback chain: Bright Data → ScrapingBee → Playwright. **Rule:** all new scraping MUST use `fetchPage()` from `scripts/lib/scraper.js` — never call BD/SB APIs directly; scraping workflows pass both `BRIGHTDATA_TOKEN` AND `SCRAPINGBEE_API_KEY` (CI enforces in `lint-workflows`; exemptions: test.yml exempt list with comment).
**Aggregators** — BW: Show Score, DTLI, BWW Roundups + Reviews Pages, Playbill Verdict, NYC Theatre. WE: WestEndTheatre (WET), theatre.reviews (TR), Stagedoor (SD), The Stage (TS), London Box Office (LBO) — in `gather-reviews.js` + `opening-night-poller.js`.

For full details on any subsystem: `memory/CLAUDE-reference.md`

### 15. Test Extraction Pattern (MANDATORY for new logic tests)
**Never copy logic into test files — always `require()` the real function.** Extract pure decision functions to `scripts/lib/` (e.g. `review-guards.js`); `module.exports` and `require()` in the test. Production code changes → test fails — that's the point. When fixing inline pipeline logic: extract → export → wire back → test.

### 16. Memory Entries: Encode First, Write Rarely
**Never offer to "commit a memory file"** — the session-stop hook syncs local memory automatically. Write a memory ONLY if all three hold: (1) **encode-first** — can't be a code/test/hook/CI change (rare exception: multi-cause triage recipes); (2) **counterfactual** — names the future action that changes; (3) **recall** — discoverable from its description. **No new memory is the normal outcome**; it never satisfies "Prevention added" when code-level prevention was possible. "Remember this" from the user → write it.

### 17. Email Broadcast Safety (MANDATORY — NO EXCEPTIONS)
See `memory/email-broadcast-rules.md` for full history.
- **NEVER call `POST /broadcasts/{id}/send` directly** — sends via `send-opening-night-broadcast.js` only
- **NEVER broadcast to test/validate anything** — use `--send-to=your@email.com` (transactional, never broadcast)
- **NEVER send to any Resend audience with >5 real contacts for testing**

---

## File Hygiene
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) load every session.
New topics → `memory/{topic}.md` + one-line pointer. Completed tasks → `memory/completed-migrations.md`.

## Cloud sessions
Cloud sessions (iOS, Mac app, claude.ai/code) have no `~/.claude/`: read `.claude/CLOUD.md`, then `cloud-memory/MEMORY.md`; `node scripts/check-cloud-secrets.js` verifies secrets.
