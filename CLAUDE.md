# Broadway Scorecard Project Context

## Repo Layout
- **Web:** `~/Broadwayscore/` → GitHub: `thomaspryor/Broadwayscore`
- **iOS app:** `~/BroadwayScorecard-app/` → GitHub: `thomaspryor/BroadwayScorecard-app`

## CRITICAL RULES

### 1. Git Workflow
Global rules apply (worktree-first, branch check, commit frequently). Project additions:
- **Worktree scope (MANDATORY for ANY tracked code edit):** `src/`, `scripts/`, `.github/workflows/`, `supabase/`, `next.config.js`, `tsconfig.json`, `package.json`, `CLAUDE.md` → **must be in a worktree before the first edit** (hooks + CI silently revert uncommitted edits; memory/data files can skip). `memory/feedback_worktree_code_changes.md`.
- **Push** every ~30 min or after milestones. **15+ min without committing** → stop and commit NOW.
- **`git pull` before every shows.json edit.** CI commits to it every ~30 min; stale local copy + rebase silently re-introduces deleted entries. Pull immediately before edits and verify fixes survived after any rebase.

### 2. Vercel Deployment
Git-triggered builds are BLOCKED. Deploys ONLY via `vercel-deploy.yml`.
- **5-min cron + content-aware gate.** Deploys only when site-relevant paths changed vs live, or deploy is >6h old (`scripts/lib/should-deploy-gate.js`; kill switch: `DEPLOY_GATE_DISABLED=true`). Do NOT `gh workflow run "Deploy to Vercel"` (emergency-only). Core-data-only changes ride the next rebuild/6h backstop.
- **"Pushed" ≠ "Deployed" — verify against Vercel, not the GitHub run.** `node scripts/check-prod-deploy.js HEAD` exits 0 only when live on prod (`--wait` polls; ~10 min after landing). A cancel-cascade run reports success while its Vercel deploy is CANCELED; only a READY prod deployment counts.
- **CI monitoring:** see global CLAUDE.md (`wait-for-run.sh`, never `gh run watch`). Detail: `memory/feedback_github_polling_rate_limit.md`.

### 3. Core Data Rules
- **Never extract metadata from URLs** — URLs are inconsistent. Use publish dates and text content.
- **Copyrighted text, PII, API keys** → private repos, all gitignored (see §11).
- **Session data check:** `npm run data:check` at start. Missing → `./scripts/setup-local-data.sh`.
- **Never add stub shows.json entries without running `scripts/validate-show-venue.js` first.** Provisional/manual entries (`discoverySource: manual-user-request`/`venue-page:*`, or `provisional: true`) cross-validate against Playbill before commit (`--show=ID`/`--all-provisional`). Regional feeder exception: `memory/project_regional_expansion_watchlist.md`.
- **Stars are score bands:** 2/5→31-50, 3/5→51-70, 4/5→71-90, 5/5→91-100; read the WHOLE article for the rating, never override outside. `memory/feedback_star_score_cap.md`
- **Critic Score for external claims:** `getCriticScore(showId)` (`scripts/lib/canonical-critic-scores.ts`). Never raw-mean `reviews.json` (`audit-raw-mean-scores.js`). One formula: `scripts/lib/compute-critic-score.js` (BRO-4312). `memory/feedback_critic_score_canonical_helper.md`.

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
**Run `/visual-qa` before any push touching UI files** (`src/**/*.{tsx,jsx,css,scss}`, `tailwind.config.*`; not routes): Pre-push blocks `git push`/`gh pr merge` until the owner replies a plain "yes / ship it". Never ask for a hash or `APPROVED:`. Owner in the chat: their "yes"/"Approved" IS the approval; push `land/<name>` yourself, never send them to tap, then `record-owner-answer.js BRO-N --choice void` on any held ask. No owner (worker): `visual-approval.js request --issue=BRO-N --what=...`. Score badges sacred (`w-20 sm:w-24`). `memory/feedback_local_preview_before_push.md`

### 6. Board = Linear, not the Notion Brain (MANDATORY — every session)
**Linear is the source of truth, never Notion cards.** Notion is retired (froze 2026-08-20); its cards have no Linear twin. Flow: `memory/linear-board-workflow.md`.
- **Session start:** `linear-brain.js create "<title>" --self|--dispatch|--park "<reason>" --notes "..."`; output the URL. `--self` = you do it now (In Progress); technical `--park` refused. **End:** comment the Outcome (what/why/approach/gotchas) + Key Files, then `linear-brain.js update BRO-N --state Done`. Paused/refused: `linear-session.js report --status=paused`.
- **Done is gated (exit 5):** needs `PR-EVIDENCE: merged deployed checked (<url>)`, or a safe-form command in `## Acceptance criteria` / a `VERIFY: <cmd>` line.
- **New discoveries:** file a Linear issue (Todo), don't context-switch.
- **P0/P1 dispatch at creation (owner rule 2026-07-24):** `--dispatch` does NOT launch yet — run `linear-next.js --id BRO-N`, report `DISPATCHED:`. Confirm it started: a `job-spawned` ledger row AND a growing log. Cap ~8/session.
- **Owner answered? `record-owner-answer.js` that turn. Read the card before asking or claiming owner waits (BRO-6411).**
- **Board:** paste `node scripts/board-report.js --markdown`, never hand-built.
- **If Linear is down:** warn, continue untracked, print the Outcome. Never fall back to Notion.

### 7. Infrastructure Change Planning (MANDATORY)
See global CLAUDE.md. Also: test 3 representative cases before merging.

### 8. Pipeline Operations
**E2E test before large dispatch** (5+ runs or 50+ reviews): test 5 first; verify secrets, concurrency slots, 10s+ spacing, shard scoring to 10. **Batch scripts checkpoint** (`if: always()` on commit/push).

### 9. Expansion Playbook (MANDATORY for new markets)
Aggregators first, web search second. See `memory/expansion-playbook.md`. Never skip aggregator scraping.

### 10. Verify External File Modifications (MANDATORY)
When a file is modified externally (linter, other session, hook), `git diff` it immediately. Verify every prior fix survives. External tools silently revert intentional changes.

### 11. Private Repos (see `memory/private-repos.md`)
Review texts, aggregator archive, core data → private repos, all gitignored. CI uses composite actions. Guard: `test.yml` fails if private files leak.

### 12. Test Before Committing (MANDATORY)
Before EVERY commit touching `src/`, `scripts/`, or config:
1. `npx tsc --noEmit` — zero errors in changed files. **`scripts/llm-scoring/` edits: also `npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json`** — CI's gate uses it and it sets `strictNullChecks: true`, unlike the parent config (#516).
2. `npm run lint` — no new warnings
3. Auth-aware build with feature flags
4. **Scripts:** run against real data, minimum 3 diverse cases. `node --check` is syntax only — NOT a test.
5. **Script migrations:** compare output before/after on same input. Empty results = broken.
6. For UI: visual verification per §5
7. **Scoring-logic edits** — watchlists in `scripts/lib/scoring-watchlists.js` (inclusion, score-source, LLM input; unit tests NOT sufficient). **MUST run** `node scripts/scoring-delta.js` AND `node scripts/test-temporal-override-regression.js`, paste summary. The Stop hook enforces scoring-delta.js by exit code (LLM input exits 2 by design: A/B per §13, then `NO-VERIFY: <A/B result>`). See `memory/feedback_scoring_delta_required.md`.
8. **Content-quality regex edits** (`scripts/lib/content-quality.js` arrays): **MUST run** `node scripts/audit-regex-patterns.js --full`. Stop hook requires a completed `--full` run after the latest edit; absent `data/review-texts` only warns. See `memory/feedback_content_quality_regex_fps.md`.
**If any check fails, fix before committing.**

### 13. Prompt Changes Require A/B Check (MANDATORY)
Never rescore >100 reviews without the built-in A/B comparison. Aborts if bucket shift >5% or mean drift >5pts.

### 14. Opening Night Readiness Check (MANDATORY)
**TIMING RULE:** Aggregator/outlet review pages (BWW RR, DTLI, Playbill Verdict, Show Score, NYC Theatre, WET, theatre.reviews, Stagedoor, The Stage) **don't exist until reviews drop** — a pre-opening 404 is normal, not a gap. Revisit items 6/8/9 after first reviews land in `reviews.json`. Talkin' Broadway can publish 24h early.

Run `/verify-opening-night <show-id>` for the full 9-point checklist (cron/CRITICAL_CRONS, ScrapingBee credits, BD zone) plus `node scripts/check-opening-night-readiness.js --show=ID` (category/status). Gotchas: `memory/opening-night-discovery-chains.md`.

---

## Project Reference

**Stack:** Next.js 14, TypeScript, Tailwind CSS, static export. Production: https://broadwayscorecard.com

### Scoring
Composite = tier-weighted average. T1 (NYT, Vulture, Variety): 1.0 | T2 (TheaterMania, NY Post): 0.75 | T3 (general): 0.40 | T4 (blogs): 0.20
**Score display:** `compositeScore` = critic-only (browse, homepage). `blendedScore` = 50/50 critic+audience (Tony predictions).

### Data Structure
`data/` — `shows.json` (source of truth), `reviews.json` (derived via rebuild), `review-texts/{show-id}/` (private repo §11).
Query: `npm run db:build` then `node scripts/query.js "SQL"`. Use `db:build:full` for fullText.

### Automation
Run `validate-data.js` before pushing. Secrets via `env:`. Local keys in `.env`.

### Commercial (`/biz`)
Config: `src/config/commercial.ts`. Components: `src/components/biz/`. Never mark `recouped: true` without citation (a quotable forum post counts).

### Content Quality
5 tiers: complete→truncated→excerpt→stub→invalid. Flags `wrongProduction`, `wrongShow`, `isRoundupArticle` → excluded.
**After ANY manual review recovery** (clearing flags, stubs, ingesting URLs): run `node scripts/verify-review-recovery.js --show=ID --production` — 5 pipeline steps fail silently and independently; it checks all and prints each fix command.

### Web Scraping
Fallback chain: Bright Data → ScrapingBee → Playwright → Browserbase. **Rule:** all new scraping MUST use `fetchPage()` — see scraper-reference skill for the full rule + CI enforcement.
**Aggregators** — BW: Show Score, DTLI, BWW Roundups + Reviews Pages, Playbill Verdict, NYC Theatre. WE: WestEndTheatre (WET), theatre.reviews (TR), Stagedoor (SD), The Stage (TS), London Box Office (LBO) — in `gather-reviews.js` + `opening-night-poller.js`.

For full details on any subsystem: `memory/CLAUDE-reference.md`

### 15. Test Extraction Pattern (MANDATORY for new logic tests)
**Never copy logic into test files — always `require()` the real function.** Extract pure decision functions to `scripts/lib/` (e.g. `review-guards.js`); export and `require()` it in the test. Fixing inline logic: extract → export → wire back → test.

### 16. Memory Entries: Encode First, Write Rarely
**Never offer to "commit a memory file"** (the stop hook syncs memory). Write a memory ONLY if all three hold: (1) **encode-first** — can't be a code/test/hook/CI change; (2) **counterfactual** — names the future action that changes; (3) **recall** — discoverable from its description. No new memory is the normal outcome; "Remember this" → write it.

### 17. Email Broadcast Safety (MANDATORY — NO EXCEPTIONS)
See `memory/email-broadcast-rules.md` for full history.
- **NEVER call `POST /broadcasts/{id}/send` directly** — sends via `send-opening-night-broadcast.js` only
- **NEVER broadcast to test/validate anything** — use `--send-to=your@email.com` (transactional, never broadcast)
- **NEVER send to any Resend audience with >5 real contacts for testing**

### 18. Review BEFORE editing shared infrastructure (owner decision 2026-08-05, #1079)
Dispatch layer, spend guards/circuit breakers, concurrency + push primitives, the review gates, `.github/workflows/**`, `~/.claude/hooks/**`: run `/second-opinion` (`/plan-review` if structural) FIRST, then `node scripts/lib/review-gate.mjs --query=record-plan --reviewer=X --result=pass --session-id=$CLAUDE_CODE_SESSION_ID`. `infra-plan-review-gate.sh` blocks the first edit without it; a fail stands until an `owner-override` verdict. Scope: `infra-review-scope.js`.

### 19. New blocking CI gates land advisory first (BRO-2123)
New `--strict`/`--gate` test.yml steps: `continue-on-error: true` (or own baseline, or `# gate-arm-ok: <proof>`), blocking later. `audit-new-gate-arming.js` enforces; `memory/feedback_new_gates_land_advisory.md`.

---

## File Hygiene
CLAUDE.md (**limit: 150 lines**) and MEMORY.md (**limit: 180 lines**) load every session.
New topics → `memory/{topic}.md` + one-line pointer. Completed tasks → `memory/completed-migrations.md`.

## Cloud sessions
Cloud (iOS/Mac/web, no `~/.claude/`): read `.claude/CLOUD.md`, then `cloud-memory/MEMORY.md`.
**Multi-repo cloud session:** hooks load only via the setup-script install (CLOUD.md § Multi-repo).
**Pre-authorized, never ask:** landing (`land/<name>`), building what was asked, fixing what you find, merging main in, requesting visual approval. Offer endings ("say the word", "shall I") are blocked. Design choices: show screenshots or an Artifact, never text alone.
**Owner never merges PRs:** land via `land/<name>`, follow the Land run (CLOUD.md § Landing). Overrides harness draft-PR default.
**Start important work yourself** with `create_session` (CLOUD.md § Starting a worker session); the worker queue takes weeks. Last line: SAFE TO ARCHIVE / KEEP OPEN / ACTION NEEDED FROM YOU.
