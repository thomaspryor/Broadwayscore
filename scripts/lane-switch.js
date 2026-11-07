#!/usr/bin/env node
'use strict';
/**
 * BRO-6622: lane switch CLI, run by .github/workflows/opening-night-lane-switch.yml (cloud sessions cannot write repo
 * variables; they dispatch that workflow). Logic: scripts/lib/opening-night-lane/lane-switch.js.
 * Runbook: docs/opening-night-lane-switch-runbook.md.
 *
 *   set --variable=LANE_ONLY_MARKETS|LANE_STANDDOWN --value=V --reason=R --mode=live|dry-run
 *   clear --variable=LANE_ONLY_MARKETS|LANE_STANDDOWN --reason=R --mode=live|dry-run
 *       Any other variable name, an empty set value or an unknown market is refused (exit 2).
 *   rollback [--show=ID [--night=YYYY-MM-DD]] --reason=R --mode=live|dry-run|drill [--hard]
 *       LANE_STANDDOWN=all, delete LANE_ONLY_MARKETS, wait for the lane to stand down, cancel what still holds, release
 *       its lease, hand each show-night inside its press-night window to the old path once. --night defaults to the
 *       show's openingDate. --hard cancels at once (a hung lane) instead of waiting 15 min.
 *
 * Modes (always named, no default): live writes. dry-run reads the real variables, leases and runs and prints what live
 * would do (lease and claim transitions are evaluated against the real state, nothing is pushed). drill proves the
 * moving parts without touching anything real: it writes and deletes the scratch variable LANE_SWITCH_PROBE (VARS_TOKEN
 * can write variables), seeds a synthetic lease on opening-night-lane-drill, and runs the real lease release and
 * fallback claim against the drill branches twice (the second pass must not dispatch again). Run cancels and the
 * old-path dispatch stay dry in drill.
 * Env: VARS_TOKEN (variables read/write), GH_TOKEN (runs, dispatch), GITHUB_ACTOR, GITHUB_TRIGGERING_ACTOR,
 * GITHUB_RUN_ID, RUN_URL, REQUEST_ID, GITHUB_STEP_SUMMARY.
 * Live mode appends a row to data/audit/lane-switch.jsonl (the workflow commits it).
 * Exit: 0 all steps ok, 1 a step failed, 2 refused input.
 */
if (require.main === module) require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ls = require('./lib/opening-night-lane/lane-switch');
const af = require('./lib/opening-night-lane/auto-fallback');
const store = require('./lib/opening-night-lane/lease-store');
const { inPressNightWindow } = require('./lib/opening-night-lane/lane-only-markets');
const { oldPathDispatchArgs } = require('./lib/opening-night-lane/old-path-dispatch');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a === undefined ? null : a.slice(n.length + 3); };
const flag = (n) => argv.includes(`--${n}`) || arg(n) === 'true';
const repoDir = path.resolve(__dirname, '..');
const AUDIT_FILE = path.join(repoDir, 'data/audit/lane-switch.jsonl');
const log = (s) => console.log(s);
const NOTHING_CHANGED = 'NOTHING WAS CHANGED (this was not a live run).';

function sh(bin, args, { token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  return execFileSync(bin, args, { encoding: 'utf8', env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const errText = (e) => String((e && (e.stderr || e.message)) || e).replace(/\s+/g, ' ').slice(0, 200);

/** {ok:true, value} or {ok:false} (read failed: unknown, never "unset"). */
function readVar(name) {
  try {
    const value = sh('bash', [path.join(repoDir, 'scripts/lib/read-actions-variable.sh'), name], { token: process.env.VARS_TOKEN });
    return { ok: true, value: value.trim() };
  } catch (e) {
    log(`::warning::could not read ${name}: ${errText(e)}`);
    return { ok: false };
  }
}

/** Write (empty value = delete), then re-read: a write that did not stick is a failure. */
function writeVar(name, value) {
  try {
    if (value) sh('gh', ['variable', 'set', name, '--body', value], { token: process.env.VARS_TOKEN });
    else {
      try { sh('gh', ['variable', 'delete', name], { token: process.env.VARS_TOKEN }); } catch (e) {
        if (!/404|not found/i.test(errText(e))) throw e;
      }
    }
  } catch (e) { return { ok: false, detail: errText(e) }; }
  const back = readVar(name);
  if (!back.ok) return { ok: false, detail: 'written but the re-read failed' };
  if (back.value !== value) return { ok: false, detail: `re-read shows "${back.value}"` };
  return { ok: true };
}

/** In-flight and recent night runs of the lane, or null when the list cannot be read. */
function listNightRuns() {
  try {
    return JSON.parse(sh('gh', ['run', 'list', '--workflow=opening-night-lane-live.yml', '--limit=100', '--json', 'databaseId,displayTitle,status']));
  } catch (e) { log(`::warning::lane run list failed: ${errText(e)}`); return null; }
}

/** Lease-format state of a branch, or {unknown:true}. */
function readLeases(branch) {
  try { return store.readRemote({ repoDir: process.cwd(), branch }).state; } catch (e) {
    log(`::warning::lease state unreadable on ${branch}: ${errText(e)}`);
    return { unknown: true };
  }
}

let showsCache;
function findShow(id) {
  try {
    if (!showsCache) { const raw = JSON.parse(fs.readFileSync(path.join(repoDir, 'data/shows.json'), 'utf8')); showsCache = Array.isArray(raw.shows) ? raw.shows : raw; }
    return showsCache.find((x) => x.id === id || x.slug === id) || null;
  } catch { return null; }
}

/** Runs fn against the branch's current state without pushing (dry-run). */
function evaluate(branch, fn) {
  const state = readLeases(branch);
  if (state.unknown) return { ok: false, reason: 'state-unreadable' };
  const out = fn(state);
  return { ...out, state: undefined, released: out.ok ? false : undefined };
}

function casOn(branch, message) {
  return (fn) => {
    try { return store.casTransition({ repoDir: process.cwd(), branch, message }, fn); } catch (e) {
      return { ok: false, reason: `write failed: ${errText(e)}` };
    }
  };
}

function ports(mode, { leaseBranch, fallbackBranch, tag }) {
  const live = mode === 'live';
  const dryLease = mode === 'dry-run';
  return {
    setVar: (n, v) => (live ? writeVar(n, v) : (log(`${mode}: would set ${n}=${v}`), { ok: true })),
    deleteVar: (n) => (live ? writeVar(n, '') : (log(`${mode}: would delete ${n}`), { ok: true })),
    readLeaseState: () => readLeases(leaseBranch),
    listNightRuns: () => (mode === 'drill' ? [] : listNightRuns()),
    cancelRun: (id) => {
      if (!live) { log(`${mode}: would cancel run ${id}`); return { ok: true }; }
      try { sh('gh', ['run', 'cancel', String(id)]); return { ok: true }; } catch (e) {
        // Finished between list and cancel: nothing left to stop.
        if (/completed|already/i.test(errText(e))) return { ok: true };
        return { ok: false, detail: errText(e) };
      }
    },
    release: dryLease ? (fn) => evaluate(leaseBranch, fn) : casOn(leaseBranch, `opening-night lease: lane switch rollback released (BRO-6622${tag})`),
    claim: dryLease ? (fn) => evaluate(fallbackBranch, fn) : casOn(fallbackBranch, `opening-night lane fallback claim: lane switch rollback (BRO-6622${tag})`),
    dispatchOldPath: (showId) => {
      const args = oldPathDispatchArgs(findShow(showId) || { id: showId });
      if (!live) { log(`${mode}: would run gh ${args.join(' ')}`); return true; }
      try { sh('gh', args); return true; } catch (e) {
        log(`::warning::old-path dispatch failed: ${errText(e)}`);
        return false;
      }
    },
    // A show missing from shows.json is dispatched anyway: fail toward publishing.
    inWindow: (showId, night, nowMs) => (mode === 'drill' ? true : (() => { const s = findShow(showId); return !s || inPressNightWindow(s, night, nowMs); })()),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log,
  };
}

function writeAudit(row) {
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n');
  log(`audit row: ${JSON.stringify(row)}`);
}

function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, lines.join('\n') + '\n');
  log(lines.join('\n'));
}

function common(mode, reason, modes) {
  if (!modes.includes(mode)) { log(`::error::--mode is required: one of ${modes.join(', ')}`); return null; }
  if (!String(reason || '').trim()) { log('::error::--reason is required (who asked and why)'); return null; }
  return {
    actor: process.env.GITHUB_ACTOR || null, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR || null,
    runId: process.env.GITHUB_RUN_ID || null, runUrl: process.env.RUN_URL || null, requestId: process.env.REQUEST_ID || arg('request-id') || null,
  };
}

function pausedNote() {
  const p = readVar('ORCHESTRATOR_PAUSED');
  return p.ok && p.value ? `ORCHESTRATOR_PAUSED is set ("${p.value}"): the old path will not publish until it is cleared.` : null;
}

function cmdSwitch(action) {
  const mode = arg('mode') || '';
  const who = common(mode, arg('reason'), ['live', 'dry-run']);
  if (!who) return 2;
  const v = ls.validateSwitch({ action, variable: arg('variable'), value: arg('value') });
  if (!v.ok) { log(`::error::${v.reason}`); return 2; }
  const before = readVar(v.variable);
  const from = before.ok ? before.value : 'unknown';
  let r = { ok: true };
  if (mode === 'live') r = writeVar(v.variable, v.value);
  const change = { variable: v.variable, op: v.op, from, to: v.value };
  if (mode === 'live') writeAudit(ls.auditRow({ action, mode, reason: arg('reason'), ...who, changes: [change], ok: r.ok }));
  const undo = from === 'unknown' ? 'unknown (the old value could not be read)' : (from ? `set ${v.variable}=${from}` : `clear ${v.variable}`);
  const paused = pausedNote();
  summary([`### Lane switch: ${action} ${v.variable} (${mode})`, '', `${v.variable}: \`${from || '(unset)'}\` -> \`${v.value || '(unset)'}\``, '',
    `Reason: ${arg('reason')}`, '', `To undo: ${undo}`, ...(paused ? ['', `Warning: ${paused}`] : []), '',
    r.ok ? `Result: ok${mode === 'live' ? '' : `. ${NOTHING_CHANGED}`}` : `Result: FAILED (${r.detail})`]);
  if (!r.ok) { log(`::error::${v.variable} write failed: ${r.detail}`); return 1; }
  return 0;
}

/** Drill only: VARS_TOKEN can create, read back and delete a variable (the one write a real rollback needs). */
function probeVarWrite() {
  const value = `drill-${process.env.GITHUB_RUN_ID || process.pid}`;
  const set = writeVar(ls.PROBE_VARIABLE, value);
  const del = writeVar(ls.PROBE_VARIABLE, '');
  return [['VARS_TOKEN can set a variable (read back)', set.ok, set.detail], ['VARS_TOKEN can delete a variable (read back)', del.ok, del.detail]];
}

async function cmdRollback() {
  const mode = arg('mode') || '';
  const who = common(mode, arg('reason'), ls.MODES);
  if (!who) return 2;
  const drill = mode === 'drill';
  const tag = drill ? ', drill' : '';
  const leaseBranch = drill ? ls.DRILL_LEASE_BRANCH : store.DEFAULT_BRANCH;
  const fallbackBranch = drill ? ls.DRILL_FALLBACK_BRANCH : af.FALLBACK_BRANCH;
  let show = arg('show') || '';
  let night = arg('night') || '';
  // Leases, run titles and the old-path dispatch all use the show id, so a slug given here becomes the id.
  const known = show && !drill ? findShow(show) : null;
  if (known) show = known.id;
  if (show && !night && !drill) {
    if (!known || !known.openingDate) { log(`::error::--night is required: ${show} has no openingDate in shows.json`); return 2; }
    night = known.openingDate;
  }
  if (drill) {
    night = new Date().toISOString().slice(0, 10);
    show = ls.DRILL_SHOW;
    const seeded = casOn(leaseBranch, 'opening-night lease: drill seed (BRO-6622)')(() => ({ ok: true, state: ls.drillLeaseState({ night }) }));
    if (!seeded.ok) { log(`::error::drill: could not seed the synthetic lease on ${leaseBranch} (${seeded.reason})`); return 1; }
    log(`drill: seeded synthetic lease ${show}|${night} held by ${ls.DRILL_HOLDER} on ${leaseBranch}`);
    // An earlier drill the same day left its claim marked dispatched; clear it so this drill proves the dispatch again.
    const cleared = casOn(fallbackBranch, 'opening-night fallback: drill reset (BRO-6622)')((st) => {
      const leases = { ...((st && st.leases) || {}) };
      delete leases[`${show}|${night}`];
      return { ok: true, state: { ...(st || {}), leases } };
    });
    if (!cleared.ok) { log(`::error::drill: could not clear the drill claim on ${fallbackBranch} (${cleared.reason})`); return 1; }
  }
  // Drill reads its variables but never writes them: the probe below is its only variable write.
  const vars = { onlyMarkets: readVar('LANE_ONLY_MARKETS'), standdown: readVar('LANE_STANDDOWN') };
  const p = ports(mode, { leaseBranch, fallbackBranch, tag });
  let plan;
  try { plan = ls.planRollback({ show: show || undefined, night: night || undefined, vars, leaseState: p.readLeaseState(), laneRuns: p.listNightRuns() }); } catch (e) {
    log(`::error::${e.message}`); return 2;
  }
  // A mistyped --show would skip the real show's lease and start the old path for nothing. One the lane holds or
  // runs is still rolled back even when shows.json lags.
  if (show && !drill && !known && !plan.targets.some((t) => t.holder || t.runIds.length)) {
    log(`::error::refused: ${show} is not in data/shows.json and has no live lease or lane night run (typo?)`); return 2;
  }
  plan.warnings.forEach((w) => log(`::warning::${w}`));
  log(`rollback plan (${mode}): variables ${plan.varSteps.map(ls.describeStep).join('; ') || 'already rolled back'}; ` +
    `targets ${plan.targets.map((t) => `${t.show}|${t.night} holder=${t.holder || '-'} runs=${t.runIds.join(',') || '-'}`).join('; ') || 'none'}`);
  const holder = `rollback:${who.runId || process.pid}`;
  // Drill: the synthetic lease never stands down by itself, so skip the wait (hard) and go straight to the release.
  const res = await ls.executeRollback(plan, p, { holder, hard: drill || flag('hard'), wait: mode === 'live' });
  let ok = res.ok && !plan.warnings.some((w) => /unreadable/.test(w));
  const restore = ls.restoreCalls(plan.varSteps);
  const paused = drill ? null : pausedNote();
  const lines = [`### Lane switch: rollback (${mode})`, '', `Reason: ${arg('reason')}`, '',
    ...res.results.map((r) => `- ${r.ok ? 'ok' : '**FAILED**'}: ${ls.describeStep(r.step)} (${r.note})`), ...plan.warnings.map((w) => `- warning: ${w}`),
    '', 'LANE_STANDDOWN=all now holds every later lane night too. To put the variables back as they were:',
    ...restore.map((c) => `- ${c}`),
    ...plan.varSteps.filter((s) => s.from === 'unknown').map((s) => `- ${s.variable}: old value unreadable, see the last row for it in data/audit/lane-switch.jsonl`),
    ...(plan.varSteps.length ? [] : ['- nothing to restore (they were already rolled back)']),
    ...(paused ? ['', `Warning: ${paused}`] : [])];
  if (drill) {
    const leaseState = readLeases(leaseBranch);
    const claimState = readLeases(fallbackBranch);
    const leaseLeft = leaseState.unknown ? 'unreadable' : (leaseState.leases || {})[`${show}|${night}`];
    const claim = (claimState.leases || {})[`${show}|${night}`];
    let dispatches = 0;
    const again = await ls.executeRollback(ls.planRollback({ show, night, vars, leaseState: readLeases(leaseBranch), laneRuns: [] }),
      { ...p, setVar: () => ({ ok: true }), deleteVar: () => ({ ok: true }), dispatchOldPath: (s) => { dispatches += 1; return p.dispatchOldPath(s); } },
      { holder: `${holder}-second`, hard: true, wait: false });
    const checks = [
      ...probeVarWrite(),
      ['synthetic lease released', !leaseLeft],
      ['fallback claim marked dispatched', !!(claim && claim.dispatched && claim.holder === holder)],
      ['second pass dispatched nothing', again.ok && dispatches === 0],
    ];
    checks.forEach(([name, pass, detail]) => log(`drill check: ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`));
    lines.push('', '#### Drill checks', ...checks.map(([name, pass, detail]) => `- ${pass ? 'PASS' : '**FAIL**'}: ${name}${detail ? ` (${detail})` : ''}`));
    ok = ok && checks.every(([, pass]) => pass);
  }
  if (mode === 'live') {
    const changes = res.results.map((r) => ({ ...r.step, ok: r.ok, note: r.note }));
    writeAudit(ls.auditRow({ action: 'rollback', mode, reason: arg('reason'), ...who, changes, ok }));
  } else lines.push('', NOTHING_CHANGED.replace('.', drill ? ' (only the drill branches and the probe variable were written).' : '.'));
  summary(lines);
  log(ok ? 'rollback: all steps ok' : '::error::rollback: a step failed; read the lines above and re-run the rollback');
  return ok ? 0 : 1;
}

async function main() {
  if (cmd === 'set' || cmd === 'clear') return cmdSwitch(cmd);
  if (cmd === 'rollback') return cmdRollback();
  console.error('usage: lane-switch.js set|clear|rollback (see the header)');
  return 2;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.log(`::error::lane-switch: ${e && e.message}`); process.exit(1); });
