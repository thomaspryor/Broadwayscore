'use strict';

/**
 * opus-launch-check.js (BRO-6684): may this create_session run on Opus?
 *
 * The BRO-5228 hook let any Opus launch through with a free-text MODEL-REASON line, so
 * Opus parents started Opus children for P2 data chores the card policy put on Sonnet
 * (BRO-6259 $63, BRO-6481 $41, BRO-6541 $41; Oct 29-31 Opus was ~74% of Claude spend).
 * Now the hook re-runs the card policy itself (session-model.js: modelPicker + the daily
 * Opus budget + sessionModelFor) on the BRO-N ids in the title and tags. Opus is allowed when:
 *   - that policy says Opus for the session, or
 *   - the prompt has an `OWNER-ASKED-OPUS: <the owner's words>` line;
 * and the prompt's BUDGET is at most OPUS_MAX_BUDGET_H hours (a long Opus session is what
 * costs: BRO-6259 ran 2.5 days).
 * Fails open (no decision) when Linear can't be read in time. Kill switch: OPUS_BUDGET_DISABLED=1.
 */

const OPUS_MAX_BUDGET_H = 4;
const OWNER_RE = /(^|\n)\s*OWNER-ASKED-OPUS:[ \t]*\S/;
const BUDGET_RE = /(^|\n)\s*BUDGET:[ \t]*(\d+)h\b/;
// The whole hook gets 20s (settings.json) and the plan-only check after this one up to 14s.
const DEADLINE_MS = 5_000;

function isOpus(model) {
  return /^claude-opus-\d/.test(String(model || '').trim().toLowerCase());
}

// The session's cards: the id the title starts with ("BRO-N: <short>", CLOUD.md) and the bro-n tags.
// A follow-up id mentioned later in the title is not a card this session works on.
function cardIds(toolInput) {
  const lead = /^\s*(bro-\d+)\b/i.exec(String(toolInput.title || ''));
  const tags = (Array.isArray(toolInput.tags) ? toolInput.tags : []).filter((t) => /^bro-\d+$/i.test(String(t).trim()));
  return [...new Set([...(lead ? [lead[1]] : []), ...tags].map((s) => String(s).trim().toUpperCase()))];
}

/**
 * @param {object} input - PreToolUse hook JSON
 * @param {object} deps - { getIssue(id) -> issue, loadBudget() -> budget|null, env }
 * @returns {Promise<{deny:string}|null>}
 */
async function evaluate(input, deps) {
  const env = deps.env || process.env;
  const ti = (input && input.tool_input) || {};
  if (env.OPUS_BUDGET_DISABLED === '1' || !isOpus(ti.model)) return null;
  const prompt = String(ti.prompt || '');
  const how = 'Run `node scripts/session-model.js BRO-N` and pass its model, or put `OWNER-ASKED-OPUS: <the owner\'s words>` in the prompt when the owner asked for Opus (BRO-6684).';
  const b = BUDGET_RE.exec(prompt);
  if (b && Number(b[2]) > OPUS_MAX_BUDGET_H) {
    return { deny: `Blocked: an Opus worker session may run at most BUDGET: ${OPUS_MAX_BUDGET_H}h (this one says ${b[2]}h). Long Opus sessions are what used up the weekly limit (BRO-6684). Lower the BUDGET, or split the work.` };
  }
  if (OWNER_RE.test(prompt)) return null;
  const ids = cardIds(ti);
  if (!ids.length) {
    return { deny: `Blocked: this Opus session names no card (BRO-N in its title or tags), so nothing shows it needs Opus. Use Sonnet. ${how}` };
  }
  const { modelPicker, sessionModelFor } = require('./cloud-worker-pick.js');
  const issues = await Promise.all(ids.map((id) => deps.getIssue(id)));
  if (issues.some((i) => !i)) return null;
  const modelOf = modelPicker({ opusBudget: await deps.loadBudget() });
  const cards = issues.map((issue) => ({ identifier: issue.identifier, ...modelOf(issue) }));
  if (sessionModelFor(cards).opusCards === cards.length) return null;
  const why = cards.map((c) => `${c.identifier}: ${c.model} (${c.reason})`).join('; ');
  return { deny: `Blocked: the card policy puts this session on Sonnet, not Opus: ${why}. Start it on Sonnet; a card that truly needs Opus gets a "Model: Opus" line, P0 priority, or Opus on its retry. ${how}` };
}

async function evaluateWithDeadline(input, deps, ms = DEADLINE_MS) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([evaluate(input, deps).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toHookOutput(result) {
  if (!result || !result.deny) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.deny } };
}

module.exports = { OPUS_MAX_BUDGET_H, isOpus, cardIds, evaluate, evaluateWithDeadline, toHookOutput };
