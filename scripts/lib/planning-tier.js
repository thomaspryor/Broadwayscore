// scripts/lib/planning-tier.js (BRO-6249)
//
// Three-tier planning rule (owner decision 2026-10-25, BRO-6246):
//   substantial = plan + /plan-review + owner yes   (a new system is a product decision)
//   moderate    = quick /second-opinion              (nudge only, never blocks)
//   simple      = go
// Pure decision functions; the PreToolUse hook (.claude/hooks/planning-tier-advisory.sh)
// feeds them facts from git. Tested by scripts/tests/planning-tier.test.mjs.

const { findFreshPlanVerdict, VERDICT_TTL_MS } = require('./infra-review-scope.js');

// Warn-only until this instant, then substantial + unapproved blocks (CLAUDE.md §19:
// new gates land advisory first; the card asks for "blocks after a week").
const ENFORCE_AFTER_MS = Date.parse('2026-11-07T00:00:00Z');
const SUBSTANTIAL_NEW_FILES_IN_NEW_DIR = 4;
const MODERATE_NEW_FILES_IN_NEW_DIR = 2;
const APPROVAL_TOKEN = 'OWNER-PLAN-APPROVED:';

// Where a "new directory" is a meaningful signal. Data, docs and tests are not systems.
const WATCHED_ROOTS = /^(src|scripts|supabase|\.github|\.claude)\//;
const EXEMPT = /^(data|memory|cloud-memory|docs|public|node_modules|\.claude\/worktrees)\/|(^|\/)(tests?|__tests__)\/|\.test\.(m?js|tsx?)$|\.md$/;
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SECRET_RE = /\bsecrets\.([A-Z][A-Z0-9_]{2,})/g;
// GitHub-provided, not a secret anyone has to create.
const BUILTIN_SECRETS = new Set(['GITHUB_TOKEN']);

function secretsIn(content) {
  const out = new Set();
  if (typeof content !== 'string') return out;
  for (const m of content.matchAll(SECRET_RE)) if (!BUILTIN_SECRETS.has(m[1])) out.add(m[1]);
  return out;
}

// facts: { relPath, isNewFile, dirIsNew, newFilesInDir (incl. this one), content, knownSecrets:Set }
function classify(facts) {
  const { relPath = '', isNewFile = false, dirIsNew = false, newFilesInDir = 0, content = '', knownSecrets = new Set() } = facts || {};
  if (!isNewFile || !relPath || EXEMPT.test(relPath)) return { tier: 'simple', triggers: [] };
  const substantial = [];
  const moderate = [];
  if (WORKFLOW_RE.test(relPath)) substantial.push('new workflow ' + relPath);
  const fresh = [...secretsIn(content)].filter((s) => !knownSecrets.has(s));
  if (fresh.length) substantial.push('new secret ' + fresh.join(', '));
  if (WATCHED_ROOTS.test(relPath) && dirIsNew) {
    if (newFilesInDir >= SUBSTANTIAL_NEW_FILES_IN_NEW_DIR) substantial.push(`file #${newFilesInDir} in new directory`);
    else if (newFilesInDir >= MODERATE_NEW_FILES_IN_NEW_DIR) moderate.push(`file #${newFilesInDir} in new directory`);
  }
  if (substantial.length) return { tier: 'substantial', triggers: substantial };
  if (moderate.length) return { tier: 'moderate', triggers: moderate };
  return { tier: 'simple', triggers: [] };
}

function isApproved({ verdicts = [], sessionId = null, now = Date.now(), transcriptText = '' }) {
  if (findFreshPlanVerdict({ verdicts, sessionId, now })) return { ok: true, via: 'plan-review verdict' };
  const i = String(transcriptText).indexOf(APPROVAL_TOKEN);
  if (i >= 0 && /\S{3}/.test(String(transcriptText).slice(i + APPROVAL_TOKEN.length, i + APPROVAL_TOKEN.length + 40))) {
    return { ok: true, via: APPROVAL_TOKEN };
  }
  return { ok: false, via: null };
}

// -> { action: 'allow'|'warn'|'block', message }
function decide({ tier, triggers = [], approved = false, now = Date.now(), mode = 'auto', enforceAfter = ENFORCE_AFTER_MS }) {
  if (tier === 'simple' || approved) return { action: 'allow', message: '' };
  const why = triggers.join('; ');
  if (tier === 'moderate') {
    return { action: 'warn', message: `Planning tier: moderate (${why}). Run /second-opinion on the approach first, then: node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass --session-id=$CLAUDE_CODE_SESSION_ID` };
  }
  const how = 'Run the plan through /plan-review, record it with node scripts/lib/review-gate.mjs --query=record-plan --reviewer=plan-review --result=pass --session-id=$CLAUDE_CODE_SESSION_ID, and get the owner\'s yes (quote it as "OWNER-PLAN-APPROVED: <quote>" on the card and in the turn). A substantial new system is a product decision: "decide technical calls yourself" does not cover it.';
  const enforcing = mode === 'block' || (mode === 'auto' && now >= enforceAfter); // 'warn' never enforces
  if (mode === 'off') return { action: 'allow', message: '' };
  return enforcing
    ? { action: 'block', message: `Planning tier: SUBSTANTIAL (${why}) with no plan-review verdict or owner approval. ${how}` }
    : { action: 'warn', message: `Planning tier: SUBSTANTIAL (${why}), no plan-review verdict or owner approval yet. Advisory now; it blocks from ${new Date(enforceAfter).toISOString().slice(0, 10)}. ${how}` };
}

module.exports = { classify, decide, isApproved, secretsIn, ENFORCE_AFTER_MS, APPROVAL_TOKEN, VERDICT_TTL_MS, SUBSTANTIAL_NEW_FILES_IN_NEW_DIR };
