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

/**
 * Can THIS process dispatch execute-approved-fix.yml / rebuild-fast.yml (BRO-6194)? Only the GHA lane has shown it
 * can (codex-runner.yml has `actions: write`; bro-4937 was applied by github-actions[bot]). The cloud-routine slots
 * have no documented dispatch credential, so route cards stay off them unless CODEX_CAN_DISPATCH=1 (the Board workers routine sets it on its Codex runner, BRO-6260).
 */
const canDispatchWorkflows = (env = process.env) => env.GITHUB_ACTIONS === 'true' || /^(1|true|yes)$/i.test(String(env.CODEX_CAN_DISPATCH || ''));

/**
 * Should reconcileLanded skip a card? A deferred data-fix apply is for a runner that can dispatch (a cloud slot
 * re-reading it would only defer again); onlyDeferred is the GHA lane's base slot, which leaves everything else to slot 0.
 * canDispatch here is canReconcileDeferred(): only the GHA lane retries deferred applies, even though the cloud lane can
 * now dispatch its own (BRO-6260 review: two lanes re-dispatching one card race on the executor's per-issue queue).
 */
const canReconcileDeferred = (env = process.env) => env.GITHUB_ACTIONS === 'true';
const reconcileSkips = ({ deferred, onlyDeferred, canDispatch }) => (deferred ? !canDispatch : !!onlyDeferred);

// Executor-allowlisted field edits only. Not allowed: run-script, add-show, retire-show, review-file-op,
// add-commercial-entry, ingest-html-handoff (owner or Claude judgment, or they move whole files/rows).
const CODEX_PLAN_ACTIONS = new Set(['data-edit', 'review-field-edit', 'drop-orphan-key', 'retitle-show', 'outlet-registry-flag', 'coverage-expectation-redecide', 'outlet-registry-alias']);

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

// execute-approved-fix.yml has timeout-minutes 45 (pinned by a test); the wait adds slack for a queued run.
const EXECUTOR_TIMEOUT_MIN = 45;
const APPLY_WAIT_MIN = EXECUTOR_TIMEOUT_MIN + 10;

/**
 * Plan files the card's latest plan-bearing runner landing touched, or null when that cannot be told
 * (every plan is then judged). A finished plan from an earlier attempt is not this landing's to apply.
 */
function latestLandingPlans(io, cardId) {
  try {
    const out = io.git(['log', '-1', '--name-only', '--format=', 'origin/main', '--author=Codex runner', '-F', `--grep=fix(${String(cardId).toUpperCase()}):`, '--', `${PLAN_DIR}/`]);
    const names = out.split('\n').map((x) => x.trim().replace(/^.*\//, '')).filter(Boolean);
    return names.length ? new Set(names) : null;
  } catch { return null; }
}

/**
 * Apply every plan the card landed on main. io: { git(args) -> stdout (throws on failure),
 * dispatch(args) -> { code, out }, log(msg) }. -> { kind: 'none' } | { kind: 'applied', files, lines } |
 * { kind: 'failed', why, lines }. A plan already applied by CI counts as applied (a re-run after a
 * crash); a plan in any other finished state, or one the allowlist refuses, is a failure.
 */
// An "applied" status is a field Codex can type, so it only counts when the executor workflow's own commit
// is the last one to touch the plan file on main (BRO-6175 review).
const EXECUTOR_SUBJECT_RE = /^fix\(data\): Execute approved fix\b/;
function executorWroteLast(io, f) {
  try {
    const [author, subject] = io.git(['log', '-1', '--format=%an%x09%s', 'origin/main', '--', `${PLAN_DIR}/${f}`]).trim().split('\t');
    return /github-actions/i.test(author || '') && EXECUTOR_SUBJECT_RE.test(subject || '');
  } catch { return false; }
}

// applyWaitMin: how long the apply run may be waited for. The cloud lane passes what is left before its hard stop
// (BRO-6260: the routine kills the runner at 120 min); under a minute defers the apply to the next reconcile.
async function applyCardFixPlans(cardId, io, { rebuild = true, dispatch = true, canDispatch = true, applyWaitMin = APPLY_WAIT_MIN } = {}) {
  io.git(['fetch', '-q', 'origin', 'main']);
  const names = io.git(['ls-tree', '--name-only', 'origin/main', `${PLAN_DIR}/`]).split('\n').filter(Boolean);
  const files = cardPlanFiles(names, cardId);
  if (!files.length) return { kind: 'none' };
  const read = (f) => JSON.parse(io.git(['show', `origin/main:${PLAN_DIR}/${f}`]));
  const landing = latestLandingPlans(io, cardId);
  const lines = [];
  const fail = (why) => ({ kind: 'failed', why, lines });
  // deferred: nothing is wrong with the card, the apply just has not happened (yet) from this process.
  const defer = (why) => ({ kind: 'deferred', why, lines });
  const handled = [];
  for (const f of files) {
    let plan;
    try { plan = read(f); } catch (e) { return fail(`${f} is not readable on main: ${String(e.message).split('\n')[0]}`); }
    // A finished-but-not-applied plan (partial, rejected, validation-failed) this card's latest landing did not touch is
    // an earlier attempt's leftover: it neither blocks the card nor gets re-run.
    if (landing && !landing.has(f) && plan.status !== 'pending' && plan.status !== 'applied') {
      lines.push(`${f}: skipped, left by an earlier attempt (status "${plan.status}")`);
      continue;
    }
    const refused = codexPlanAllowed(plan);
    if (refused && plan.status !== 'applied') return fail(`${f}: ${refused}`);
    let ranHere = false;
    if (plan.status === 'pending') {
      if (!dispatch) return fail(`${f} is pending and the Codex data-fix route is switched off (CODEX_DATA_FIXES_DISABLED)`);
      if (!canDispatch) return defer(`${f} is pending and this runner cannot dispatch workflows; the GHA Codex lane applies it`);
      if (!(applyWaitMin >= 1)) return defer(`${f} is pending and this run has no time left to wait for the apply; the next reconcile applies it`);
      ranHere = true;
      if (!plan.planId) return fail(`${f} has no planId`);
      io.log(`${cardId}: applying ${f}`);
      const r = await io.dispatch(['execute-approved-fix.yml', '-f', `issue_number=${f.replace(/\.json$/, '')}`, '-f', `plan_id=${plan.planId}`, '-f', 'mode=apply', '--wait', `--timeout=${Math.min(APPLY_WAIT_MIN, Math.floor(applyWaitMin))}`]);
      lines.push(`${f}: apply run exit ${r.code}`);
      io.git(['fetch', '-q', 'origin', 'main']);
      plan = read(f);
      if (r.code !== 0) {
        // The run may have finished (or still be running) without the wait seeing it: main is the judge.
        const applied = planNotApplied(plan) === null && executorWroteLast(io, f);
        if (!applied) {
          const detail = String(r.out || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
          // Exit 2 is "run state unknown" (timeout, API trouble, run not found): not a verdict on the plan.
          if (r.code === 2 && plan.status === 'pending') return defer(`${f}: the apply run's outcome is unknown (exit 2) and the plan is still pending on main: ${detail}`);
          return fail(`${f}: the apply run did not succeed (exit ${r.code}): ${detail}`);
        }
        lines.push(`${f}: the run reported exit ${r.code}, but main shows the executor applied it`);
      }
    }
    const why = planNotApplied(plan, { legacyOk: !ranHere });
    if (why) return fail(`${f} on main is not applied: ${why}`);
    if (!executorWroteLast(io, f)) return fail(`${f} says applied, but the executor workflow did not write that status (last commit on the file is not its own)`);
    lines.push(`${f}: applied by CI`);
    handled.push(f);
  }
  if (!handled.length) return { kind: 'none', lines };
  if (rebuild && canDispatch) {
    // Same call CLOUD.md step 4 makes; rebuilds coalesce, and a failed dispatch only delays the data to the next rebuild.
    try { const r = await io.dispatch(['rebuild-fast.yml']); lines.push(`rebuild-fast.yml dispatched (exit ${r.code})`); } catch { lines.push('rebuild-fast.yml dispatch failed; the next scheduled rebuild picks the data up'); }
  }
  return { kind: 'applied', files: handled, lines };
}

module.exports = { dataFixesEnabled, reconcileSkips, canReconcileDeferred, canDispatchWorkflows, EXECUTOR_TIMEOUT_MIN, APPLY_WAIT_MIN, latestLandingPlans, CODEX_PLAN_ACTIONS, cardPlanFiles, codexPlanAllowed, planNotApplied, applyCardFixPlans };
