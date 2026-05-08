#!/usr/bin/env node
/**
 * rebuild-memory-index.js
 *
 * Reads every memory/*.md file in the user's Claude auto-memory directory,
 * parses the YAML frontmatter (`name`, `description`, `type`), and prints
 * a suggested MEMORY.md grouped into topic sections.
 *
 * Does NOT overwrite MEMORY.md automatically — pipe stdout to a file or
 * eyeball the diff before committing. Use for drift checks when the index
 * gets stale or someone adds a file without updating the index.
 *
 * Usage:
 *   node scripts/rebuild-memory-index.js                       # print to stdout
 *   node scripts/rebuild-memory-index.js > /tmp/index.md       # save to file
 *   node scripts/rebuild-memory-index.js --diff                # diff against current
 *   node scripts/rebuild-memory-index.js --enforce-limit=180   # warn to stderr if output exceeds N lines
 *
 * Files with `archived: true` in frontmatter are excluded from the index.
 * Set this when a memory entry is no longer hot — keeps the index lean
 * without deleting the underlying note. See feedback_terse_output_default.md
 * for why MEMORY.md size matters (token cost).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MEMORY_DIR = path.join(
  process.env.HOME,
  '.claude/projects/-Users-tompryor-Broadwayscore/memory'
);

// Minimal frontmatter parser — avoids gray-matter dep.
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: text };
  const yaml = text.slice(4, end);
  const body = text.slice(end + 5);
  const data = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    data[m[1]] = val;
  }
  return { data, body };
}

// Topic sections — (emoji, title, keyword matchers on filename).
// First match wins; files with no match go to "Uncategorized".
const SECTIONS = [
  ['👤', 'User profile & session discipline', [
    /^feedback_no_premature_handoff/,
    /^feedback_next_steps_actionable/,
    /^feedback_notion_session_start/,
    /^feedback_notion_updates_automatic/,
    /^feedback_verification_gate_hook/,
    /^feedback_full_test_coverage/,
    /^feedback_save_research_findings/,
    /^feedback_review_skills_design_lens/,
    /^feedback_ship_check_finds_real_bugs/,
    /^feedback_mcp_reconnect/,
    /^feedback_local_mac_studio/,
    /^feedback_icloud_memory_sync/,
    /^feedback_email_drafting/,
    /^project_skill_flow_with_ultraplan/,
  ]],
  ['📇', 'Notion / brain', [
    /^feedback_notion_/,
    /^notion-brain-workflow/,
    /^project_roadmap_notion/,
    /^project_notion_migration/,
    /^project_research_notion_brain/,
  ]],
  ['🌳', 'Worktrees & git', [
    /^feedback_worktree_/,
    /^feedback_local_symlinks_ci/,
    /^feedback_restore_protected_fields/,
    /^feedback_review_texts_ci_overwrites/,
    /^feedback_validator_baseline_worktree/,
  ]],
  ['⚙️', 'CI / GitHub Actions / workflows', [
    /^feedback_ci_/,
    /^feedback_gha_/,
    /^feedback_github_cron/,
    /^feedback_silent_workflow_failures/,
    /^feedback_workflow_cascade_prevention/,
    /^feedback_unit_tests_no_npmci/,
    /^feedback_hook_stdin_format/,
    /^feedback_hook_channel_measurement/,
    /^feedback_configchange_hook/,
    /^feedback_claude_code_hook_inventory/,
    /^feedback_vercel_env_echo_newline/,
    /^feedback_vercel_readonly_fs/,
    /^feedback_layout_head_formatter/,
    /^feedback_json_validation_grep/,
    /^feedback_test_pipeline_fixes/,
    /^feedback_test_extraction_pattern/,
    /^feedback_theatr_token_rotation/,
    /^feedback_single_caller_for_rotating_tokens/,
    /^feedback_theatr_orchestrator_gap/,
    /^feedback_dual_repo_data_files/,
    /^feedback_outlet_registry_dual_repo/,
  ]],
  ['🎯', 'Opening night pipeline', [
    /^feedback_opening_night_/,
    /^feedback_orchestrator_/,
    /^feedback_aggregator_pages_post_opening/,
    /^feedback_dtli_bww_opening_night_timing/,
    /^feedback_we_press_night_dates/,
    /^feedback_broadcast_quality_bar/,
    /^feedback_broadcast_subject_line/,
    /^feedback_broadcast_market_scope/,
    /^feedback_resend_not_buttondown/,
    /^feedback_send_lock_pattern/,
    /^feedback_utc_date_keys_for_dedup/,
    /^feedback_parser_check_then_set_drop/,
    /^feedback_orchestrator_pause_does_not_pause_broadcast/,
    /^email-broadcast-rules/,
    /^opening_night_workarounds/,
    /^project_opening_night_/,
    /^project_cats_opening_night_postmortem/,
    /^project_doas_opening_night_issues/,
  ]],
  ['📊', 'Data pipeline & scraping', [
    /^feedback_scraper_/,
    /^feedback_fetchpage_/,
    /^feedback_tls_fingerprinting/,
    /^feedback_cloudflare_bypass_hierarchy/,
    /^feedback_aggregator_soft_404/,
    /^feedback_aggregator_score_guard/,
    /^feedback_brightdata_zones/,
    /^feedback_paywall_cookies/,
    /^feedback_mac_studio_cookies/,
    /^feedback_stage_cookie_/,
    /^feedback_stage_login_dualform/,
    /^feedback_sb_credit_budget/,
    /^feedback_stability_guard_staleness/,
    /^feedback_showscore_star_ratings/,
    /^feedback_guardian_api_not_html/,
    /^feedback_theatre_record_url_gap/,
    /^feedback_theatre_reviews_no_urls/,
    /^feedback_tb_camelcase_slugs/,
    /^feedback_wet_title_validation/,
    /^feedback_we_pipeline_testing/,
    /^feedback_timeout_ft_anti_bot/,
    /^feedback_mos_print_only/,
    /^feedback_bww_jsonld_incomplete/,
    /^feedback_gather_playwright_hang/,
    /^feedback_cross_show_url_audit/,
    /^feedback_title_normalization_module/,
    /^feedback_pipeline_reintroduces_drift/,
    /^feedback_lottery_data_pipeline/,
    /^feedback_todaytix_/,
    /^feedback_image_placeholder_prevention/,
    /^feedback_wikimedia_hotlink_ban/,
    /^feedback_mezzanine_parse_dates/,
    /^feedback_cast_changes_pipeline/,
    /^feedback_recover_ratings_scope/,
    /^feedback_audience_url_verification/,
    /^feedback_audience_score_debugging/,
    /^feedback_nextjs_sitemap_conflict/,
    /^reference_theatre_record/,
  ]],
  ['🧮', 'Scoring & review guards', [
    /^feedback_scoring_delta_required/,
    /^feedback_engine_outlet_dedup/,
    /^feedback_dual_exclusion_paths/,
    /^feedback_rebuild_dual_guards/,
    /^feedback_wrongprod_/,
    /^feedback_wrongshow_autoclear/,
    /^feedback_wrongproduction_audit_fields/,
    /^feedback_url_date_wrongprod_backstop/,
    /^feedback_dual_market_wrongprod/,
    /^feedback_tour_review_detection/,
    /^feedback_title_sequel_guard/,
    /^feedback_revival_title_disambiguation/,
    /^feedback_syndication_dedup_flagged_primary/,
    /^feedback_multi_critic_dedup/,
    /^feedback_roundup_/,
    /^feedback_star_score_cap/,
    /^feedback_preview_placeholder_design/,
    /^feedback_show_mention_heuristic_short_text/,
    /^feedback_blocked_url_silent_exclusion/,
    /^feedback_verified_sources_gate/,
    /^feedback_manual_review_protection_fields/,
    /^feedback_protected_fields_every_write/,
    /^feedback_reviews_json_dual_repo_push/,
    /^feedback_review_recovery_pipeline_gaps/,
    /^feedback_stats_global_vs_filtered/,
    /^feedback_nyt_critics_pick_source/,
    /^feedback_percentage_rounding_absorb/,
    /^feedback_id_year_suffix_unreliable/,
    /^feedback_us_theatre_hostnames/,
  ]],
  ['🤖', 'LLM / evals', [
    /^feedback_eval_patterns/,
    /^feedback_llm_/,
    /^feedback_opus_for_classification/,
    /^feedback_pullquote_verdict_alignment/,
    /^feedback_structuredtips_hallucinations/,
    /^feedback_editorial_drift/,
    /^feedback_serp_preview_check/,
  ]],
  ['🎨', 'UI / design system', [
    /^design-system/,
    /^social-media-guide/,
    /^feedback_satori_display_flex/,
    /^feedback_visual_verify_before_push/,
    /^feedback_round_once_share_everywhere/,
    /^feedback_tailwind_custom_opacity/,
    /^feedback_map_iterator_spread/,
    /^feedback_demo_flags_client_only/,
    /^feedback_ticket_cta_placement/,
    /^feedback_schema_org_validation/,
    /^feedback_stubhub_hidden/,
    /^feedback_ab_test_/,
    /^feedback_affiliate_infrastructure/,
    /^feedback_impact_api_dates/,
  ]],
  ['💼', 'Commercial / features / video', [
    /^project_commercial_/,
    /^project_feature_launch_sequence/,
    /^feedback_commercial_slug_keys/,
    /^project_videoscore_/,
    /^project_revival_analysis/,
    /^seo-domain-authority-guide/,
    /^feedback_new_platform_integration/,
  ]],
  ['📚', 'Reference & repo layout', [
    /^repo_layout/,
    /^reference_/,
  ]],
];

function pickSection(name) {
  for (const [, title, patterns] of SECTIONS) {
    if (patterns.some((re) => re.test(name))) return title;
  }
  return 'Uncategorized';
}

function humanTitle(name, description) {
  if (description) {
    const cleaned = description.replace(/\*\*/g, '').trim();
    const firstClause = cleaned.split(/[.:—–] /)[0].slice(0, 60);
    if (firstClause.length >= 4) return firstClause;
  }
  return name
    .replace(/\.md$/, '')
    .replace(/^(feedback|project|reference)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function compress(text, limit = 120) {
  const cleaned = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit - 1).replace(/\s\S*$/, '') + '…';
}

function main() {
  const files = fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

  const grouped = new Map();
  for (const [, title] of SECTIONS) grouped.set(title, []);
  grouped.set('Uncategorized', []);

  let archivedCount = 0;
  for (const file of files) {
    const full = path.join(MEMORY_DIR, file);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const raw = fs.readFileSync(full, 'utf8');
    const { data } = parseFrontmatter(raw);
    if (data.archived === 'true' || data.archived === true) {
      archivedCount++;
      continue;
    }
    const description = data.description || '';
    const title = humanTitle(file, description);
    const section = pickSection(file);
    grouped.get(section).push({
      file,
      title,
      description: compress(description || title, 120),
    });
  }

  const lines = ['## Memory Index', ''];
  for (const [emoji, title] of SECTIONS) {
    const entries = grouped.get(title) || [];
    if (entries.length === 0) continue;
    lines.push(`## ${emoji} ${title}`);
    for (const e of entries.sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`- [${e.title}](${e.file}) — ${e.description}`);
    }
    lines.push('');
  }

  const unc = grouped.get('Uncategorized');
  if (unc && unc.length > 0) {
    lines.push('## Uncategorized');
    for (const e of unc.sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`- [${e.title}](${e.file}) — ${e.description}`);
    }
    lines.push('');
  }

  const out = lines.join('\n');

  // --enforce-limit=N: warn (non-fatal) if rebuilt index would exceed N lines.
  // Prints to stderr so callers can `> MEMORY.md` without contaminating output.
  // Exit code 0 — informational only; future tightening could exit non-zero.
  const limitArg = process.argv.find((a) => a.startsWith('--enforce-limit='));
  if (limitArg) {
    const limit = parseInt(limitArg.split('=')[1], 10);
    const lineCount = out.split('\n').length;
    if (Number.isFinite(limit) && lineCount > limit) {
      process.stderr.write(
        `[rebuild-memory-index] WARNING: index is ${lineCount} lines (limit ${limit}).\n` +
          `  ${archivedCount} file(s) already archived. To shrink further, add\n` +
          `  'archived: true' to frontmatter of older/redundant entries.\n`
      );
    }
  }

  if (process.argv.includes('--diff')) {
    const currentPath = path.join(MEMORY_DIR, 'MEMORY.md');
    const tmp = path.join(require('os').tmpdir(), 'MEMORY.suggested.md');
    fs.writeFileSync(tmp, out);
    try {
      const diff = execSync(`diff -u "${currentPath}" "${tmp}" || true`).toString();
      process.stdout.write(diff);
    } catch (err) {
      process.stdout.write(out);
    }
  } else {
    process.stdout.write(out);
  }
}

main();
