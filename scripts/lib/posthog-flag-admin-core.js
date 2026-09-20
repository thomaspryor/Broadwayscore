/**
 * posthog-flag-admin-core.js — pure request-building + result-matching logic
 * for scripts/posthog-flag-admin.js (BRO-3459).
 *
 * No state is tracked here or anywhere else for this tool — unlike
 * scripts/lib/flag-registry.js, this isn't a registry of expected state,
 * it's a one-off admin action. The GitHub Actions run log is the audit
 * trail (see .github/workflows/manual-posthog-flag-archive.yml).
 *
 * PostHog's GET .../feature_flags/?search=<key> does fuzzy/substring
 * matching, not exact — scripts/monitor-flag-parity.js:fetchLiveFlag()
 * already has to `.find(r => r.key === key)` after calling it. This module
 * makes that same narrowing reusable and adds the ambiguous-match case
 * (never silently pick one of several exact matches).
 */

function buildSearchUrl(projectId, key) {
  return `https://us.posthog.com/api/projects/${projectId}/feature_flags/?search=${encodeURIComponent(key)}`;
}

// GET this to fetch one flag's current state, PATCH it to change `active`.
function buildFlagUrl(projectId, id) {
  return `https://us.posthog.com/api/projects/${projectId}/feature_flags/${id}/`;
}

// results: the `.results` array from a ?search= response. Returns exactly
// one of match / ambiguous / neither — callers must not guess when
// ambiguous is true or match is null.
function findExactFlagMatch(results, key) {
  const matches = (results || []).filter((r) => r.key === key);
  if (matches.length === 1) return { match: matches[0], ambiguous: false };
  if (matches.length > 1) return { match: null, ambiguous: true, matches };
  return { match: null, ambiguous: false };
}

function buildPatchRequest(projectId, id, active) {
  return {
    url: buildFlagUrl(projectId, id),
    method: 'PATCH',
    body: JSON.stringify({ active }),
  };
}

const USAGE = 'Usage: node scripts/posthog-flag-admin.js <flag-key-or-numeric-id> [--active=true|false] [--dry-run]';
const KNOWN_FLAGS = /^(--active=|--dry-run$)/;

// Strict CLI arg parsing — a typo'd or malformed value must throw, not
// silently fall through to the archive default. A silent fallthrough here
// would make a typo (e.g. --active=True, an unknown flag) indistinguishable
// from an intentional archive, since both look identical from the caller's
// side (adversarial review finding, BRO-3459).
function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) throw new Error(USAGE);

  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.test(a));
  if (unknown.length > 0) throw new Error(`${USAGE}\nUnrecognized flag(s): ${unknown.join(', ')}`);

  const activeArgs = argv.filter((a) => a.startsWith('--active='));
  if (activeArgs.length > 1) throw new Error(`${USAGE}\n--active passed more than once: ${activeArgs.join(', ')}`);
  let desiredActive = false;
  if (activeArgs.length === 1) {
    const value = activeArgs[0].slice('--active='.length);
    if (value !== 'true' && value !== 'false') {
      throw new Error(`${USAGE}\n--active must be exactly 'true' or 'false', got '${value}'`);
    }
    desiredActive = value === 'true';
  }

  const dryRun = argv.includes('--dry-run');
  return { identifier: positional[0], desiredActive, dryRun };
}

// Warns (never blocks) when archiving/restoring a key that's still a
// scripts/lib/flag-registry.js REGISTERED_FLAGS entry expecting a DIFFERENT
// active state — otherwise monitor-flag-parity.js's next weekly run reports
// it as unhealthy drift with no obvious cause (BRO-3459 what-else finding).
// Only flags exists:true entries (per flag-registry.js's own convention, an
// exists:false entry means "deliberately not live" and isn't a real flag to
// warn about here).
function checkRegistryConflict(key, desiredActive, registeredFlags) {
  const entry = (registeredFlags || []).find((f) => f.key === key);
  // Every current REGISTERED_FLAGS entry has `expected`, but this is a
  // warn-only helper (never blocks): a future entry missing `expected`
  // must be treated as "nothing to check" (null), not fall through to a
  // nonsensical "expecting active:undefined" warning — a real bug an
  // earlier version of this fix had (caught: `!entry.expected` wasn't
  // checked, so `undefined === false` and `undefined === desiredActive`
  // both evaluated false and fell through to the return string below).
  if (!entry || !entry.expected || entry.expected.exists === false) return null;
  if (entry.expected.active === desiredActive) return null;
  return `'${key}' is a scripts/lib/flag-registry.js REGISTERED_FLAGS entry expecting active:${entry.expected.active} — monitor-flag-parity.js's next run will report this as drift. If this flag's code is fully retired, remove its registry entry too.`;
}

module.exports = {
  buildSearchUrl,
  buildFlagUrl,
  findExactFlagMatch,
  buildPatchRequest,
  parseArgs,
  checkRegistryConflict,
};
