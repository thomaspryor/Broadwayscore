// BRO-6408: classify a GitHub token by prefix so the Monday health check can
// tell the fine-grained PAT REVIEW_TEXTS_TOKEN is meant to be from a classic
// all-repo one (the owner was asked to switch, BRO-6398).
const FINE_GRAINED_REPOS = [
  'Broadwayscore',
  'broadway-review-texts',
  'broadway-scorecard-data',
  'claude-config',
  'BroadwayScorecard-app',
];

function classifyPatToken(token) {
  const t = String(token || '').trim();
  if (t.startsWith('github_pat_')) return 'fine-grained';
  if (t.startsWith('ghp_')) return 'classic';
  if (t.startsWith('gho_')) return 'oauth';
  return 'unknown';
}

// Warn text for tokens that should be replaced, or null when the type is fine.
function legacyTokenWarning(token, name = 'REVIEW_TEXTS_TOKEN') {
  const type = classifyPatToken(token);
  if (type === 'classic') return `${name} is still a classic/all-repo token (ghp_); swap it for a fine-grained github_pat_ token`;
  if (type === 'oauth') return `${name} is a gh OAuth token (gho_); swap it for a fine-grained github_pat_ token`;
  return null;
}

module.exports = { classifyPatToken, legacyTokenWarning, FINE_GRAINED_REPOS };
