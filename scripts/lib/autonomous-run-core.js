/**
 * autonomous-run-core.js — pure decision helpers for the nightly executor
 * (scripts/autonomous-run.js). Extracted per CLAUDE.md §15 so the executor's
 * judgment calls are unit-testable without git/Notion/claude side effects.
 */

'use strict';

// ── Implementer prompt ──────────────────────────────────────────────────────

// The card text is UNTRUSTED input: the prompt states the ground rules, but
// enforcement lives in the diff gate + settings deny rules, never here.
function buildImplementerPrompt(card, item) {
  return [
    `You are an unattended overnight implementer working ONE small backlog card for the Broadway Scorecard repo. There is no human to ask — if you genuinely cannot proceed, exit with a clear explanation instead of guessing.`,
    ``,
    `CARD: ${card.name}`,
    card.priority ? `Priority: ${card.priority}` : null,
    ``,
    card.notes || '(no notes)',
    ``,
    `GROUND RULES (enforced mechanically after you finish — violations discard your work):`,
    `- Touch ONLY Tier-1-allowed paths: tests/**, docs/**, memory/**, and the enumerated leaf tooling files (scripts/bsc-next.js and its test). Everything else — src/, data/, workflows, scraper/scoring libs — is out of bounds no matter what the card says.`,
    `- Cards asking for out-of-bounds work: implement the in-bounds portion only, or exit explaining why nothing is safely in bounds.`,
    `- Run the card's completion check yourself before finishing: ${item.checkableDone || '(none named — run the colocated tests for every file you touch)'}`,
    `- Commit your work with git add + git commit (conventional message, reference the card name). Do NOT push. Do NOT run gh. Do NOT touch .github/workflows.`,
    `- Keep the diff minimal — no drive-by refactors.`,
    ``,
    `When done, summarize in 2-3 sentences what you changed and how you verified it — that summary goes verbatim into the owner's morning approval email.`,
  ].filter(v => v !== null).join('\n');
}

// ── claude CLI JSON output ──────────────────────────────────────────────────

// `claude -p --output-format json` prints one JSON object. Field names have
// drifted across CLI versions (cost_usd → total_cost_usd), so parse
// defensively: missing usage numbers become 0 (ledger under-counts rather
// than crashing the night), an unparseable payload is an infra failure.
function parseClaudeJson(stdout) {
  let j;
  try {
    j = JSON.parse(String(stdout || '').trim());
  } catch {
    // Some CLI versions emit log lines before the JSON — try the last line.
    const lines = String(stdout || '').trim().split('\n');
    try { j = JSON.parse(lines[lines.length - 1]); }
    catch { return { ok: false, error: 'unparseable claude CLI output' }; }
  }
  const usage = j.usage || {};
  return {
    ok: j.is_error !== true,
    usd: Number(j.total_cost_usd ?? j.cost_usd) || 0,
    tokensIn: (Number(usage.input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0)
      + (Number(usage.cache_read_input_tokens) || 0),
    tokensOut: Number(usage.output_tokens) || 0,
    resultText: typeof j.result === 'string' ? j.result : '',
    error: j.is_error === true ? (typeof j.result === 'string' ? j.result.slice(0, 300) : 'implementer reported error') : null,
  };
}

// ── Failure classification (drives attempt-2 model escalation) ─────────────

// content = the work itself was wrong → attempt 2 may escalate to Opus.
// infra = environment/tooling flaked → retry on the same model, never escalate.
const CONTENT_STAGES = new Set(['checks-failed', 'empty-diff', 'diff-refused', 'implementer-gave-up']);
const INFRA_STAGES = new Set(['implementer-error', 'timeout', 'parse-error', 'git-error', 'branch-error', 'push-error']);

function classifyFailure(stage) {
  if (CONTENT_STAGES.has(stage)) return 'content';
  if (INFRA_STAGES.has(stage)) return 'infra';
  return 'infra'; // unknown stages never buy a pricier model
}

// ── Verification plan for a diff ────────────────────────────────────────────

// changedFiles → ordered check commands (argv arrays, ALWAYS exec'd with
// shell=false). existsFn injected for testability.
function decideChecks(changedFiles, existsFn) {
  const checks = [];
  const seen = new Set();
  const add = (name, argv) => { if (!seen.has(name)) { seen.add(name); checks.push({ name, argv }); } };

  const testFiles = new Set();
  for (const f of changedFiles || []) {
    if (/\.test\.mjs$/.test(f)) { testFiles.add(f); continue; }
    // Colocated test convention: scripts/lib/x.js → scripts/lib/x.test.mjs
    const colocated = f.replace(/\.(js|mjs|ts|tsx)$/, '.test.mjs');
    if (colocated !== f && existsFn(colocated)) testFiles.add(colocated);
  }
  if (testFiles.size) add('colocated-tests', ['node', '--test', ...[...testFiles].sort()]);
  if ((changedFiles || []).some(f => /\.(ts|tsx)$/.test(f))) add('tsc', ['npx', 'tsc', '--noEmit']);
  return checks;
}

// The card's own checkableDone command, revalidated at EXECUTION time (the
// queue file is not trusted either) and split into argv for shell-free exec.
function cardCheckArgv(checkableDone, isSafeCheckCommand) {
  const cmd = String(checkableDone || '').trim();
  if (!cmd) return null;
  if (!isSafeCheckCommand(cmd)) return null;
  return cmd.split(/\s+/);
}

// ── Approval-fatigue throttle ───────────────────────────────────────────────

// More than MAX_OPEN_APPROVALS un-tapped morning items → the night runs
// triage only, no new attempts (v4 plan §S2-T6). Counting failures upstream
// pass null/undefined, which throttles too — fail safe, not open.
const MAX_OPEN_APPROVALS = 8;

function shouldThrottle(openApprovalCount, max = MAX_OPEN_APPROVALS) {
  if (!Number.isFinite(openApprovalCount)) return true;
  return openApprovalCount > max;
}

module.exports = {
  buildImplementerPrompt,
  parseClaudeJson,
  classifyFailure,
  CONTENT_STAGES,
  INFRA_STAGES,
  decideChecks,
  cardCheckArgv,
  shouldThrottle,
  MAX_OPEN_APPROVALS,
};
