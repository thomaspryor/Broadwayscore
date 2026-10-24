'use strict';
/**
 * Codex lane data fixes (BRO-6175). A Codex card whose fix is private data goes through the
 * reviewed route in .claude/CLOUD.md "Fixing private data": Codex writes data/pending-fixes/bro-N.json
 * (public repo, no review text), the Claude check reviews it like code, it lands, and the RUNNER (never
 * Codex: this code runs in the runner process, with its GitHub token) dispatches execute-approved-fix.yml
 * mode=apply and checks the plan file on main. Kill switch: CODEX_DATA_FIXES_DISABLED=1.
 *
 * Plans written by a Codex run get no owner approval link (a bro-* plan has none), so the runner only
 * applies the field-level action types the executor guards with its own allowlists (CODEX_PLAN_ACTIONS).
 * Anything else stays with the Claude lane.
 */
const { MAX_PLAN_ACTIONS } = require('./pending-fix-limits.js');

const dataFixesEnabled = (env = process.env) => !/^(1|true|yes)$/i.test(String(env.CODEX_DATA_FIXES_DISABLED || ''));

// Executor-allowlisted field edits only. Not allowed: run-script, add-show, retire-show, review-file-op,
// add-commercial-entry, ingest-html-handoff (owner or Claude judgment, or they move whole files/rows).
const CODEX_PLAN_ACTIONS = new Set(['data-edit', 'review-field-edit', 'drop-orphan-key', 'retitle-show', 'outlet-registry-flag']);

/** Plan file names (no dir) for a card: bro-6175.json, bro-6175-b.json. Case-insensitive on the id. */
function cardPlanFiles(names, cardId) {
  const id = String(cardId || '').toLowerCase();
  if (!/^bro-\d+$/.test(id)) return [];
  const re = new RegExp(`^${id}(?:-[a-z0-9]+)?\\.json$`);
  return (names || []).map((n) => String(n).replace(/^.*\//, '')).filter((n) => re.test(n)).sort();
}

/** -> null when the runner may apply this plan unattended, else why not. */
function codexPlanAllowed(plan) {
  const actions = plan && plan.plan && plan.plan.actions;
  if (!Array.isArray(actions) || !actions.length) return 'the plan has no actions';
  if (actions.length > MAX_PLAN_ACTIONS) return `${actions.length} actions (limit ${MAX_PLAN_ACTIONS})`;
  const bad = [...new Set(actions.map((a) => a && a.type).filter((t) => !CODEX_PLAN_ACTIONS.has(t)))];
  return bad.length ? `action type(s) the Codex lane may not apply: ${bad.join(', ')}` : null;
}

/** -> null when the plan on main was applied by CI, else what it says instead. */
function planNotApplied(plan, { legacyOk = false } = {}) {
  // legacyOk: a plan applied before the executor tagged executedIn (BRO-5647) reads as applied; "local" never does.
  if (plan && plan.status === 'applied' && (plan.executedIn === 'ci' || (legacyOk && !plan.executedIn))) return null;
  const r = plan && Array.isArray(plan.results) ? plan.results.filter((x) => x && x.status && x.status !== 'applied' && x.status !== 'ok').length : 0;
  return `status "${plan && plan.status}"${plan && plan.executedIn ? ` (executedIn ${plan.executedIn})` : ''}${r ? `, ${r} action result(s) not applied` : ''}`;
}

const PLAN_DIR = 'data/pending-fixes';

/**
 * Apply every plan the card landed on main. io: { git(args) -> stdout (throws on failure),
 * dispatch(args) -> { code, out }, log(msg) }. -> { kind: 'none' } | { kind: 'applied', files, lines } |
 * { kind: 'failed', why, lines }. A plan already applied by CI counts as applied (a re-run after a
 * crash); a plan in any other finished state, or one the allowlist refuses, is a failure.
 */
async function applyCardFixPlans(cardId, io, { rebuild = true } = {}) {
  io.git(['fetch', '-q', 'origin', 'main']);
  const names = io.git(['ls-tree', '--name-only', 'origin/main', `${PLAN_DIR}/`]).split('\n').filter(Boolean);
  const files = cardPlanFiles(names, cardId);
  if (!files.length) return { kind: 'none' };
  const read = (f) => JSON.parse(io.git(['show', `origin/main:${PLAN_DIR}/${f}`]));
  const lines = [];
  const fail = (why) => ({ kind: 'failed', why, lines });
  for (const f of files) {
    let plan;
    try { plan = read(f); } catch (e) { return fail(`${f} is not readable on main: ${String(e.message).split('\n')[0]}`); }
    const refused = codexPlanAllowed(plan);
    if (refused && plan.status !== 'applied') return fail(`${f}: ${refused}`);
    let ranHere = false;
    if (plan.status === 'pending') {
      ranHere = true;
      if (!plan.planId) return fail(`${f} has no planId`);
      io.log(`${cardId}: applying ${f}`);
      const r = await io.dispatch(['execute-approved-fix.yml', '-f', `issue_number=${plan.issueNumber || f.replace(/\.json$/, '')}`, '-f', `plan_id=${plan.planId}`, '-f', 'mode=apply', '--wait', '--timeout=50']);
      lines.push(`${f}: apply run exit ${r.code}`);
      if (r.code !== 0) return fail(`${f}: the apply run did not succeed (exit ${r.code}): ${String(r.out || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
      io.git(['fetch', '-q', 'origin', 'main']);
      plan = read(f);
    }
    const why = planNotApplied(plan, { legacyOk: !ranHere });
    if (why) return fail(`${f} on main is not applied: ${why}`);
    lines.push(`${f}: applied by CI`);
  }
  if (rebuild) {
    // Same call CLOUD.md step 4 makes; rebuilds coalesce, and a failed dispatch only delays the data to the next rebuild.
    try { const r = await io.dispatch(['rebuild-fast.yml']); lines.push(`rebuild-fast.yml dispatched (exit ${r.code})`); } catch { lines.push('rebuild-fast.yml dispatch failed; the next scheduled rebuild picks the data up'); }
  }
  return { kind: 'applied', files, lines };
}

module.exports = { dataFixesEnabled, CODEX_PLAN_ACTIONS, cardPlanFiles, codexPlanAllowed, planNotApplied, applyCardFixPlans };
