## Memory Index

> **Note:** Aggressively pruned 2026-05-08 to fit the 180-line limit (was 345). Entries describing already-shipped bugfixes were dropped — the rule lives in the code/test, not here. Older detail moved to `archive/`. See `feedback_terse_output_default.md` for why this matters.

## 🌐 External APIs & services
- [Vercel API access](feedback_vercel_api_access.md) — VERCEL_TOKEN in .env; project prj_wmBnDUrCQCwabIAYPbnMiIP3wg15. Use API to set env vars, don't ask user to do it manually.

## 👤 User profile & session discipline
- [Terse output default](feedback_terse_output_default.md) — Short answers, no trailing recap, drop pleasantries. Output tokens cost ~5x input. Verification evidence (rule 2) still required; cut the narration around it.
- [No premature handoff](feedback_no_premature_handoff.md) — Never offer to hand off mid-task; banned-phrase list. /done is punctuation, not an exit.
- [Next steps are actions, not lists](feedback_next_steps_actionable.md) — If you CAN do the next step, DO it.
- [User device context](feedback_user_device_context.md) — Laptop AND phone; infer from message style, don't default to phone.
- [Always wait for async](feedback_always_wait_async.md) — Never end a turn while a dispatched workflow/deploy/rebuild is still in progress.
- [Flag-gated: verify on demo](feedback_flag_gated_verify_on_demo.md) — Prod deploy green ≠ user-visible for flag-gated features. Demo has its own cron-based pipeline; trigger it manually + verify the demo URL renders the feature before declaring shipped.
- [Competition rank for leaderboards](feedback_competition_rank_for_leaderboards.md) — For `#N of M` UIs, use competition rank (1,1,3), not dense rank (1,1,2). Dense rank makes a Skippable show read as top 5%.
- [Verification gate hook](feedback_verification_gate_hook.md) — Stop hook blocks "done" after edits unless a qualifying Bash ran. Bypass: NO-VERIFY:.
- [Probe before scale backfills](feedback_investigate_premise_before_scaling.md) — Parent-card "X files need Y" can be wrong by orders of magnitude; 5-20 file probe first.
- [Save research findings to memory](feedback_save_research_findings.md) — After last30/web research, immediately save actionable ideas.
- [/ship-check catches real P1s](feedback_ship_check_finds_real_bugs.md) — Opus subagent catches bugs tsc/lint/tests miss — never skip. SHIPCHECK gate in verify-edits.sh now enforces for scripts/lib/ + .github/workflows/.
- [Sprint plans always need /plan-review](feedback_sprint_plan_needs_review.md) — Multi-sprint plans authored without /plan-review almost always contain false premises about existing code. Caught 4 P0 + 5 P1 issues in awards sprint plan on 2026-05-17.
- [Test pure function at I/O boundary](feedback_test_pure_function_at_io_boundary.md) — Pure-helper unit tests are insufficient; also exercise the wrapper against real data. The 073db6bab0 ship-check bugs that birthed this rule.
- [Email drafting style](feedback_email_drafting.md) — Minimal em dashes; no mid-paragraph hard line breaks in Gmail.
- [Ask with recommendation](feedback_ask_with_recommendation.md) — Every AskUserQuestion leads with `(Recommended)` option 1 + why. Never neutral menus.
- [Two-model UI review](feedback_two_model_ui_review.md) — For "would this embarrass me?" UI/copy reviews, run GPT-4o + Gemini in parallel on screenshots; convergent findings = ship, divergent = mention with context.
- [Gemini thinking token budget](feedback_gemini_thinking_token_budget.md) — Gemini 2.5 Flash uses internal thinking tokens that count against maxOutputTokens; set `thinkingConfig.thinkingBudget=0` for one-shot prompts or response truncates silently.
- [GitHub polling rate limit](feedback_github_polling_rate_limit.md) — Never `gh run list` in a polling loop; burns rate limit in minutes. Use `gh run watch <id>` instead.

## 📇 Notion / brain
- [Notion brain workflow](notion-brain-workflow.md) — IDs, schema, lifecycle, fallbacks. Read first.
- [Notion CLI only, never MCP](feedback_notion_cli_only.md) — Use `node scripts/notion-brain.js`. MCP is PreToolUse-blocked.
- [Notion card context mandatory](feedback_notion_card_context.md) — Cards are self-contained handoffs: paths, commands, root cause, acceptance.
- [Notion bug cards need repro](feedback_notion_card_reproduction.md) — Specific show IDs, log output, failing step — not just symptom.
- [Notion create: never pipe to grep](feedback_notion_create_verify.md) — Validation rejects silently lose cards; always read full output.
- [Notion create hook false-rejection](feedback_notion_create_hook_false_rejection.md) — Notes containing the word "rejected" trigger a false FAILED breadcrumb that blocks Bash. Use "refused/declined".
- [Roadmap lives in Notion](project_roadmap_notion.md) — Not GitHub issues.

## 🌳 Worktrees & git
- [Worktrees mandatory for code edits](feedback_worktree_code_changes.md) — `src/`, `scripts/`, `.github/workflows/`, `CLAUDE.md` need a worktree before edits. Local hooks silently revert otherwise.
- [Parallel worktree sessions race](feedback_parallel_worktree_race.md) — Re-pull + grep `scripts/lib/` BEFORE writing.
- [Plan "parallel" means subagents, not sessions](feedback_plan_parallel_means_subagents.md) — `/plan-tasks` "Track A/B/C" = subagents within ONE `/execute-plan` session; never advise opening multiple Claude sessions.
- [Worktree edit paths](feedback_worktree_edit_paths.md) — `/Users/tompryor/Broadwayscore/...` resolves to MAIN; prefix with `.claude/worktrees/`.
- [Dual repo data files](feedback_dual_repo_data_files.md) — `shows.json`/`reviews.json` authoritative in private repo; public edits overwritten.
- [data/review-texts NOT a symlink](feedback_review_texts_not_symlink.md) — Two independent copies sync'd via CI. Edit `~/broadway-review-texts/` directly.
- [Commit data repo edits IMMEDIATELY](feedback_data_repos_clobber_uncommitted.md) — Background `pull --rebase` clobbers uncommitted dirty state. Worktrees don't protect data submodules.
- [Reset+rsync wipes CI fields](feedback_reset_rsync_wipes_ci_fields.md) — Never use reset-hard+rsync to resolve push rejections.
- [gh api emergency single-file commit](feedback_gh_api_emergency_commit.md) — When local git is broken, `gh api PUT /contents/` commits one file without touching the working tree.

## 🎭 UGC / user features
- [UGC test failure patterns](feedback_ugc_test_patterns.md) — 6 failure categories: Sanity env, stale mock dates, mobile overflow, rating card count, visual baselines, 404 URLs.

## ⚙️ CI / GitHub Actions / workflows
- [vercel build env block required](feedback_vercel_env_block_required.md) — `vercel build` ignores `.vercel/.env.preview.local` for NEXT_PUBLIC_* inlining. Must pass via build step's `env:` block (same as Sanity vars do). Writing the env file alone = no-op.
- [Vercel NFT dynamic paths](feedback_vercel_nft_dynamic_paths.md) — `process.cwd()+'data/'+variable` causes NFT to include entire data/ tree (590MB git packs, audit logs). Static imports only; never dynamic paths from server code.
- [Conservative default = common case](feedback_conservative_default_can_be_common_case.md) — Helper that defaults to "unknown → assume X" silently misbehaves when unknown IS the common case. 733 historical Tony shows pulsed because ceremonyDate was missing from most records.
- [GitHub polling burns rate limit](feedback_github_polling_rate_limit.md) — Never `gh run list` in a loop; use `gh run watch <id>` or `gh api` directly. Loop + 403 = infinite retry, all quota gone.
- [CI red check vs main baseline](feedback_ci_failure_preexisting_baseline.md) — Before blocking on a red PR check, check if main's last run of the same job was also red.
- [GitHub auto-disables stale scheduled workflows](feedback_github_auto_disable_workflows.md) — After ~60 days without a successful cron run, GitHub silently disables. `gh workflow run` returns HTTP 422; `gh workflow list` omits.
- [GHA secrets not usable in if:](feedback_gha_secrets_in_if.md) — Step-level if conditions can't read secrets; 422 at dispatch.
- [GHA cron delays](feedback_github_cron_delays.md) — Crons fire 30min-3h late; shift earlier; launchd backup.
- [Silent workflow failures](feedback_silent_workflow_failures.md) — Never `|| true` on git push/commit; use `|| echo "::warning::..."`.
- [Silent git add failures](feedback_silent_git_add_failures.md) — `git add a b c 2>/dev/null || true` may stage NOTHING when one path errors. Per-path guards or nullglob arrays.
- [Silent merge loss on reformat](feedback_silent_merge_loss_on_reformat.md) — Worktree JSON reformat + concurrent main edit silently drops additions on merge. Re-run feature unit tests on main post-merge.
- [Pipe masks exit code](feedback_pipe_masks_exit_code.md) — `node x.js | tail` returns tail's exit, not node's; use pipefail.
- [Workflow YAML inline-commit smoke test](feedback_workflow_yaml_needs_manual_fire.md) — Static reviewers miss missing `git config user.name/email` in commit steps. Manual-fire surfaces it.
- [GHA heredoc indentation](feedback_yaml_heredoc_indentation.md) — Heredoc content starting at column 0 inside `run: |` breaks YAML parsing. Keep ≥10 spaces indent or use array.join() for multi-line strings.
- [Workflow cascade prevention](feedback_workflow_cascade_prevention.md) — Trace dispatch graph — circular chains blew up to 1000+ runs/day.
- [Test extraction pattern](feedback_test_extraction_pattern.md) — Never copy logic into tests; extract to `scripts/lib/` and require().
- [Node test format, not Jest](feedback_test_format_node_not_jest.md) — Tests must be `.mjs` with `node:test` API; register in test.yml.
- [CI tsc gate scope](feedback_ci_tsc_gate_scope.md) — `typescript-check` job covers root tsc + scoped `scripts/llm-scoring/tsconfig.json`. Other scripts/* subtrees not gated.
- [Hook stdin format](feedback_hook_stdin_format.md) — PostToolUse stdin nested under `tool_input`; jq `.tool_input.command`.
- [Outlet registry dual repo](feedback_outlet_registry_dual_repo.md) — Update `outlet-registry.json` in BOTH repos; CI uses private.

## 🔌 External APIs
- [404 is not always terminal failure](feedback_404_not_terminal.md) — API pollers must never flip success→failure on 404 without prior-state check.
- [Live-API contract test](feedback_live_api_contract_test.md) — Unit tests can't reveal empirical API behavior; call the live API.
- [Refactor parity test on real data](feedback_refactor_parity_test.md) — Run old vs new predicate against real data; 0 diffs = safe ship.
- [Verify bug claim before fixing](feedback_verify_bug_claim_before_fixing.md) — Reproduce postmortem bugs against live data before writing fix code.

## 🎯 Opening night pipeline
- [Joe Turner master log 2026-04-25/26](feedback_admin_ingest_opening_night_2026-04-26.md) — Consolidated ~42 issues across 2 sessions. Read FIRST for next opening night.
- [Manual ingest opening-night runbook](feedback_manual_ingest_opening_night_runbook.md) — 25-item failure-mode checklist.
- [Aggregator pages post-opening only](feedback_aggregator_pages_post_opening.md) — BWW RR / DTLI / TB / Playbill / WET / TR / SD / TS don't exist pre-opening; never pre-stage.
- [SERP opening night timing](feedback_serp_opening_night_timing.md) — Google indexes major outlets no earlier than 2.9h after publication; 3h gate is fact-based.
- [shows.json category at scheduling](feedback_shows_json_category_at_schedule.md) — Schmigadoon had null category/market on opening day; validate-data.js should fail.
- [OB openingDate==previewsStartDate skips orchestrator](feedback_off_broadway_opening_date_gap.md) — 23/30 recent open OB shows have openingDate==previewsStartDate; orchestrator's 2-day lookback fires on previews-start, never reaches press night.
- [Opening night corrections](feedback_opening_night_corrections.md) — Disable orchestrator first; humanReviewScore is the ONLY override.
- [Email broadcast rules](email-broadcast-rules.md) — Hard rules post-March-2026 incident; never direct broadcast API.
- [Broadcast quality bar](feedback_broadcast_quality_bar.md) — ≥1 more review than BWW RR; send 7-9am next morning.
- [Orchestrator pause ≠ broadcast pause](feedback_orchestrator_pause_does_not_pause_broadcast.md) — Broadcast auto-fires on workflow_run; disable workflow.
- [PROTECTED_FIELDS 3-way sync](feedback_protected_fields_three_way_sync.md) — review-write-guard + push-review-texts action + restore-protected-fields must all carry overrides.

## 🏆 Awards scoring
- [Awards enrichment ≠ scoring](feedback_awards_enrichment_scoring_decoupled.md) — Adding ceremony data to awards.json doesn't score it. computeSiteAwardScore() has an explicit allowlist; must add CeremonyKey + POINTS entry + if(entry.X) block for each new ceremony.

## 🎭 Tony predictions model
- [Tony predictions accuracy](project_tony_predictions_accuracy.md) — Recipe weights, historical accuracy (92.9%), current-season signals, market data coverage, backtest findings.

## 📊 Data pipeline & scraping
- [Closing-date automation has 4 silent gaps](feedback_closing_date_audit_gaps.md) — update-show-status + check-closing-dates only detect LATER-than-stored extensions; both broadway.org "Through:" and TodayTix `endDate` lag the announced final performance by months; WE has zero closingDate automation.
- [Scraper architecture](feedback_scraper_architecture.md) — New scraping scripts MUST use `fetchPage()`; CI enforces BD+SB both present.
- [fetchPage gotchas](feedback_fetchpage_gotchas.md) — BD empty 200s, Playwright renders 404s as success, fetchPage is HTML-only.
- [BD zone migrated: web_unlocker2](feedback_brightdata_zone_migration.md) — `mcp_unlocker` is obsolete trial zone; active zone is `web_unlocker2` via `$BRIGHTDATA_ZONE`.
- [SB credit budget](feedback_sb_credit_budget.md) — `SB_CREDIT_BUDGET=250`, `SB_PAGE_CREDIT_BUDGET=200`; override for bulk runs.
- [Cloudflare bypass hierarchy](feedback_cloudflare_bypass_hierarchy.md) — Managed challenge defeats Playwright/BD/SB/fetch; only Browserbase works.
- [WSJ/NY CI IP block](feedback_wsj_newyorker_ci_ip_block.md) — DataDome blocks GH Actions; Browserbase only.
- [Aggregator soft 404](feedback_aggregator_soft_404.md) — BWW returns homepage with 200 OK; check `<title>` tag.
- [Stage cookie minimal set](feedback_stage_cookie_minimal_set.md) — 5 cookies; cookie-only auth (THESTAGE_EMAIL/PASSWORD deleted).
- [Mac Studio cookies](feedback_mac_studio_cookies.md) — Tahoe path changed; Terminal needs FDA; 11 COOKIES_BUNDLE_* secrets.
- [Audience scrapers share normalize](feedback_audience_scrapers_share_normalize.md) — All audience scrapers must import `normalizeTitle` from `scripts/lib/title-match.js`.
- [Commit audience-buzz before CI rebuild](feedback_audience_buzz_commit_before_rebuild.md) — After local audience scraping, commit `audience-buzz.json` to private repo immediately. CI rebuild reads GitHub-hosted file; uncommitted local data is silently overwritten.
- [Table scrapers need structural assertions](feedback_scraper_table_assertions.md) — Hardcoded `cells[N]` + length-only guards make scrapers silently fail on source-side column changes. BWW broke scrape-alltime for 2 months in 2026-Q2.
- [Object-literal duplicate keys silently overwrite](feedback_object_literal_duplicate_keys.md) — Adding `'vulture': {...}` to a registry that already has `'vulture': {...}` silently nukes the existing entry. Grep before adding; use sibling-key + outletIdOverride when same canonical id needs different dispatch. Caught Sprint 2 nuking Broadway-Vulture/West-End-Times-UK.

## 🧮 Scoring & review guards
- [\b regex fails for trailing-punct titles](feedback_word_boundary_punct_titles.md) — `\b{title}\b` silently returns 0 matches for ~90 catalogue shows ending in `!`/`?`/`.` (Schmigadoon!, Mamma Mia!, etc.). Use non-alphanumeric lookbehind/lookahead.
- [Apostrophe in names breaks \b regex matching](feedback_apostrophe_name_matching.md) — `\bobrien\b` doesn't match "O'Brien"; normalize text + name identically (lowercase + strip apostrophes/hyphens) before matching.
- [Orphan utility scripts hide existing solutions](feedback_orphan_utility_scripts.md) — Before writing new detection code, grep `scripts/` for existing utilities that may already solve the problem (often unwired from CI).
- [Scoring-logic delta required](feedback_scoring_delta_required.md) — Edits to review-guards/rebuild/scoring MUST run `scoring-delta.js` + temporal fixture. Stop hook enforces.
- ["Must match X" comment IS the bug](feedback_must_match_comment_is_a_bug.md) — When code says "must match X" / "keep in sync with Y", eliminate the duplicate; don't preserve the comment. TIER_WEIGHTS had 4 silent canonicals before this.
- [Includability predicates must be canonical](feedback_includability_predicates_must_be_canonical.md) — New scripts gating on review-includability flags must call `isIncludableForRebuild` from `review-guards.js`.
- [Manual-clear covers all rejection types](feedback_manual_clear_covers_all_rejection_types.md) — wrongProduction carve-out MUST extend to wrongShow.
- [Star score cap rule](feedback_star_score_cap.md) — Stars are ground truth; 5/5=100 is correct, never cap with LLM.
- [Reviews.json dual repo push](feedback_reviews_json_dual_repo_push.md) — Flag + rebuild + push data repo + redeploy; review-texts alone isn't enough.
- [Review recovery pipeline gaps](feedback_review_recovery_pipeline_gaps.md) — Run `verify-review-recovery.js`; 5 steps silently fail independently.
- [Protected fields on every write](feedback_protected_fields_every_write.md) — Every write path must check `humanReviewedWrongProduction`/`humanReviewScore`.
- [Manual review protection fields](feedback_manual_review_protection_fields.md) — Manual reviews need ALL 8 protection fields or guards re-flag.
- [URL-date guards need criticName gate](feedback_url_date_guards_critic_gate.md) — URL-date guards must gate on Unknown byline.
- [Curated historical 4-review threshold](feedback_curated_historical_4review_threshold.md) — `isCuratedHistorical` flag → 4-review minimum (vs 5) when ≥1 T1/T2 review present.
- [Bare X/Y regex FPs](feedback_regex_url_fragment_fps.md) — `\d/\d` patterns FP on CDN paths and date headers. Anchor + URL filter required.
- [Content-quality regex bare-keyword FPs](feedback_content_quality_regex_fps.md) — Audit patterns against real corpus before edit.
- [JS array > 0 is always false](feedback_js_array_gt_comparison.md) — `string[] > 0` silently returns false; use `Array.isArray(x) ? x : []` + `.length > 0` for array fields.
- [Same-title-different-production routing](feedback_same_title_disambiguation.md) — Extend `classifyMarketRouting` at the single writer chokepoint; ≥2-signal cascade (url-year/publish-date/venue); stamp wrongProduction with humanReviewedWrongProduction guard. Don't add a new resolver.

## 🤖 LLM / evals
- [LLM prompts must be market/type-aware](feedback_llm_prompts_market_aware.md) — Theater-tuned prompts mis-classify opera/special shows that live as type-overlays on category=off-broadway. Inject canonical context blocks from `scripts/lib/opera-prompt-context.js`; spell out WRONG criteria BEFORE leniency.
- [Eval patterns](feedback_eval_patterns.md) — Lib layout, 3-point validator, real-iteration loop, golden fixtures.
- [LLM wrongprod false positives](feedback_llm_wrongprod_false_positives.md) — ~15% FP on high-conf flags; temporal override is a safety net.
- [LLM verifier hallucinates](feedback_llm_verifier_hallucinates.md) — Gemini `isValid:true` at 48% on garbage; post-check with `findShowKeywordInText`.
- [Opus for classification](feedback_opus_for_classification.md) — Sonnet 75% FN on review vs commentary; use Opus.
- [Editorial drift guard](feedback_editorial_drift.md) — Drift guard silently discards LLM content when show counts change.

## 🎨 UI / design system
- [Design system reference](design-system.md) — Surfaces, score tiers, shared components, CSS classes, banned patterns.
- [Visual verify before push](feedback_visual_verify_before_push.md) — Screenshot-verify on running site before commit; tsc is not visual.
- [Playwright must be 1440px](feedback_playwright_1440px_required.md) — Always resize to 1440×900 before screenshot; small viewports hide desktop misalignment.
- [Preserve parallel-session colors](feedback_preserve_parallel_session_colors.md) — When porting Claude Design output, keep score-box / tier-badge colors shipped by parallel sessions (e.g. awards) instead of CD's proposed palette.
- [Round once, share everywhere](feedback_round_once_share_everywhere.md) — Every gate on a rounded score must round too; centralize in `isCriticalGold()`.
- [Map iterator spread broken](feedback_map_iterator_spread.md) — Never `[...map.keys()]`; use `Array.from()`. tsconfig es5 breaks spread.
- [Demo flags client-only](feedback_demo_flags_client_only.md) — `isDemo()`/window checks must run in `'use client'` only; CI lint enforces.
- [A/B tests](feedback_ab_test_guardrails.md) — PostHog filters/exclusions/stat-sig thresholds.

## 💼 Commercial / features / video
- [Commercial slug keys](feedback_commercial_slug_keys.md) — `commercial.json` keyed by slug not ID.
- [Feature launch sequence](project_feature_launch_sequence.md) — Lottery/Rush → Awards/Tony → Commercial. Don't enable yet.
- [VideoScore](project_videoscore_feature.md) — Video critic reviews via transcript sentiment.

## 📚 Reference & repo layout
- [Repo layout](repo_layout.md) — Three repos (web, iOS app, data) with GitHub names and local paths.
- [Claude config sync](reference_claude_config_sync.md) — `~/.claude` is a private GitHub repo; use `claude-sync push/pull`.
- [Theatre Record reference](reference_theatre_record.md) — Paid UK review archive.
- [Repo cost cuts April 2026](project_brightdata_cost_cuts_2026-05.md) — BD bill spike root cause + 4 reversible cuts shipped 2026-05-08.

## 🗄️ Archive
- [Archive memory files in place](feedback_memory_archive_in_place.md) — Don't `git mv` to `memory/archive/`; ~100s of source-code comments reference files by path. Use `archived: true` frontmatter instead.
Older entries with `archived: true` frontmatter are skipped by `rebuild-memory-index.js` but remain on-disk for grep + hardcoded path refs.
- [Phase B-WE → BW learnings](feedback_phase_b_we_learnings_for_broadway.md) — 6 concrete fixes from WE soft-launch to bake into BW W1, not catch in ship-check (idempotence flag, max-cost cap, push-noise log, workflow auto-re-enable, --ours/--theirs flip, apples-to-apples gate).
