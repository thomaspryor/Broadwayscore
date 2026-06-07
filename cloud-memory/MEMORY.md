## Memory Index

> Caps (write-time enforced by memory-index-cap-guard.sh): 180 lines, 20KB. Harness hard-truncates at ~200 lines, so over-cap silently drops bottom entries. Only cross-cutting always-on rules belong here; 450+ memory files live on disk and are recalled on demand. **At cap, add ⇒ remove/merge one.**

## 🌐 External APIs & services
- [Vercel API access](feedback_vercel_api_access.md) — VERCEL_TOKEN in .env; prj_wmBnDUrCQCwabIAYPbnMiIP3wg15
- [Analytics Real Users lens](feedback_analytics_real_users_lens.md) — GA4 bot-inflated; use PostHog (proj 332742) is_owner + SG/CN/VN excluded; Vercel has no query API
- [Newsletter has no UTM](feedback_newsletter_no_utm.md) — email traffic untrackable; General list ~328; add UTMs
- [Google Search Console API](feedback_gsc_api_auth.md) — gcloud ADC + webmasters scope; X-Goog-User-Project header required

## 👤 User profile & session discipline
- [Terse output default](feedback_terse_output_default.md) — no recap, cut narration, keep proof
- [No premature handoff](feedback_no_premature_handoff.md) — never offer handoff; next steps are actions ([[feedback_next_steps_actionable.md]]): if you CAN do it, DO it now
- [No diff-review offers](feedback_no_review_offers_user_not_technical.md) — user non-technical; never offer "review the diff"
- [Absorb gate ceremony](feedback_absorb_gate_ceremony.md) — run hooks/visual-qa/approvals myself; report outcomes not process
- [No human-day estimates](feedback_no_human_day_estimates.md) — estimate in Claude-pace minutes, not "half a day"
- [User device context](feedback_user_device_context.md) — laptop+phone; infer from message style
- [Always wait for async](feedback_always_wait_async.md) — never end turn while deploy/rebuild runs
- [Flag-gated: verify on demo](feedback_flag_gated_verify_on_demo.md) — prod deploy ≠ user-visible; verify demo URL
- [Competition rank for leaderboards](feedback_competition_rank_for_leaderboards.md) — competition rank (1,1,3) not dense
- [Verification gate hook](feedback_verification_gate_hook.md) — Stop hook blocks "done"; bypass: NO-VERIFY:
- [Probe before scale backfills](feedback_investigate_premise_before_scaling.md) — 5-20 file probe before assuming scale; save findings to memory ([[feedback_save_research_findings.md]])
- [/ship-check catches real P1s](feedback_ship_check_finds_real_bugs.md) — never skip; enforced for scripts/lib/ + workflows
- [Systematic fix: threat model + parity test](feedback_systematic_fix_threat_model_first.md) — check trigger frequency; parity-test bad URLs
- [Sprint plans need /plan-review](feedback_sprint_plan_needs_review.md) — always before multi-sprint plans
- [Test pure function at I/O boundary](feedback_test_pure_function_at_io_boundary.md) — also test wrapper against real data
- [Anti-AI-slop writing](feedback_anti_ai_slop_writing.md) — strip em dashes, "not X it's Y", "delve/robust", hedges, fake comparisons in external copy ([[feedback_email_drafting.md]])
- [Ask with recommendation](feedback_ask_with_recommendation.md) — lead with (Recommended) option 1 + why
- [Multi-model review](feedback_two_model_ui_review.md) — GPT-4o+Gemini parallel on screenshots; pair vision w/ code-reader subagent for data audits ([[feedback_three_model_audit_modality.md]]); Gemini thinkingBudget=0 ([[feedback_gemini_thinking_token_budget.md]])
- [GitHub polling rate limit](feedback_github_polling_rate_limit.md) — never gh run list in loop; use gh run watch

## 📇 Notion / brain
- [Notion brain workflow](notion-brain-workflow.md) — IDs, schema, lifecycle. Read first.
- [Notion CLI only, never MCP](feedback_notion_cli_only.md) — use node scripts/notion-brain.js
- [Notion cards need context](feedback_notion_card_context.md) — paths, commands, root cause, acceptance; bug cards need repro ([[feedback_notion_card_reproduction.md]])
- [Notion create: read full output](feedback_notion_create_verify.md) — never pipe to grep; avoid "rejected" word ([[feedback_notion_create_hook_false_rejection.md]])
- [Roadmap lives in Notion](project_roadmap_notion.md) — not GitHub issues

## 🌳 Worktrees & git
- [Worktrees mandatory for code edits](feedback_worktree_code_changes.md) — src/, scripts/, .github/, CLAUDE.md; prefix paths .claude/worktrees/ ([[feedback_worktree_edit_paths.md]])
- [Parallel worktree sessions race](feedback_parallel_worktree_race.md) — re-pull + grep scripts/lib/ BEFORE writing
- [Plan "parallel" = subagents](feedback_plan_parallel_means_subagents.md) — not multiple Claude sessions
- [Dual repo data files](feedback_dual_repo_data_files.md) — shows.json/reviews.json + awards.json + outlet-registry authoritative in private repo; fix BOTH ([[feedback_awards_json_dual_repo.md]], [[feedback_outlet_registry_dual_repo.md]])
- [data/review-texts NOT a symlink](feedback_review_texts_not_symlink.md) — edit ~/broadway-review-texts/ directly
- [Stray symlink crashes pipeline](feedback_stray_symlink_crashes_pipeline.md) — committed abs-path symlink dangles in CI; use listShowDirs()
- [audit-review-contamination strict CI gate](feedback_audit_contamination_strict_mode.md) — strict A/B/C fail CI; B = false-pos wrongProduction
- [Commit data repo edits IMMEDIATELY](feedback_data_repos_clobber_uncommitted.md) — pull --rebase clobbers uncommitted; never reset-hard+rsync ([[feedback_reset_rsync_wipes_ci_fields.md]])
- [gh api emergency commit](feedback_gh_api_emergency_commit.md) — gh api PUT /contents/ when local git broken

## 🎭 UGC / user features
- [UGC test failure patterns](feedback_ugc_test_patterns.md) — Sanity env, mock dates, overflow, ratings, visuals, 404s
- [page.evaluate .click() races hydration](feedback_playwright_evaluate_click_hydration.md) — use page.getByRole().click() for actionability

## ⚙️ CI / GitHub Actions / workflows
- [Workflow cascade prevention](feedback_workflow_cascade_prevention.md) — trace dispatch graph; circular chains → 1000+ runs/day
- [test.yml push path allow-list](feedback_test_yml_push_path_allowlist.md) — non-listed scripts/ pushes trigger ZERO CI; add new paths
- [push-review-texts reverts intentional clears](feedback_push_review_texts_reverts_intentional_clears.md) — duplicateOf in PROTECTED_FIELDS; needs duplicateClearReason exception
- [test.yml data gates flap + short-circuit](feedback_test_yml_data_gates_flap_and_shortcircuit.md) — corpus drift trips gates; first failure masks rest; triage drift-bump vs real-fix; classify fail-vs-cancelled ([[feedback_ci_red_stale_state_and_brittle_assertions.md]])
- [vercel build env block required](feedback_vercel_env_block_required.md) — NEXT_PUBLIC_* must go in build step env: block
- [Vercel NFT dynamic paths + excludes](feedback_vercel_nft_dynamic_paths.md) — no dynamic paths in server code; grep src/ before outputFileTracingExcludes; CI guard enforces
- [Conservative default = common case](feedback_conservative_default_can_be_common_case.md) — "unknown → assume X" breaks when unknown IS common
- [Cancelled main CI = concurrency](feedback_test_yml_cancel_in_progress.md) — cancelled+jsdom/shows.json ≠ real fail; cancel PRs only
- [GitHub auto-disables stale workflows](feedback_github_auto_disable_workflows.md) — ~60 days inactive → silently disabled; HTTP 422
- [GHA secrets not usable in if:](feedback_gha_secrets_in_if.md) — step-level if conditions can't read secrets
- [GHA cron delays](feedback_github_cron_delays.md) — fire 30min-3h late; shift earlier + launchd backup
- [`if: always()` cleanup budget](feedback_if_always_does_not_run_on_cancel.md) — ~5min window on cancel; raise timeout-minutes; don't trust cleanup chain
- [Silent workflow failures](feedback_silent_workflow_failures.md) — never || true on git push; use ::warning::; git add ||true may stage NOTHING ([[feedback_silent_git_add_failures.md]]); pipefail or pipe masks exit ([[feedback_pipe_masks_exit_code.md]])
- [CI step short-circuits colocated tests](feedback_ci_step_short_circuits_colocated_tests.md) — red batch skips later *.test.mjs; verify a new test actually RAN
- [test.yml has TWO unit-test batches](feedback_test_yml_two_unit_test_batches.md) — no-data node --test ≠ E2E-job tsx --test (disjoint); topology guards in tsx batch only
- [Test extraction pattern](feedback_test_extraction_pattern.md) — extract to scripts/lib/ + require(); .mjs node:test, register in test.yml ([[feedback_test_format_node_not_jest.md]])
- [Branch protection: direct pushes not gated](feedback_branch_protection_direct_push.md) — required checks gate PR merges only; direct pushes land red
- [actions/cache@v4 skips save on key hit](feedback_actions_cache_no_save_on_hit.md) — use github.run_id in key + restore-keys fallback
- [Hook stdin format](feedback_hook_stdin_format.md) — PostToolUse stdin under tool_input; jq .tool_input.command

## 🔌 External APIs & verification
- [404 is not always terminal](feedback_404_not_terminal.md) — check prior state before flipping success→failure
- [Live-API contract test](feedback_live_api_contract_test.md) — call live API; unit tests miss empirical behavior; verify bug claim before fixing ([[feedback_verify_bug_claim_before_fixing.md]])
- [API JSON key whitespace](feedback_api_key_whitespace.md) — trailing-space keys silent-miss; normalize at load
- [Refactor parity test on real data](feedback_refactor_parity_test.md) — old vs new predicate; 0 diffs = safe
- [Paywalled star outlets not gaps](feedback_paywalled_star_outlets_not_gaps.md) — Stage stubs scored via aggregatorStars-fallback; gap-scans exclude _pending/
- [Cookie health: body-length not expiry](feedback_cookie_health_body_length_not_expiry.md) — present+unexpired ≠ live; verify via review-body length; re-login needs user
- [CI E2E runs vs production](feedback_e2e_runs_against_production.md) — UI fix stays red until deploy lands; push-triggered run is deploy-lag false-neg; rerun after deploy

## 📋 Open work
- [OB venue historical backfill](project_ob_venue_historical_backfill.md) — Atlantic/Vineyard/MCC archive pages; Tier A deferred TFANA+2ndStage ([[project_ob_tier_a_deferred.md]])
- [Manual stubs bypass venue/date validation](feedback_manual_stub_bypasses_validation.md) — NEVER stub shows.json from memory; look up Playbill first

## 🎯 Opening night pipeline
- [_pending no-byline strand](feedback_pending_no_byline_strand_drain.md) — multi-critic outlets (Times/Standard/Guardian) w/o byline strand in _pending/; drain was opera-only; 511 reviews lost across 72 shows; CHECK _pending FIRST when reviews missing; drain rejects must KEEP-not-delete
- [Stuck previews suppresses score](feedback_previews_open_flip_needs_review_signal.md) — flip gated on openingDate; null strands OB/OWE; 2d review-driven backstop
- [Opening-night runbooks](feedback_admin_ingest_opening_night_2026-04-26.md) — Joe Turner master log (~42 issues, read FIRST) + 25-item failure-mode checklist ([[feedback_manual_ingest_opening_night_runbook.md]])
- [Aggregator pages post-opening only](feedback_aggregator_pages_post_opening.md) — BWW RR/DTLI/TB don't exist pre-opening
- [SERP opening night timing](feedback_serp_opening_night_timing.md) — Google indexes major outlets 2.9h+ post-pub; 3h gate
- [shows.json category at scheduling](feedback_shows_json_category_at_schedule.md) — null category/market must fail validate-data.js
- [OB openingDate==previewsStartDate](feedback_off_broadway_opening_date_gap.md) — orchestrator fires on previews-start, misses press night
- [Opening night corrections](feedback_opening_night_corrections.md) — disable orchestrator first; humanReviewScore only override
- [Email broadcast rules](email-broadcast-rules.md) — hard rules post-March-2026; never direct broadcast API
- [Broadcast quality bar](feedback_broadcast_quality_bar.md) — ≥1 more review than BWW RR; send 7-9am next morning
- [Orchestrator pause ≠ broadcast pause](feedback_orchestrator_pause_does_not_pause_broadcast.md) — broadcast auto-fires on workflow_run; disable workflow
- [PROTECTED_FIELDS 3-way sync](feedback_protected_fields_three_way_sync.md) — write-guard + push action + restore must all carry overrides

## 🏆 Awards scoring
- [Awards enrichment ≠ scoring](feedback_awards_enrichment_scoring_decoupled.md) — add CeremonyKey + POINTS entry + if block per ceremony
- [OBA Playbill SERP scraper](feedback_oba_scraper_playbill_serp_pattern.md) — no-Wikipedia awards: SERP+DOM parse, applyDDOCCDL, trust JSON-LD date
- [Tie co-winners dropped at scrape](feedback_awards_tie_cowinners_dropped_at_scrape.md) — split ' and ' between quote-runs; winnerEntries; surgical patch; dual-repo overlay

## 🎭 Tony predictions model
- [Tony predictions accuracy](project_tony_predictions_accuracy.md) — recipe weights, 93% accuracy, frozen audience grades
- [Freeze Tony audience grades](feedback_freeze_tony_audience_grades.md) — historical metrics must freeze inputs; live cron drift re-ranks closed seasons

## 📊 Data pipeline & scraping
- [Scraper architecture](feedback_scraper_architecture.md) — must use fetchPage(); CI enforces BD+SB both present; BD empty 200s, Playwright renders 404s as success ([[feedback_fetchpage_gotchas.md]])
- [Closing-date automation gaps](feedback_closing_date_audit_gaps.md) — 4 silent gaps; broadway.org/TodayTix lag; WE=0 automation
- [BD zone migrated: web_unlocker2](feedback_brightdata_zone_migration.md) — mcp_unlocker obsolete; active zone via $BRIGHTDATA_ZONE
- [SB credit budget](feedback_sb_credit_budget.md) — SB_CREDIT_BUDGET=250, SB_PAGE_CREDIT_BUDGET=200
- [Cloudflare/DataDome blocks](feedback_cloudflare_bypass_hierarchy.md) — managed challenge + WSJ/NewYorker CI IP block defeat all; Browserbase only ([[feedback_wsj_newyorker_ci_ip_block.md]])
- [Aggregator soft 404](feedback_aggregator_soft_404.md) — BWW returns 200 homepage; check <title> tag
- [Cookie auth set](feedback_stage_cookie_minimal_set.md) — Stage = 5 cookies, cookie-only; Mac Studio Tahoe path changed, Terminal needs FDA ([[feedback_mac_studio_cookies.md]])
- [Audience scrapers share normalize](feedback_audience_scrapers_share_normalize.md) — import normalizeTitle from title-match.js; commit audience-buzz before CI rebuild ([[feedback_audience_buzz_commit_before_rebuild.md]])
- [Table scrapers need structural assertions](feedback_scraper_table_assertions.md) — hardcoded cells[N] breaks on column changes
- [Orphan cast invisible by design](feedback_orphan_cast_invisible_by_design.md) — rows w/o ibdbPersonId skipped at manifest build; clean contamination first

## 🧮 Scoring & review guards
- [Scoring-logic delta required](feedback_scoring_delta_required.md) — run scoring-delta.js + temporal fixture; Stop hook enforces
- [Includability predicates must be canonical](feedback_includability_predicates_must_be_canonical.md) — call isIncludableForRebuild; "must match X" comment IS the bug ([[feedback_must_match_comment_is_a_bug.md]])
- [\b regex fails on punct/apostrophe names](feedback_word_boundary_punct_titles.md) — Schmigadoon!, O'Hara; normalize text+name, non-alphanumeric lookaround ([[feedback_apostrophe_name_matching.md]])
- [Manual review protection fields](feedback_manual_review_protection_fields.md) — need ALL 8 fields or guards re-flag; wrongProduction carve-out extends to wrongShow ([[feedback_manual_clear_covers_all_rejection_types.md]], [[feedback_protected_fields_every_write.md]])
- [Star score cap rule](feedback_star_score_cap.md) — 5/5=100 is ground truth; never cap with LLM
- [Reviews.json dual repo push](feedback_reviews_json_dual_repo_push.md) — flag + rebuild + push data repo + redeploy
- [Review recovery pipeline gaps](feedback_review_recovery_pipeline_gaps.md) — run verify-review-recovery.js; 5 steps fail independently
- [Pseudonymous bylines ≠ multi-author](feedback_pseudonymous_bylines.md) — JK/initials/pen names w/ scraper-invented name drift; URL-date guards gate on Unknown byline ([[feedback_url_date_guards_critic_gate.md]])
- [Curated historical 4-review threshold](feedback_curated_historical_4review_threshold.md) — isCuratedHistorical → 4-review min when ≥1 T1/T2
- [Regex bare-keyword/fragment FPs](feedback_content_quality_regex_fps.md) — audit patterns against real corpus before edit; anchor + URL filter ([[feedback_regex_url_fragment_fps.md]])
- [JS array > 0 is always false](feedback_js_array_gt_comparison.md) — use Array.isArray(x) + .length > 0
- [Same-title disambiguation](feedback_same_title_disambiguation.md) — extend classifyMarketRouting; ≥2-signal cascade
- [UK ceremonies strict-season gate](feedback_uk_ceremonies_strict_season.md) — new UK ceremony MUST be in UK_CEREMONIES or fallback routes WE→BW
- [Cast closure is its own event type](feedback_cast_changes_closure_type.md) — closures = `closure` event, not N per-actor `departure`
- [duplicateOf URL-mismatch = stale flag](feedback_duplicate_of_url_mismatch.md) — A.duplicateOf=B w/o matching URLs is a bug; CI gate + self-heal
- [Orphan slim show files](feedback_orphan_slim_show_files.md) — public/data/shows/{id}.json must match a shows.json id; CI gate --fix deletes
- [In-sample accuracy needs LOSO](feedback_in_sample_accuracy_claims_need_loso.md) — never publish in-sample backtest % as "Accuracy"

## 🤖 LLM / evals
- [LLM prompts must be market/type-aware](feedback_llm_prompts_market_aware.md) — inject opera-prompt-context.js for opera/special shows
- [Eval patterns](feedback_eval_patterns.md) — lib layout, 3-point validator, real-iteration loop, golden fixtures
- [LLM wrongprod false positives](feedback_llm_wrongprod_false_positives.md) — ~15% FP; temporal override is safety net
- [LLM verifier hallucinates](feedback_llm_verifier_hallucinates.md) — Gemini isValid:true at 48% on garbage; use Opus for classification ([[feedback_opus_for_classification.md]])
- [Editorial drift guard](feedback_editorial_drift.md) — discards LLM content on show count change

## 🎨 UI / design system
- [Design system reference](design-system.md) — surfaces, score tiers, shared components, banned patterns
- [Local preview before push](feedback_local_preview_before_push.md) — /visual-qa runs locally; APPROVED:<hash> required; worktree gotchas ([[feedback_visual_qa_dev_server_in_worktree.md]])
- [Mobile link min-height + row exceptions](feedback_mobile_link_min_height.md) — a{min-height:44px}; .performer-row/.craft-row opt out; e2e-guarded
- [Preserve parallel-session colors](feedback_preserve_parallel_session_colors.md) — keep colors from parallel sessions, not CD palette
- [Demo flags client-only](feedback_demo_flags_client_only.md) — isDemo()/window checks in 'use client' only
- [React.lazy() for App Router split](feedback_react_lazy_for_app_router_split.md) — next/dynamic from server = no-op; use 'use client' Loader + Suspense
- [Above-fold features live in page.tsx](feedback_page_tsx_renders_before_homepageclient.md) — render BEFORE HomePageClient; source-order in client component misleading
- [A/B tests](feedback_ab_test_guardrails.md) — PostHog filters/exclusions/stat-sig thresholds

## 💼 Commercial / features / video
- [Commercial slug keys](feedback_commercial_slug_keys.md) — commercial.json keyed by slug not ID
- [Feature launch sequence](project_feature_launch_sequence.md) — Lottery/Rush → Awards/Tony → Commercial
- [VideoScore](project_videoscore_feature.md) — video critic reviews via transcript sentiment
- [Recoupment RSS poller](feedback_recoupment_rss_poller_architecture.md) — hourly Variety+Deadline; shared classify lib; trackRecoupment flag

## 📚 Reference & repo layout
- [Repo layout](repo_layout.md) — three repos (web, iOS, data) w/ GitHub names + paths; ~/.claude is private repo via claude-sync ([[reference_claude_config_sync.md]])
- [Theatre Record reference](reference_theatre_record.md) — paid UK review archive
