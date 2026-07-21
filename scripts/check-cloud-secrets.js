#!/usr/bin/env node
/**
 * check-cloud-secrets.js — verify required env vars are present.
 *
 * Run inside a fresh cloud Claude Code session to confirm the Tier 1
 * secrets configured in claude.ai/settings actually reached the sandbox.
 *
 * Exit codes:
 *   0 = all Tier 1 secrets present
 *   1 = one or more Tier 1 secrets missing
 *
 * Companion doc: ~/Documents/claude-outputs/cloud-secrets-checklist.md
 */

// Tier 1: required for common cloud-session work. Update this list when a
// new script gains a hard cloud-relevant env dependency.
const TIER_1 = [
  'NOTION_API_KEY',
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

function statusFor(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return { set: false };
  // Reveal length + first-3 chars so user can spot stale/wrong values without leaking
  return { set: true, len: v.length, prefix: v.slice(0, 3) };
}

let tier1Missing = 0;

console.log('=== Tier 1 (REQUIRED) ===');
for (const name of TIER_1) {
  const s = statusFor(name);
  if (s.set) {
    console.log(`  ✓ ${name.padEnd(28)} SET (${s.len} chars, "${s.prefix}…")`);
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
    ? `  ✓ ${name.padEnd(36)} SET`
    : `  · ${name.padEnd(36)} not set`);
}

console.log('');
if (tier1Missing > 0) {
  console.log(`✗ ${tier1Missing} Tier 1 secret(s) missing.`);
  console.log('  Set them at claude.ai/code → cloud icon (env name, top of input area) → hover env row → gear icon → Environment variables field (KEY=value, no quotes).');
  console.log('  Full guide: ~/Documents/claude-outputs/cloud-secrets-checklist.md (local) or `.claude/CLOUD.md` (in this repo).');
  process.exit(1);
}
console.log('✓ All Tier 1 secrets present. Cloud session is ready.');
process.exit(0);
