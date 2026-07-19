## Memory Index

> Caps: 180 lines/20KB (hook-enforced; harness truncates ~200). Always-on index only — 450+ files on disk are recalled on demand. **At cap: add ⇒ remove/merge one.** Last compacted 2026-07-05.

## 🌐 External APIs & services
- [Vercel API + billing](reference_vercel_billing_api.md) — VERCEL_TOKEN in .env; /v1/invoices[/upcoming]; deploy freq = cost lever ([[feedback_vercel_api_access.md]])
- [Analytics Real Users lens](feedback_analytics_real_users_lens.md) — GA4 bot-inflated; PostHog (proj 332742) is_owner + SG/CN/VN excluded; newsletter email has no UTM ([[feedback_newsletter_no_utm.md]])
- [Google Search Console API](feedback_gsc_api_auth.md) — gcloud ADC + webmasters scope; X-Goog-User-Project header required

## 👤 User profile & session discipline
- [Cmux close rules](feedback_never_close_unmarked_cmux_workspaces.md) — ✅-only via bsc-prune; --help executes
- [Terse output default](feedback_terse_output_default.md) — no recap, cut narration, keep proof; estimate in Claude-pace minutes ([[feedback_no_human_day_estimates.md]])
- [User non-technical](feedback_no_review_offers_user_not_technical.md) — never offer "review the diff"; laptop+phone, infer from message style ([[feedback_user_device_context.md]])
- [Absorb gate ceremony](feedback_absorb_gate_ceremony.md) — run hooks/visual-qa/approvals myself, report outcomes not process; Stop hook blocks "done", bypass NO-VERIFY: ([[feedback_verification_gate_hook.md]])
- [Always wait for async](feedback_always_wait_async.md) — never end turn while deploy/rebuild runs; flag-gated features verify on demo URL ([[feedback_flag_gated_verify_on_demo.md]])
- [Probe before scale backfills](feedback_investigate_premise_before_scaling.md) — 5-20 file probe first; save findings to memory ([[feedback_save_research_findings.md]])
- [/ship-check catches real P1s](feedback_ship_check_finds_real_bugs.md) — never skip; enforced for scripts/lib/ + workflows
- [Systematic fix: threat model + parity test](feedback_systematic_fix_threat_model_first.md) — check trigger frequency; parity-test bad URLs
- [Review rituals](feedback_sprint_plan_needs_review.md) — /plan-review before multi-sprint plans; GPT-4o+Gemini parallel on screenshots ([[feedback_two_model_ui_review.md]], [[feedback_three_model_audit_modality.md]])
- [Test pure function at I/O boundary](feedback_test_pure_function_at_io_boundary.md) — also test wrapper against real data
- [Show status before external comms](feedback_check_show_status_before_external_comms.md) — surface status/closingDate with show drafts; OB closings lag
- [Anti-AI-slop writing](feedback_anti_ai_slop_writing.md) — strip em dashes, "not X it's Y", hedges, fake comparisons in external copy ([[feedback_email_drafting.md]])
- [GitHub polling rate limit](feedback_github_polling_rate_limit.md) — no gh polling loops; NEVER gh run watch, use scripts/lib/wait-for-run.sh

## 📇 Notion / brain
- [Notion brain workflow](notion-brain-workflow.md) — IDs, schema, lifecycle; CLI only, never MCP ([[feedback_notion_cli_only.md]])
- [Notion cards need context](feedback_notion_card_context.md) — paths, commands, root cause, repro; on create read FULL output, never pipe to grep, avoid "rejected" word ([[feedback_notion_create_verify.md]], [[feedback_notion_create_hook_false_rejection.md]])

## 🌳 Worktrees & git
- [Worktrees mandatory for code edits](feedback_worktree_code_changes.md) — src/, scripts/, .github/, CLAUDE.md; launch bg watchers from MAIN repo cwd ([[feedback_background_watchers_worktree_cwd.md]])
- [Parallel worktree sessions race](feedback_parallel_worktree_race.md) — re-pull + grep scripts/lib/ BEFORE writing; plan "parallel" = subagents; same-name worktree may be another session's LIVE one, `git worktree list` first ([[feedback_enterworktree_name_collision_live_session.md]])
- [Dual repo data files](feedback_dual_repo_data_files.md) — private repo authoritative, fix BOTH; review-texts NOT a symlink ([[feedback_review_texts_not_symlink.md]]); NEVER rebuild-all-reviews.js locally ([[feedback_local_rebuild_stale_clone_hazard.md]])
- [Stray symlink crashes pipeline](feedback_stray_symlink_crashes_pipeline.md) — committed abs-path symlink dangles in CI; use listShowDirs()
- [audit-review-contamination strict CI gate](feedback_audit_contamination_strict_mode.md) — strict A/B/C fail CI; B = false-pos wrongProduction
- [Commit data repo edits IMMEDIATELY](feedback_data_repos_clobber_uncommitted.md) — pull --rebase clobbers uncommitted; never reset-hard+rsync ([[feedback_reset_rsync_wipes_ci_fields.md]]); gh api PUT /contents/ when local git broken ([[feedback_gh_api_emergency_commit.md]])

## ⚙️ CI / GitHub Actions / workflows
- [Workflow cascade prevention](feedback_workflow_cascade_prevention.md) — trace dispatch graph; circular chains → 1000+ runs/day
- [Cron timeout = script budget](feedback_cron_timeout_needs_script_budget.md) — cancelled-at-timeout crons need --time-budget-min + rotation; check skip-cache checkout wiring
- [test.yml gotchas](feedback_test_yml_push_path_allowlist.md) — push path allow-list (non-listed scripts/ = ZERO CI); data gates flap, first failure masks rest; two disjoint unit batches; verify new test RAN ([[feedback_ci_step_short_circuits_colocated_tests.md]])
- [push-review-texts reverts intentional clears](feedback_push_review_texts_reverts_intentional_clears.md) — duplicateOf in PROTECTED_FIELDS; needs duplicateClearReason exception
- [Vercel build config](feedback_vercel_env_block_required.md) — NEXT_PUBLIC_* must go in build step env: block; no dynamic paths in server code, grep src/ before outputFileTracingExcludes ([[feedback_vercel_nft_dynamic_paths.md]])
- [Conservative default = common case](feedback_conservative_default_can_be_common_case.md) — "unknown → assume X" breaks when unknown IS common
- [GHA cron reliability](feedback_github_cron_delays.md) — fire 30min-3h late, shift earlier + launchd backup; ~60d inactive → silently disabled HTTP 422 ([[feedback_github_auto_disable_workflows.md]])
- [GHA step gotchas](feedback_gha_secrets_in_if.md) — secrets unusable in step if:; `if: always()` ~5min on cancel ([[feedback_if_always_does_not_run_on_cancel.md]]); cache@v4 no save on key hit ([[feedback_actions_cache_no_save_on_hit.md]])
- [Silent workflow failures](feedback_silent_workflow_failures.md) — never || true on git push; git add ||true may stage NOTHING ([[feedback_silent_git_add_failures.md]]); pipefail or pipe masks exit ([[feedback_pipe_masks_exit_code.md]])
- [Test extraction pattern](feedback_test_extraction_pattern.md) — extract to scripts/lib/ + require(); .mjs node:test, register in test.yml ([[feedback_test_format_node_not_jest.md]])
- [Branch protection: direct pushes not gated](feedback_branch_protection_direct_push.md) — required checks gate PR merges only; direct pushes land red
- [Hook stdin format](feedback_hook_stdin_format.md) — PostToolUse stdin under tool_input; PreToolUse has no model field
- [Compound shell/git traps](feedback_compound_shell_git_traps.md) — zsh vars don't word-split; never `stash pop` after conditional push (pops another session's stash); `git push` standalone ([[feedback_prepush_gate_stash_push_parser.md]])

## 🔌 External APIs & verification
- [Live-API contract test](feedback_live_api_contract_test.md) — call live API, unit tests miss empirical behavior; verify bug claim before fixing ([[feedback_verify_bug_claim_before_fixing.md]], [[feedback_404_not_terminal.md]]); normalize JSON keys at load ([[feedback_api_key_whitespace.md]])
- [Resend preview ≠ delivered email](feedback_resend_preview_masks_delivered_rendering.md) — preview hides webp/dark-mode; verify in real client (owner Gmail iOS)
- [Refactor parity test on real data](feedback_refactor_parity_test.md) — old vs new predicate; 0 diffs = safe
- [Paywalled star outlets not gaps](feedback_paywalled_star_outlets_not_gaps.md) — Stage stubs scored via aggregatorStars-fallback; gap-scans exclude _pending/
- [CI E2E runs vs production](feedback_e2e_runs_against_production.md) — UI fix stays red until deploy lands; push-triggered run is deploy-lag false-neg; rerun after deploy
- [Prod curl trips Vercel checkpoint](feedback_prod_curl_vercel_checkpoint.md) — verify via public JSONs / check-prod-deploy.js, not curl loops
- [Fixture E2E specs: dual registration](feedback_fixture_e2e_specs_dual_registration.md) — /test/* specs go in BOTH playwright testIgnore AND test-ugc.yml run list

## 📋 Open work
- [Sprint plans must be durable](feedback_sprint_plans_must_be_durable.md) — cards must point at claude-outputs/repo paths, session scratchpad dies; reconstruct from plan-card Outcome + prior merge commit
- [Autonomous loop schedule](autonomous-loop-schedule.md) — nightly slot 07:30 UTC, email 7:30am ET; full 157-cron map; DST fallback + Sunday worktree-gc caveats
- [OB venue historical backfill](project_ob_venue_historical_backfill.md) — Atlantic/Vineyard/MCC archive pages; Tier A deferred TFANA+2ndStage ([[project_ob_tier_a_deferred.md]])
- [Manual stubs bypass venue/date validation](feedback_manual_stub_bypasses_validation.md) — NEVER stub shows.json from memory; look up Playbill first
- [Regional auto-promotion](project_regional_expansion_watchlist.md) — roundup=go-live; auto add+reviews+images; transferOf/transferredTo cross-link tryout↔Broadway; cast/audience manual

## 🎯 Opening night pipeline
- [WE completeness gate](project_we_completeness_gate.md) — hourly audit diffs WE shows vs WET/TR/LBO, emails missing outlets; ingest default-OFF (WE_GAP_INGEST=1); sendAlert w/o email:true is LOG-ONLY
- [_pending no-byline strand](feedback_pending_no_byline_strand_drain.md) — multi-critic outlets w/o byline strand in _pending/; CHECK _pending FIRST when reviews missing; drain rejects KEEP-not-delete
- [Date-gated flips](feedback_previews_open_flip_needs_review_signal.md) — stuck previews suppresses score, 2d review-driven backstop; OB openingDate==previewsStartDate misses press night ([[feedback_off_broadway_opening_date_gap.md]])
- [Opening-night runbooks](feedback_admin_ingest_opening_night_2026-04-26.md) — Joe Turner master log (~42 issues, read FIRST) + 25-item failure-mode checklist ([[feedback_manual_ingest_opening_night_runbook.md]])
- [SERP opening night timing](feedback_serp_opening_night_timing.md) — Google indexes major outlets 2.9h+ post-pub; 3h gate
- [shows.json category at scheduling](feedback_shows_json_category_at_schedule.md) — null category/market must fail validate-data.js
- [Opening night corrections](feedback_opening_night_corrections.md) — disable orchestrator first; humanReviewScore only override
- [Email rules](email-broadcast-rules.md) — no direct broadcast API; quality bar + 7-9am ([[feedback_broadcast_quality_bar.md]]); pause = disable workflow ([[feedback_orchestrator_pause_does_not_pause_broadcast.md]]); alerts = ACTION only, warning/info no email ([[feedback_actionable_only_email_alerts.md]])
- [PROTECTED_FIELDS 3-way sync](feedback_protected_fields_three_way_sync.md) — write-guard + push action + restore must all carry overrides

## 🏆 Awards & Tony
- [Awards enrichment ≠ scoring](feedback_awards_enrichment_scoring_decoupled.md) — add CeremonyKey + POINTS entry + if block per ceremony
- [Awards scraper patterns](feedback_oba_scraper_playbill_serp_pattern.md) — no-Wikipedia: SERP+DOM parse, trust JSON-LD date; tie co-winners dropped at scrape, split ' and ' between quote-runs ([[feedback_awards_tie_cowinners_dropped_at_scrape.md]])
- [Tony predictions](project_tony_predictions_accuracy.md) — recipe weights, 93% accuracy; FREEZE audience grades for closed seasons ([[feedback_freeze_tony_audience_grades.md]])

## 📊 Data pipeline & scraping
- [Scraper architecture](feedback_scraper_architecture.md) — use fetchPage(); BD empty 200s, Playwright 404s as success ([[feedback_fetchpage_gotchas.md]]); BWW soft-404 returns 200 homepage, check <title> ([[feedback_aggregator_soft_404.md]])
- [SB SERP burns invisibly](feedback_sb_serp_invisible_burn.md) — _serpViaScrapingBee logs nothing; preferSpeed+SD-empty fallthrough = 60-100K cr/day; audit via usage-counter sampling. BD zone web_unlocker2 ([[feedback_brightdata_zone_migration.md]], [[feedback_sb_credit_budget.md]])
- [Closing-date automation gaps](feedback_closing_date_audit_gaps.md) — 4 silent gaps; broadway.org/TodayTix lag; WE=0 automation
- [WET venue-page wrong-show ingestion](feedback_wet_venue_page_wrong_show_ingestion.md) — same-venue predecessor show's reviews attach via venue corroboration; check rv URL slugs; flag needs wrongShowReason + delete WET cache
- [In-place URL update preserves stale state](feedback_inplace_url_update_preserves_stale_state.md) — real reviews merged into flagged slots stay suppressed; check file's CURRENT url before assuming discovery failed; run isScoreable() directly for hidden blockers
- [SEO site-avg position brand-skewed](feedback_seo_site_avg_position_is_brand_skewed.md) — never cite GSC avg as ranking quality; use de-branded review-intent
- [Cloudflare/DataDome blocks](feedback_cloudflare_bypass_hierarchy.md) — managed challenge + WSJ/NewYorker CI IP block defeat all; Browserbase only ([[feedback_wsj_newyorker_ci_ip_block.md]])
- [Cookie auth](feedback_stage_cookie_minimal_set.md) — Stage = 5 cookies, cookie-only; Mac Studio Terminal needs FDA ([[feedback_mac_studio_cookies.md]]); health = body-length not expiry, re-login needs user ([[feedback_cookie_health_body_length_not_expiry.md]])
- [Audience scrapers share normalize](feedback_audience_scrapers_share_normalize.md) — import normalizeTitle from title-match.js; commit audience-buzz before CI rebuild ([[feedback_audience_buzz_commit_before_rebuild.md]])
- [Table scrapers need structural assertions](feedback_scraper_table_assertions.md) — hardcoded cells[N] breaks on column changes
- [Orphan cast invisible by design](feedback_orphan_cast_invisible_by_design.md) — rows w/o ibdbPersonId skipped at manifest build; clean contamination first

## 🧮 Scoring & review guards
- [Scoring-logic delta required](feedback_scoring_delta_required.md) — run scoring-delta.js + temporal fixture; Stop hook enforces
- [Includability predicates must be canonical](feedback_includability_predicates_must_be_canonical.md) — call isIncludableForRebuild; "must match X" comment IS the bug ([[feedback_must_match_comment_is_a_bug.md]])
- [\b regex fails on punct/apostrophe names](feedback_word_boundary_punct_titles.md) — Schmigadoon!, O'Hara; normalize text+name, non-alphanumeric lookaround ([[feedback_apostrophe_name_matching.md]])
- [Manual review protection fields](feedback_manual_review_protection_fields.md) — need ALL 8 fields or guards re-flag; carve-out extends to wrongShow ([[feedback_manual_clear_covers_all_rejection_types.md]], [[feedback_protected_fields_every_write.md]])
- [Anchored-v6 leaks](feedback_anchored_v6_stamp_and_rescore_starvation.md) — numeric relay ≠ star; llmScore.band = anchored proof; drain rescore queue ([[feedback_star_score_cap.md]])
- [Reviews.json dual repo push](feedback_reviews_json_dual_repo_push.md) — flag + rebuild + push data repo
- [Returning production → priorRuns](feedback_returning_production_priorRuns.md) — WE return/transfer shows few reviews b/c majors reviewed earlier run; declare priorRuns {openingDate/closingDate/venue} to re-include ([[feedback_stale_flag_collision_drops_current_production.md]])
- [Review recovery pipeline gaps](feedback_review_recovery_pipeline_gaps.md) — run verify-review-recovery.js; 5 steps fail independently
- [Pseudonymous bylines ≠ multi-author](feedback_pseudonymous_bylines.md) — pen names w/ scraper-invented drift; URL-date guards gate on Unknown byline ([[feedback_url_date_guards_critic_gate.md]])
- [Curated historical 4-review threshold](feedback_curated_historical_4review_threshold.md) — isCuratedHistorical → 4-review min when ≥1 T1/T2
- [Regex bare-keyword/fragment FPs](feedback_content_quality_regex_fps.md) — audit patterns against real corpus before edit; anchor + URL filter ([[feedback_regex_url_fragment_fps.md]])
- [Market/season routing](feedback_same_title_disambiguation.md) — extend classifyMarketRouting, ≥2-signal cascade; new UK ceremony MUST be in UK_CEREMONIES or fallback routes WE→BW ([[feedback_uk_ceremonies_strict_season.md]])
- [Stale-flag CI gates](feedback_duplicate_of_url_mismatch.md) — duplicateOf w/o matching URLs = bug, CI gate + self-heal; orphan slim show files gate --fix deletes ([[feedback_orphan_slim_show_files.md]])
- [Outlet merges: no flag-and-keep tombstones](feedback_outlet_merge_no_flag_and_keep.md) — rebuild folds flagged loser into live winner (flags+URL) then cascade-deletes; DELETE worthless losers instead
- [Self-referential duplicate pointers](feedback_self_referential_duplicate_pointers.md) — rename-onto-pointer-target makes file a dupe of itself, silently dropped; check duplicateTextOf too; drift actual>expected = rebuild will drop
- [In-sample accuracy needs LOSO](feedback_in_sample_accuracy_claims_need_loso.md) — never publish in-sample backtest % as "Accuracy"

## 🤖 LLM / evals
- [LLM prompts must be market/type-aware](feedback_llm_prompts_market_aware.md) — inject opera-prompt-context.js for opera/special shows
- [Eval patterns](feedback_eval_patterns.md) — lib layout, 3-point validator, real-iteration loop, golden fixtures
- [LLM verifier hallucinates](feedback_llm_verifier_hallucinates.md) — Gemini isValid:true at 48% on garbage, use Opus for classification ([[feedback_opus_for_classification.md]]); wrongprod ~15% FP, temporal override is safety net ([[feedback_llm_wrongprod_false_positives.md]])
- [Editorial drift guard](feedback_editorial_drift.md) — discards LLM content on show count change

## 🎨 UI / design system
- [Design system reference](design-system.md) — surfaces, score tiers, shared components, banned patterns
- [Local preview before push](feedback_local_preview_before_push.md) — /visual-qa local, APPROVED:<hash> required; worktree gotchas ([[feedback_visual_qa_dev_server_in_worktree.md]]); preserve parallel colors ([[feedback_preserve_parallel_session_colors.md]])
- [Mobile link min-height](feedback_mobile_link_min_height.md) — a{min-height:44px}; .performer-row/.craft-row opt out; e2e-guarded
- [App Router rendering](feedback_react_lazy_for_app_router_split.md) — next/dynamic from server = no-op, use 'use client' Loader + Suspense; above-fold renders in page.tsx BEFORE HomePageClient; demo flags client-only ([[feedback_demo_flags_client_only.md]])
- [A/B tests](feedback_ab_test_guardrails.md) — PostHog filters/exclusions/stat-sig thresholds
- [Modal + Next-chunk singletons](feedback_css_contain_traps_fixed_modals.md) — Modal portals to body; module singletons split across chunks → coordinate via DOM
- [UGC Supabase auth](feedback_supabase_freetier_pause.md) — free-tier pauses 7d idle → NXDOMAIN; Restore workflow + keep-alive. Tests [[feedback_ugc_test_patterns.md]] [[feedback_playwright_evaluate_click_hydration.md]]

## 💼 Commercial / features
- [Commercial slug keys](feedback_commercial_slug_keys.md) — commercial.json keyed by slug not ID
- [Feature launch sequence](project_feature_launch_sequence.md) — Lottery/Rush → Awards/Tony → Commercial; VideoScore via transcript sentiment ([[project_videoscore_feature.md]])
- [Recoupment RSS poller](feedback_recoupment_rss_poller_architecture.md) — hourly Variety+Deadline; shared classify lib; trackRecoupment flag

## 📚 Reference & repo layout
- [Repo layout](repo_layout.md) — three repos (web, iOS, data) w/ GitHub names + paths; ~/.claude is private repo via claude-sync ([[reference_claude_config_sync.md]])
- [Theatre Record reference](reference_theatre_record.md) — paid UK review archive
