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

module.exports = {
  buildSearchUrl,
  buildFlagUrl,
  findExactFlagMatch,
  buildPatchRequest,
};
