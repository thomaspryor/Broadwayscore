#!/usr/bin/env node
/**
 * check-cloud-secrets.js — verify required env vars are reachable.
 *
 * Run inside a fresh cloud Claude Code session to confirm the Tier 1
 * secrets configured in claude.ai/settings actually reached the sandbox.
 *
 * `--smoke [--only=a,b]` instead runs one cheap functional check per consumer
 * group (lib/cloud-secrets-smoke.js) and exits 1 if any fails.
 *
 * Exit codes:
 *   0 = all Tier 1 secrets present (in a cloud session, CLOUD_WITHHELD keys
 *       are expected-absent and do not count)
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

const { readEnvKeys, readEnvFile } = require('./lib/load-env');

// Tier 1: required for common cloud-session work. Update this list when a
// new script gains a hard cloud-relevant env dependency.
//
// NOTION_API_KEY moved to Tier 2 (BRO-3018, closes S5-T6 in
// sprint-plan-notion-linear-cutover.md): the board is Linear and nothing a
// cloud session runs reads it any more. Only the retired Mac-side Notion
// tools and the one-shot corpus export still use it.
//
// LINEAR_API_KEY: CLAUDE.md §6 makes Linear the board, and linear-brain.js
// needs it at BOTH session start (file the issue) and session end (comment the
// Outcome + set state). Missing from this list until 2026-09-05, so a cloud
// sandbox could report "all Tier 1 present" while every board operation failed
// closed and the session left no board entry at all.
const TIER_1 = [
  'LINEAR_API_KEY',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'BRIGHTDATA_TOKEN',
  'BRIGHTDATA_ZONE',
  'SCRAPINGBEE_API_KEY',
  'SCRAPINGDOG_API_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'RESEND_API_KEY',
];

// Keys cloud sessions are deliberately NOT given. Only ANTHROPIC_API_KEY now:
// Claude API work runs through GitHub Actions / scripts/cloud-run-script.js.
// The scraper and Resend keys were withheld until the owner added them to the
// Default environment (BRO-6112). In cloud (and only there) the check treats
// these as expected-absent, not as a failure. Still Tier 1 everywhere else.
// BRIGHTDATA_CUSTOMER is not required: its readers (evaluate-brightdata-serp.js,
// lib/url-discovery.js) fall back to a hardcoded default.
const CLOUD_WITHHELD = [
  'ANTHROPIC_API_KEY',
];

// Tier 2: useful when doing specific work. Reported but doesn't fail the check.
const TIER_2 = [
  'NOTION_API_KEY',
  'RESEND_BROADWAY_AUDIENCE_ID',
  'RESEND_WE_AUDIENCE_ID',
  'RESEND_FANTASY_AUDIENCE_ID',
  // APPROVAL_HMAC_SECRET stays OUT of cloud on purpose: a session holding it
  // could sign its own owner approvals. Listed so a stray copy is visible.
  'APPROVAL_HMAC_SECRET',
  'IMPACT_ACCOUNT_SID',
  'IMPACT_AUTH_TOKEN',
  'BING_WEBMASTER_API_KEY',
  'FORMSPREE_TOKEN',
  'FORMSPREE_SUBSCRIBER_API_KEY',
  'FORMSPREE_SUBSCRIBER_FORM_ID',
  'FORMSPREE_WESTEND_SUBSCRIBER_API_KEY',
  'FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID',
  'FORMSPREE_FOLLOW_API_KEY',
  'FORMSPREE_FOLLOW_FORM_ID',
  'PAGESPEED_API_KEY',
  'GA4_PROPERTY_ID',
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
  // Accounts and deploy work (BRO-4894). None of these were listed, so a
  // cloud session auditing sign-in had no way to see it lacked them: the
  // Supabase Management API (custom domain, auth config), the service role
  // (account counts), the public pair a local build with accounts needs,
  // Vercel (deploy checks, DNS) and Sentry (crash lookups).
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'VERCEL_TOKEN',
  'SENTRY_AUTH_TOKEN',
];

// Shortest value we will show a 3-char prefix for. A 40-char token loses
// nothing to 3 characters; BRIGHTDATA_ZONE is short
// enough that a prefix is a meaningful fraction of the secret, and this script
// now reads values off disk that it previously never touched, so the exposure
// is wider than it was. Below the floor we print the length only.
const PREFIX_MIN_LEN = 12;

/**
 * Pure resolver — the actual behavior this file changed, extracted so it can be
 * tested (CLAUDE.md §15). `main()` only formats what this returns.
 *
 * Precedence: a non-empty process.env value always wins; .env fills in only
 * what the environment lacks. Empty string counts as absent on both sides,
 * matching scripts/lib/load-env.js's documented convention (load-env.js:22).
 *
 * @param {string} name
 * @param {Record<string,string>} fromDisk - readEnvKeys() output
 */
function statusFor(name, fromDisk = {}) {
  const v = process.env[name] || fromDisk[name];
  if (v === undefined || v === '') return { set: false };
  return {
    set: true,
    len: v.length,
    // Length + first-3-chars lets the user spot a stale/wrong value without
    // revealing it — but only once the value is long enough for 3 chars not to
    // matter. `source` makes a .env-only hit visible so nobody mistakes a
    // working headless session for a correctly-configured cloud one.
    prefix: v.length >= PREFIX_MIN_LEN ? v.slice(0, 3) : null,
    source: process.env[name] ? 'env' : '.env',
  };
}

/**
 * Pure: is this missing Tier 1 key expected to be absent? True only in a cloud
 * session (CLAUDE_CODE_REMOTE=true) and only for CLOUD_WITHHELD keys.
 *
 * @param {string} name
 * @param {Record<string,string|undefined>} env
 */
function isWithheldInCloud(name, env = process.env) {
  return env.CLAUDE_CODE_REMOTE === 'true' && CLOUD_WITHHELD.includes(name);
}

const describe = (s) =>
  s.prefix ? `${s.len} chars, "${s.prefix}…"` : `${s.len} chars`;

function main() {
  // readEnvKeys returns ONLY keys absent from process.env, sourced from .env,
  // so process.env still wins and this stays a no-op in a real cloud sandbox.
  const fromDisk = readEnvKeys(TIER_1.concat(TIER_2));
  // Which .env answered matters: run from a worktree (which never has its own)
  // readEnvKeys falls back to load-env.js's CANONICAL_REPO, so a 'via .env' hit
  // can come from a different checkout than the one you are standing in.
  const envPath = Object.keys(fromDisk).length ? readEnvFile().path : null;

  let tier1Missing = 0;
  let tier1Withheld = 0;
  const tier1FromDisk = [];

  console.log('=== Tier 1 (REQUIRED) ===');
  for (const name of TIER_1) {
    const s = statusFor(name, fromDisk);
    if (s.set) {
      const via = s.source === '.env' ? ' via .env' : '';
      if (s.source === '.env') tier1FromDisk.push(name);
      // A key the owner keeps out of the sandbox on purpose has turned up in it.
      const leak = isWithheldInCloud(name) ? ' (unexpected: withheld on purpose in cloud)' : '';
      console.log(`  ✓ ${name.padEnd(28)} SET (${describe(s)}${via})${leak}`);
    } else if (isWithheldInCloud(name)) {
      console.log(`  · ${name.padEnd(28)} withheld by design in cloud`);
      tier1Withheld++;
    } else {
      console.log(`  ✗ ${name.padEnd(28)} MISSING`);
      tier1Missing++;
    }
  }
  if (tier1Withheld > 0) {
    console.log(`  (${tier1Withheld} withheld on purpose; run a landed script with them via` +
      ' `node scripts/cloud-run-script.js scripts/<x>.js`)');
  }

  console.log('');
  console.log('=== Tier 2 (optional, report only) ===');
  for (const name of TIER_2) {
    const s = statusFor(name, fromDisk);
    console.log(s.set
      ? `  ✓ ${name.padEnd(36)} SET${s.source === '.env' ? ' (via .env)' : ''}`
      : `  · ${name.padEnd(36)} not set`);
  }

  console.log('');
  // Never say "all Tier 1 present" while withheld keys are absent.
  const withheldTail = tier1Withheld > 0 ? ` (${tier1Withheld} withheld by design in cloud)` : '';
  const allPhrase = tier1Withheld > 0
    ? `All other Tier 1 secrets present in the environment${withheldTail}`
    : 'All Tier 1 secrets present in the environment';
  if (tier1Missing > 0) {
    console.log(`✗ ${tier1Missing} Tier 1 secret(s) missing.`);
    console.log('  Set them at claude.ai/code → cloud icon (env name, top of input area) → hover env row → gear icon → Environment variables field (KEY=value, no quotes).');
    console.log('  Full guide: `.claude/CLOUD.md` step 1 (in this repo).');
    console.log('  No paste needed to USE a missing key (BRO-5008): `node scripts/cloud-run-script.js scripts/<x>.js [args]`');
    console.log('  runs a landed script in Actions with the production keys and prints its output here.');
    return 1;
  }
  // Never claim "cloud session is ready" off a disk-sourced pass. A .env hit
  // proves the SCRIPTS will find the key; it proves nothing about the cloud
  // sandbox's own environment, which is what this script is named for. Saying
  // "ready" here would let someone conclude "it passed locally, so the cloud
  // env must be fine" — the inverse of the false-MISSING problem the .env
  // fallback was added to fix, and just as misleading.
  if (tier1FromDisk.length > 0) {
    console.log(`✓ All Tier 1 secrets resolvable${withheldTail} — but ` +
      `${tier1FromDisk.length} came from .env on disk, not the environment:`);
    console.log(`    ${tier1FromDisk.join(', ')}`);
    console.log(`  (.env read: ${envPath || 'unknown path'})`);
    console.log('  Only scripts that load credentials through scripts/lib/load-env.js see');
    console.log('  these — linear-client.js, the ~24 loadEnv() callers, and (as of 2026-09-11)');
    console.log('  lib/scraper.js itself for BRIGHTDATA_TOKEN/BRIGHTDATA_ZONE/SCRAPINGBEE_API_KEY');
    console.log('  only, via a scoped readEnvKeys() top-up. Every OTHER secret, and any script');
    console.log('  reading process.env directly for something scraper.js does not touch');
    console.log('  (gather-reviews.js\'s OPENAI_API_KEY, opening-night-poller.js\'s RESEND_API_KEY,');
    console.log('  collect-review-texts.js, …), will still fail on them.');
    console.log('  This does NOT verify a cloud sandbox: a real claude.ai/code session has');
    console.log('  no .env, so it would report these MISSING.');
    return 0;
  }
  console.log(`✓ ${allPhrase}. Cloud session is ready.`);
  return 0;
}

async function smokeMain(argv = process.argv) {
  const { runSmoke, summarize } = require('./lib/cloud-secrets-smoke');
  const names = TIER_1.concat(TIER_2);
  const env = { ...readEnvKeys(names), ...Object.fromEntries(names.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : undefined;
  const unknown = (only || []).filter((g) => !Object.keys(require('./lib/cloud-secrets-smoke').GROUPS).includes(g));
  if (unknown.length) { console.error(`Unknown smoke group(s): ${unknown.join(', ')}`); return 2; }
  const results = await runSmoke(env, { only });
  const { failed, lines } = summarize(results);
  console.log('=== Smoke: does each consumer do its real job? (BRO-6258) ===');
  lines.forEach((l) => console.log(l));
  console.log(failed ? `\n✗ ${failed} smoke check(s) failed.` : '\n✓ All smoke checks passed.');
  return failed ? 1 : 0;
}

module.exports = { smokeMain, TIER_1, TIER_2, CLOUD_WITHHELD, statusFor, isWithheldInCloud, PREFIX_MIN_LEN };

if (require.main === module) {
  if (process.argv.includes('--smoke')) smokeMain().then((c) => process.exit(c));
  else process.exit(main());
}
