#!/usr/bin/env node
/**
 * posthog-flag-admin.js — archive (or restore) a PostHog feature flag by
 * key or numeric id (BRO-3459).
 *
 * Built because no local dev session has POSTHOG_PERSONAL_API_KEY (it's
 * CI-only) — every future concluded experiment needs this same one-off
 * action, and until now no script could PATCH a flag's state at all
 * (existing scripts/analyze-*.js, monitor-*.js only read). Archives via
 * `active: false`, never DELETEs — matches the reproducibility precedent
 * docs/experiments/gate-cold-start.md already set for that flag (id 772232).
 *
 * Usage:
 *   node scripts/posthog-flag-admin.js <flag-key-or-numeric-id> [--active=true|false] [--dry-run]
 *
 * --active defaults to false (archive). Always GETs and prints the flag's
 * current state before touching anything — including on the numeric-id
 * path, so a mistyped id can't silently archive the wrong flag.
 *
 * Env: POSTHOG_PERSONAL_API_KEY (set via .github/workflows/manual-posthog-flag-archive.yml's secret).
 */

const { buildSearchUrl, buildFlagUrl, findExactFlagMatch, buildPatchRequest, parseArgs } = require('./lib/posthog-flag-admin-core');

const PROJECT_ID = '332742';

function getApiKey() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY not set');
  return key;
}

async function fetchFlagById(apiKey, id) {
  const res = await fetch(buildFlagUrl(PROJECT_ID, id), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`PostHog feature_flags API ${res.status} for id '${id}': ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function findFlagByKey(apiKey, key) {
  const res = await fetch(buildSearchUrl(PROJECT_ID, key), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`PostHog feature_flags API ${res.status} for key '${key}': ${(await res.text()).slice(0, 200)}`);
  const results = (await res.json()).results || [];
  const { match, ambiguous, matches } = findExactFlagMatch(results, key);
  if (ambiguous) {
    const ids = matches.map((m) => m.id).join(', ');
    throw new Error(`Ambiguous: ${matches.length} flags with exact key '${key}' (ids: ${ids}) — re-run with the specific numeric id.`);
  }
  if (!match) {
    throw new Error(`No flag with exact key '${key}' found (search returned ${results.length} fuzzy match(es)).`);
  }
  return match;
}

async function patchFlagActive(apiKey, id, active) {
  const { url, method, body } = buildPatchRequest(PROJECT_ID, id, active);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`PostHog PATCH ${res.status} for id '${id}': ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const { identifier, desiredActive, dryRun } = parseArgs(process.argv.slice(2));
  const apiKey = getApiKey();

  const flag = /^\d+$/.test(identifier)
    ? await fetchFlagById(apiKey, identifier)
    : await findFlagByKey(apiKey, identifier);

  console.log(`Found flag: key='${flag.key}' id=${flag.id} active=${flag.active}`);

  if (flag.active === desiredActive) {
    console.log(`Already active=${desiredActive} — nothing to do.`);
    return;
  }

  if (dryRun) {
    console.log(`DRY RUN: would set active=${desiredActive} (no PATCH sent).`);
    return;
  }

  const updated = await patchFlagActive(apiKey, flag.id, desiredActive);
  console.log(`Updated: key='${updated.key}' id=${updated.id} active=${updated.active}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
