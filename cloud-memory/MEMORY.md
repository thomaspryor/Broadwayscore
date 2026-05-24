## Memory Index

> Limits: 180 lines / 12KB. Entries are short hooks — detail lives in individual `.md` files.

## 🌐 External APIs & services
- [Vercel API access](feedback_vercel_api_access.md) — VERCEL_TOKEN in .env; prj_wmBnDUrCQCwabIAYPbnMiIP3wg15
- [Google Search Console API](feedback_gsc_api_auth.md) — gcloud ADC + webmasters scope (with cloud-platform); X-Goog-User-Project header required

## 👤 User profile & session discipline
- [Terse output default](feedback_terse_output_default.md) — no recap, cut narration, keep proof
- [No premature handoff](feedback_no_premature_handoff.md) — never offer handoff; /done is punctuation
- [Next steps are actions](feedback_next_steps_actionable.md) — if you CAN do it, DO it now
- [No diff-review offers](feedback_no_review_offers_user_not_technical.md) — user is non-technical; never offer "review the diff" or commit-vs-review choice
- [User device context](feedback_user_device_context.md) — laptop+phone; infer from message style
- [Always wait for async](feedback_always_wait_async.md) — never end turn while deploy/rebuild runs
- [Flag-gated: verify on demo](feedback_flag_gated_verify_on_demo.md) — prod deploy ≠ user-visible; verify demo URL
- [Competition rank for leaderboards](feedback_competition_rank_for_leaderboards.md) — use competition rank (1,1,3) not dense
- [Verification gate hook](feedback_verification_gate_hook.md) — Stop hook blocks "done"; bypass: NO-VERIFY:
- [Probe before scale backfills](feedback_investigate_premise_before_scaling.md) — 5-20 file probe before assuming scale
- [Save research findings to memory](feedback_save_research_findings.md) — save last30/web findings immediately
- [/ship-check catches real P1s](feedback_ship_check_finds_real_bugs.md) — never skip; enforced for scripts/lib/ + workflows
- [Systematic fix: threat model + parity test](feedback_systematic_fix_threat_model_first.md) — check trigger frequency; parity-test bad URLs (also [[serp-parity-test-pattern]])
- [Sprint plans need /plan-review](feedback_sprint_plan_needs_review.md) — always /plan-review before multi-sprint plans
- [Test pure function at I/O boundary](feedback_test_pure_function_at_io_boundary.md) — also test wrapper against real data
- [Email drafting style](feedback_email_drafting.md) — minimal em dashes; no mid-paragraph hard breaks
- [Ask with recommendation](feedback_ask_with_recommendation.md) — lead with (Recommended) option 1 + why
- [Two-model UI review](feedback_two_model_ui_review.md) — GPT-4o + Gemini parallel on screenshots
- [Three-model audit needs code-reader](feedback_three_model_audit_modality.md) — vision models hallucinate "X is missing"; pair with Claude subagent w/ file access for data audits
- [Gemini thinking token budget](feedback_gemini_thinking_token_budget.md) — set thinkingBudget=0 or response truncates
- [GitHub polling rate limit](feedback_github_polling_rate_limit.md) — never gh run list in loop; use gh run watch

## 📇 Notion / brain
- [Notion brain workflow](notion-brain-workflow.md) — IDs, schema, lifecycle. Read first.
- [Notion CLI only, never MCP](feedback_notion_cli_only.md) — use node scripts/notion-brain.js
- [Notion card context mandatory](feedback_notion_card_context.md) — cards need paths, commands, root cause, acceptance
- [Notion bug cards need repro](feedback_notion_card_reproduction.md) — show IDs, log output, failing step
- [Notion create: never pipe to grep](feedback_notion_create_verify.md) — always read full output
- [Notion create hook false-rejection](feedback_notion_create_hook_false_rejection.md) — avoid "rejected"; use "refused/declined"
- [Roadmap lives in Notion](project_roadmap_notion.md) — not GitHub issues

## 🌳 Worktrees & git
- [Worktrees mandatory for code edits](feedback_worktree_code_changes.md) — src/, scripts/, .github/, CLAUDE.md
- [Parallel worktree sessions race](feedback_parallel_worktree_race.md) — re-pull + grep scripts/lib/ BEFORE writing
- [Plan "parallel" = subagents](feedback_plan_parallel_means_subagents.md) — not multiple Claude sessions
- [Worktree edit paths](feedback_worktree_edit_paths.md) — prefix paths with .claude/worktrees/
- [Dual repo data files](feedback_dual_repo_data_files.md) — shows.json/reviews.json authoritative in private repo
- [awards.json dual repo](feedback_awards_json_dual_repo.md) — CI overlays private copy; must fix BOTH
- [data/review-texts NOT a symlink](feedback_review_texts_not_symlink.md) — edit ~/broadway-review-texts/ directly
- [audit-review-contamination strict CI gate](feedback_audit_contamination_strict_mode.md) — strict A/B/C fail CI; B = false-pos wrongProduction
- [Commit data repo edits IMMEDIATELY](feedback_data_repos_clobber_uncommitted.md) — pull --rebase clobbers uncommitted dirty state
- [Reset+rsync wipes CI fields](feedback_reset_rsync_wipes_ci_fields.md) — never reset-hard+rsync for push rejections
- [gh api emergency commit](feedback_gh_api_emergency_commit.md) — gh api PUT /contents/ when local git broken

## 🎭 UGC / user features
- [UGC test failure patterns](feedback_ugc_test_patterns.md) — 6 categories: Sanity env, mock dates, overflow, ratings, visuals, 404s
- [page.evaluate .click() races hydration](feedback_playwright_evaluate_click_hydration.md) — synthesized DOM .click() fires before React handler attaches; use page.getByRole().click() for actionability

## ⚙️ CI / GitHub Actions / workflows
- [vercel build env block required](feedback_vercel_env_block_required.md) — NEXT_PUBLIC_* must go in build step env: block
- [Vercel NFT dynamic paths + excludes](feedback_vercel_nft_dynamic_paths.md) — no dynamic paths in server code; before adding outputFileTracingExcludes, grep src/ — CI guard `audit-nft-excluded-runtime-reads.js` enforces. See also [[nft-excludes-vs-runtime-reads]]
- [Conservative default = common case](feedback_conservative_default_can_be_common_case.md) — "unknown → assume X" breaks when unknown IS common
- [CI red vs main baseline](feedback_ci_failure_preexisting_baseline.md) — check if main's last run was also red first
- [GitHub auto-disables stale workflows](feedback_github_auto_disable_workflows.md) — ~60 days inactive → silently disabled; HTTP 422
- [GHA secrets not usable in if:](feedback_gha_secrets_in_if.md) — step-level if conditions can't read secrets
- [GHA cron delays](feedback_github_cron_delays.md) — crons fire 30min-3h late; shift earlier + launchd backup
- [`if: always()` cleanup budget](feedback_if_always_does_not_run_on_cancel.md) — runs on cancel but ~5min window; push-with-retry inside starves later steps. Raise timeout-minutes; don't trust the cleanup chain
- [Silent workflow failures](feedback_silent_workflow_failures.md) — never || true on git push; use ::warning::
- [Silent git/merge failures](feedback_silent_git_add_failures.md) — git add 2>/dev/null || true may stage NOTHING; also JSON reformat drops additions ([[silent-merge-loss-on-reformat]])
- [Pipe masks exit code](feedback_pipe_masks_exit_code.md) — node x.js | tail hides node exit; use pipefail
- [Workflow YAML inline-commit smoke test](feedback_workflow_yaml_needs_manual_fire.md) — manual-fire surfaces missing git config user.name/email
- [GHA heredoc indentation](feedback_yaml_heredoc_indentation.md) — heredoc needs ≥10 spaces indent or breaks YAML
- [Workflow cascade prevention](feedback_workflow_cascade_prevention.md) — trace dispatch graph; circular chains → 1000+ runs/day
- [Test extraction pattern](feedback_test_extraction_pattern.md) — extract to scripts/lib/ and require(); never copy logic
- [Node test format, not Jest](feedback_test_format_node_not_jest.md) — .mjs with node:test API; register in test.yml
- [CI tsc gate scope](feedback_ci_tsc_gate_scope.md) — covers root tsc + llm-scoring tsconfig only
- [Hook stdin format](feedback_hook_stdin_format.md) — PostToolUse stdin under tool_input; jq .tool_input.command
- [Outlet registry dual repo](feedback_outlet_registry_dual_repo.md) — update outlet-registry.json in BOTH repos
- [Branch protection: direct pushes not gated](feedback_branch_protection_direct_push.md) — required status checks gate PR merges only; direct pushes land even when checks fail
- [actions/cache@v4 skips save on primary-key hit](feedback_actions_cache_no_save_on_hit.md) — cache mutations between runs silently lost; use `${{ github.run_id }}` in key + restore-keys fallback

## 🔌 External APIs
- [404 is not always terminal failure](feedback_404_not_terminal.md) — check prior state before flipping success→failure
- [Live-API contract test](feedback_live_api_contract_test.md) — call live API; unit tests miss empirical behavior
- [API JSON key whitespace](feedback_api_key_whitespace.md) — trailing-space keys silent-miss on lookup; normalize at load not at site
- [Refactor parity test on real data](feedback_refactor_parity_test.md) — old vs new predicate against real data; 0 diffs = safe
- [Verify bug claim before fixing](feedback_verify_bug_claim_before_fixing.md) — reproduce against live data before writing fix

## 🎯 Opening night pipeline
- [Joe Turner master log 2026-04-25/26](feedback_admin_ingest_opening_night_2026-04-26.md) — ~42 issues; read FIRST for next opening night
- [Manual ingest opening-night runbook](feedback_manual_ingest_opening_night_runbook.md) — 25-item failure-mode checklist
- [Aggregator pages post-opening only](feedback_aggregator_pages_post_opening.md) — BWW RR/DTLI/TB etc. don't exist pre-opening
- [SERP opening night timing](feedback_serp_opening_night_timing.md) — Google indexes major outlets 2.9h+ post-pub; 3h gate
- [shows.json category at scheduling](feedback_shows_json_category_at_schedule.md) — null category/market must fail validate-data.js
- [OB openingDate==previewsStartDate](feedback_off_broadway_opening_date_gap.md) — orchestrator fires on previews-start, misses press night
- [Opening night corrections](feedback_opening_night_corrections.md) — disable orchestrator first; humanReviewScore only override
- [Email broadcast rules](email-broadcast-rules.md) — hard rules post-March-2026; never direct broadcast API
- [Broadcast quality bar](feedback_broadcast_quality_bar.md) — ≥1 more review than BWW RR; send 7-9am next morning
- [Orchestrator pause ≠ broadcast pause](feedback_orchestrator_pause_does_not_pause_broadcast.md) — broadcast auto-fires on workflow_run; disable workflow
- [PROTECTED_FIELDS 3-way sync](feedback_protected_fields_three_way_sync.md) — write-guard + push action + restore must all carry overrides

## 🏆 Awards scoring
- [Awards enrichment ≠ scoring](feedback_awards_enrichment_scoring_decoupled.md) — must add CeremonyKey + POINTS entry + if block per ceremony
- [OBA Playbill SERP scraper](feedback_oba_scraper_playbill_serp_pattern.md) — no-Wikipedia awards: SERP+DOM parse, applyDDOCCDL not applyObie, trust JSON-LD date

## 🎭 Tony predictions model
- [Tony predictions accuracy](project_tony_predictions_accuracy.md) — recipe weights, 92.9% accuracy, current signals

## 📊 Data pipeline & scraping
- [Closing-date automation gaps](feedback_closing_date_audit_gaps.md) — 4 silent gaps; broadway.org/TodayTix lag; WE=0 automation
- [Scraper architecture](feedback_scraper_architecture.md) — must use fetchPage(); CI enforces BD+SB both present
- [fetchPage gotchas](feedback_fetchpage_gotchas.md) — BD empty 200s, Playwright renders 404s as success
- [BD zone migrated: web_unlocker2](feedback_brightdata_zone_migration.md) — mcp_unlocker obsolete; active zone via $BRIGHTDATA_ZONE
- [SB credit budget](feedback_sb_credit_budget.md) — SB_CREDIT_BUDGET=250, SB_PAGE_CREDIT_BUDGET=200
- [Cloudflare bypass hierarchy](feedback_cloudflare_bypass_hierarchy.md) — managed challenge defeats all; Browserbase only
- [WSJ/NY CI IP block](feedback_wsj_newyorker_ci_ip_block.md) — DataDome blocks GH Actions; Browserbase only
- [Aggregator soft 404](feedback_aggregator_soft_404.md) — BWW returns 200 homepage; check <title> tag
- [Stage cookie minimal set](feedback_stage_cookie_minimal_set.md) — 5 cookies; cookie-only auth
- [Mac Studio cookies](feedback_mac_studio_cookies.md) — Tahoe path changed; Terminal needs FDA; 11 secrets
- [Audience scrapers share normalize](feedback_audience_scrapers_share_normalize.md) — import normalizeTitle from title-match.js
- [Commit audience-buzz before CI rebuild](feedback_audience_buzz_commit_before_rebuild.md) — commit to private repo first; CI reads remote HEAD
- [Table scrapers need structural assertions](feedback_scraper_table_assertions.md) — hardcoded cells[N] breaks on column changes
- [Object-literal duplicate keys](feedback_object_literal_duplicate_keys.md) — grep before adding; duplicate key silently nukes existing
- [Orphan cast invisible by design](feedback_orphan_cast_invisible_by_design.md) — rows without ibdbPersonId are skipped at manifest build; don't surface without first cleaning contamination

## 🧮 Scoring & review guards
- [\b regex fails for trailing-punct titles](feedback_word_boundary_punct_titles.md) — Schmigadoon! etc.; use non-alphanumeric lookaround
- [Apostrophe in names breaks \b regex](feedback_apostrophe_name_matching.md) — normalize text+name before matching
- [Orphan utility scripts](feedback_orphan_utility_scripts.md) — grep scripts/ for existing solutions first
- [Scoring-logic delta required](feedback_scoring_delta_required.md) — run scoring-delta.js + temporal fixture; Stop hook enforces
- ["Must match X" comment IS the bug](feedback_must_match_comment_is_a_bug.md) — eliminate the duplicate, don't preserve the comment
- [Includability predicates must be canonical](feedback_includability_predicates_must_be_canonical.md) — call isIncludableForRebuild from review-guards.js
- [Manual-clear covers all rejection types](feedback_manual_clear_covers_all_rejection_types.md) — wrongProduction carve-out MUST extend to wrongShow
- [Star score cap rule](feedback_star_score_cap.md) — 5/5=100 is ground truth; never cap with LLM
- [Reviews.json dual repo push](feedback_reviews_json_dual_repo_push.md) — flag + rebuild + push data repo + redeploy
- [Review recovery pipeline gaps](feedback_review_recovery_pipeline_gaps.md) — run verify-review-recovery.js; 5 steps fail independently
- [Protected fields on every write](feedback_protected_fields_every_write.md) — check humanReviewedWrongProduction/humanReviewScore
- [Manual review protection fields](feedback_manual_review_protection_fields.md) — need ALL 8 protection fields or guards re-flag
- [Pseudonymous bylines ≠ multi-author](feedback_pseudonymous_bylines.md) — JK/initials/pen names with scraper-invented name drift
- [URL-date guards need criticName gate](feedback_url_date_guards_critic_gate.md) — gate on Unknown byline
- [Curated historical 4-review threshold](feedback_curated_historical_4review_threshold.md) — isCuratedHistorical → 4-review min when ≥1 T1/T2
- [Bare X/Y regex FPs](feedback_regex_url_fragment_fps.md) — anchor + URL filter required
- [Content-quality regex bare-keyword FPs](feedback_content_quality_regex_fps.md) — audit patterns against real corpus before edit
- [JS array > 0 is always false](feedback_js_array_gt_comparison.md) — use Array.isArray(x) + .length > 0
- [Same-title disambiguation](feedback_same_title_disambiguation.md) — extend classifyMarketRouting; ≥2-signal cascade
- [UK ceremonies strict-season gate](feedback_uk_ceremonies_strict_season.md) — new UK ceremony MUST be in UK_CEREMONIES set or fallback routes WE wins to BW
- [Cast closure is its own event type](feedback_cast_changes_closure_type.md) — show closures must be `closure` events, not N per-actor `departure`
- [duplicateOf URL-mismatch = stale flag](feedback_duplicate_of_url_mismatch.md) — A.duplicateOf=B w/o matching URLs is a bug; CI gate + self-heal in review-write-guard
- [Orphan slim show files](feedback_orphan_slim_show_files.md) — public/data/shows/{id}.json must match a shows.json id; CI gate audits and --fix deletes

## 🤖 LLM / evals
- [LLM prompts must be market/type-aware](feedback_llm_prompts_market_aware.md) — inject opera-prompt-context.js for opera/special shows
- [Eval patterns](feedback_eval_patterns.md) — lib layout, 3-point validator, real-iteration loop, golden fixtures
- [LLM wrongprod false positives](feedback_llm_wrongprod_false_positives.md) — ~15% FP; temporal override is safety net
- [LLM verifier hallucinates](feedback_llm_verifier_hallucinates.md) — Gemini isValid:true at 48% on garbage; post-check
- [Opus for classification](feedback_opus_for_classification.md) — Sonnet 75% FN on review vs commentary; use Opus
- [Editorial drift guard](feedback_editorial_drift.md) — drift guard discards LLM content on show count change

## 🎨 UI / design system
- [Mobile link min-height + row exceptions](feedback_mobile_link_min_height.md) — a{min-height:44px}; .performer-row/.craft-row opt out; e2e-guarded
- [Design system reference](design-system.md) — surfaces, score tiers, shared components, banned patterns
- [Visual verify before push](feedback_visual_verify_before_push.md) — screenshot before commit; tsc ≠ visual
- [Visual QA: 3 viewports required](feedback_playwright_1440px_required.md) — 390×844 + 768×1024 + 1440×900; tablet was the silent gap
- [Tailwind JIT — restart after new arbitrary classes](feedback_tailwind_jit_arbitrary_restart.md) — `min-w-[760px]` etc. compute as 0px until dev-server restart
- [Preserve parallel-session colors](feedback_preserve_parallel_session_colors.md) — keep colors from parallel sessions, not CD palette
- [Round once, share everywhere](feedback_round_once_share_everywhere.md) — centralize in isCriticalGold()
- [Map iterator spread broken](feedback_map_iterator_spread.md) — use Array.from(); tsconfig es5 breaks spread
- [Demo flags client-only](feedback_demo_flags_client_only.md) — isDemo()/window checks in 'use client' only
- [React.lazy() for App Router split](feedback_react_lazy_for_app_router_split.md) — next/dynamic from server = no-op; use 'use client' Loader + React.lazy + Suspense
- [A/B tests](feedback_ab_test_guardrails.md) — PostHog filters/exclusions/stat-sig thresholds

## 💼 Commercial / features / video
- [Commercial slug keys](feedback_commercial_slug_keys.md) — commercial.json keyed by slug not ID
- [Feature launch sequence](project_feature_launch_sequence.md) — Lottery/Rush → Awards/Tony → Commercial
- [VideoScore](project_videoscore_feature.md) — video critic reviews via transcript sentiment
- [Recoupment RSS poller architecture](feedback_recoupment_rss_poller_architecture.md) — hourly Variety+Deadline poll; shared classify lib; trackRecoupment flag
- [Enhancement-deal designation policy](feedback_enhancement_deal_designation_policy.md) — Easy Winner/Flop requires HARD trade-press citation; default to Nonprofit+null. Indirect signals (early closing, soft grosses) NOT sufficient. Applied 2026-05-24.

## 📚 Reference & repo layout
- [Repo layout](repo_layout.md) — three repos (web, iOS, data) with GitHub names and paths
- [Claude config sync](reference_claude_config_sync.md) — ~/.claude is private GitHub repo; use claude-sync
- [Theatre Record reference](reference_theatre_record.md) — paid UK review archive

## 🗄️ Archive
Use `archived: true` frontmatter to retire entries — skipped by `rebuild-memory-index.js`, kept on-disk. See [[memory-archive-in-place]] for the pattern.
