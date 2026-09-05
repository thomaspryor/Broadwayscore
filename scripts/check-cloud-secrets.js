#!/usr/bin/env node
/**
 * check-cloud-secrets.js — verify required env vars are reachable.
 *
 * Run inside a fresh cloud Claude Code session to confirm the Tier 1
 * secrets configured in claude.ai/settings actually reached the sandbox.
 *
 * Exit codes:
 *   0 = all Tier 1 secrets present
 *   1 = one or more Tier 1 secrets missing
 *
 * RESOLUTION ORDER (changed 2026-09-05): process.env first, then .env on disk
 * via readEnvKeys() — the same path scripts/lib/linear-client.js and every
 * other credential consumer uses. Reading raw process.env only was wrong: a
 * headless/dispatched session on the owner's machine has a real .env but an
 * empty process.env, so this script reported every Tier 1 secret MISSING while
 * the scripts themselves worked fine. That false verdict already cost real
 * design effort once (BRO-591, see cloud-memory/
 * feedback_headless_dispatch_has_real_env_not_cloud_sandbox.md) and would now
 * cost more: an operator who reads "LINEAR_API_KEY MISSING" rationally invokes
 * CLAUDE.md §6's "if Linear is down, continue untracked" fallback and skips the
 * board — the exact silent gap the LINEAR_API_KEY entry below exists to close.
 * A genuine cloud sandbox has no .env, so its verdict is unchanged.
 *
 * TIER_1 / TIER_2 are exported for tests/unit/cloud-secrets-tiers.test.mjs
 * (CLAUDE.md §15: the test requires the real arrays, never a copy).
 *
 * Companion doc: `.claude/CLOUD.md` step 1.
 */

const { readEnvKeys } = require('./lib/load-env');

// Tier 1: required for common cloud-session work. Update this list when a
// new script gains a hard cloud-relevant env dependency.
//
// NOTION_API_KEY: kept required only for the legacy Notion readers that still
// run (notion-action-poll.js, health-check.js, posthog-friction-analyzer.js).
// It is NOT needed by any hook — `.claude/hooks/notion-create-block.sh` gates
// on a /tmp breadcrumb file and never reads this key; the "notion-create hook
// gate" rationale that used to sit here and in CLOUD.md was simply wrong.
// Since CLAUDE.md §6 retires Notion, this belongs in Tier 2 — tracked as
// S5-T6 in sprint-plan-notion-linear-cutover.md rather than changed here,
// because demoting it is a behavior change of its own.
//
// LINEAR_API_KEY: CLAUDE.md §6 makes Linear the board, and linear-brain.js
// needs it at BOTH session start (file the issue) and session end (comment the
// Outcome + set state). Missing from this list until 2026-09-05, so a cloud
// sandbox could report "all Tier 1 present" while every board operation failed
// closed and the session left no board entry at all.
const TIER_1 = [
  'NOTION_API_KEY',
  'LINEAR_API_KEY',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'BRIGHTDATA_TOKEN',
  'BRIGHTDATA_ZONE',
  'BRIGHTDATA_CUSTOMER',
  'SCRAPINGBEE_API_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'RESEND_API_KEY',
];

// Tier 2: useful when doing specific work. Reported but doesn't fail the check.
const TIER_2 = [
  'RESEND_BROADWAY_AUDIENCE_ID',
  'RESEND_WE_AUDIENCE_ID',
  'RESEND_FANTASY_AUDIENCE_ID',
  'APPROVAL_HMAC_SECRET',
  'IMPACT_AUTH_TOKEN',
  'MEZZANINE_SESSION_TOKEN',
  'POSTHOG_PERSONAL_API_KEY',
  'POSTHOG_PROJECT_ID',
  'GOOGLE_INDEXING_KEY',
  'GUARDIAN_API_KEY',
  'GA_SERVICE_ACCOUNT_KEY',
  'PARTNERIZE_API_KEY',
  'PARTNERIZE_APP_KEY',
  'BSKY_HANDLE',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'BSKY_APP_PASSWORD',
];

function main() {
  // readEnvKeys returns ONLY keys absent from process.env, sourced from .env,
  // so process.env still wins and this stays a no-op in a real cloud sandbox.
  const fromDisk = readEnvKeys(TIER_1.concat(TIER_2));

  const statusFor = (name) => {
    const v = process.env[name] || fromDisk[name];
    if (v === undefined || v === '') return { set: false };
    // Reveal length + first-3 chars so the user can spot a stale/wrong value
    // without leaking it. `source` makes a .env-only hit visible, so nobody
    // mistakes a working headless session for a correctly-configured cloud one.
    return {
      set: true,
      len: v.length,
      prefix: v.slice(0, 3),
      source: process.env[name] ? 'env' : '.env',
    };
  };

  let tier1Missing = 0;

  console.log('=== Tier 1 (REQUIRED) ===');
  for (const name of TIER_1) {
    const s = statusFor(name);
    if (s.set) {
      const via = s.source === '.env' ? ' via .env' : '';
      console.log(`  ✓ ${name.padEnd(28)} SET (${s.len} chars, "${s.prefix}…"${via})`);
    } else {
      console.log(`  ✗ ${name.padEnd(28)} MISSING`);
      tier1Missing++;
    }
  }

  console.log('');
  console.log('=== Tier 2 (optional, report only) ===');
  for (const name of TIER_2) {
    const s = statusFor(name);
    console.log(s.set
      ? `  ✓ ${name.padEnd(36)} SET${s.source === '.env' ? ' (via .env)' : ''}`
      : `  · ${name.padEnd(36)} not set`);
  }

  console.log('');
  if (tier1Missing > 0) {
    console.log(`✗ ${tier1Missing} Tier 1 secret(s) missing.`);
    console.log('  Set them at claude.ai/code → cloud icon (env name, top of input area) → hover env row → gear icon → Environment variables field (KEY=value, no quotes).');
    console.log('  Full guide: `.claude/CLOUD.md` step 1 (in this repo).');
    return 1;
  }
  console.log('✓ All Tier 1 secrets present. Cloud session is ready.');
  return 0;
}

module.exports = { TIER_1, TIER_2 };

if (require.main === module) process.exit(main());
