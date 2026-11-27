#!/usr/bin/env node
/**
 * land-timing-report.js — how long land.yml takes to say yes or no (BRO-7150).
 *
 * On 2026-11-08 a set of small fixes took ~4.5 h to reach main, ~2h40m of it waiting on
 * land.yml: two refusals came only after 31 and 19 minutes, both from cheap repo-wide
 * invariant tests. This report measures the two numbers that matter, from the GitHub API:
 *
 *   time-to-refusal  run start -> the refusing job finished (a land.yml run that failed)
 *   time-to-land     run start -> the Land job finished green (the change is on main)
 *
 * and ranks the refusal causes, read from the failing job's annotations
 * ("<gate>: NEW failure on the branch ...: <file>::<test>", "lint-workflows gate failed: X",
 * "checks RED — first failing gate: X", a failed rebase step, a refused landing).
 *
 * Runs are split into "before" and "after" the fast-fail stage: a run whose Checks job has a
 * step named "Fast-fail ..." (land.yml, BRO-7150) is "after". --split=<ISO time> overrides.
 *
 * Usage: node scripts/lib/land-timing-report.js [--days=7] [--json] [--split=<ISO>] [--repo=owner/name] [--check-targets]
 *        node scripts/lib/land-timing-report.js --gates [--days=7] [--json]
 * --gates (BRO-7324): no API. Reads the `timing` field land.yml writes on each row of
 *   data/audit/landings.jsonl (scripts/lib/land-gate-timing.js) and prints, per run kind
 *   (land-gauntlet/branch, land-gauntlet/base, land-fast/branch, ...), the median/min/max
 *   wall seconds and per-gate seconds over full (unscoped) runs. Gate seconds overlap
 *   (the background lane runs beside the main lane), so they are never summed.
 * --check-invariants: exit 1 when a test file behind 3+ refusals is missing from land-fast-tests.js INVARIANT_TESTS.
 * --check-targets: exit 1 unless the trailing window meets TARGETS (the BRO-7150 acceptance check).
 * Needs GH_TOKEN or GITHUB_TOKEN (read-only API calls; about 1 + runs + failed runs).
 * Exit: 0 report printed (targets met with --check-targets) | 1 API failure or targets missed | 2 usage
 */
'use strict';

const DEFAULT_REPO = 'thomaspryor/Broadwayscore';
const FAST_STEP_RE = /^Fast-fail\b/;

/** Median of a numeric array (null when empty). */
function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Nearest-rank percentile (p in 0..100) of a numeric array (null when empty). */
function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/**
 * Targets for the trailing window (BRO-7150, chosen from the 2026-11-08 baseline:
 * refusal rate 21.8%, median refusal 24.3 min, median land 27.9 min). The fast-fail
 * step moves time-to-refusal; the pre-push fast tests move the refusal rate; time-to-land
 * of a clean change must not regress (the step costs ~2-3 min on a green branch).
 */
const TARGETS = { maxRefusalRate: 0.12, maxMedianMinutesToRefusal: 8, maxMedianMinutesToLand: 30 };

/** Aggregate -> list of missed targets (empty = met). Too few runs is itself a miss. */
function checkTargets(agg, targets = TARGETS, { minRuns = 20 } = {}) {
  const miss = [];
  if (agg.landed + agg.refused < minRuns) miss.push(`only ${agg.landed + agg.refused} decided runs (< ${minRuns})`);
  if (agg.refusalRate !== null && agg.refusalRate > targets.maxRefusalRate) miss.push(`refusal rate ${(agg.refusalRate * 100).toFixed(1)}% > ${targets.maxRefusalRate * 100}%`);
  if (agg.medianMinutesToRefusal !== null && agg.medianMinutesToRefusal > targets.maxMedianMinutesToRefusal) miss.push(`median time-to-refusal ${agg.medianMinutesToRefusal} min > ${targets.maxMedianMinutesToRefusal}`);
  if (agg.medianMinutesToLand === null || agg.medianMinutesToLand > targets.maxMedianMinutesToLand) miss.push(`median time-to-land ${agg.medianMinutesToLand} min > ${targets.maxMedianMinutesToLand}`);
  return miss;
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * One refusal annotation message -> a cause key, or null when the message is not a cause
 * (generic "Process completed with exit code 1", lint warnings, notices).
 */
function causeFromMessage(msg) {
  const m = String(msg || '');
  let r = m.match(/^([\w-]+): NEW failure on the branch[^:]*:\s*(\S+?)::(\S+)/);
  // A sub-check with no file of its own ("lint-workflows::audit-x") is keyed by the sub-check.
  if (r) return /[/.]/.test(r[2]) ? `${r[1]}: ${r[2]}` : `${r[1]}: ${r[3]}`;
  r = m.match(/^([\w-]+): NEW failure on the branch[^:]*:\s*(\S+)/);
  if (r) return `${r[1]}: ${r[2]}`;
  r = m.match(/^lint-workflows gate failed: (\S+)/);
  if (r) return `lint-workflows: ${r[1]}`;
  r = m.match(/^([\w-]+) gate failed: (\S+)/);
  if (r) return `${r[1]}: ${r[2]}`;
  if (/does not rebase cleanly onto/.test(m)) return 'rebase conflict (Checks)';
  r = m.match(/was NOT landed\s*\S+\s*([\w-]+)/);
  if (r) return r[1] === 'rebase' ? 'rebase conflict (at landing)' : `landing refused: ${r[1]}`;
  return null;
}

/** Annotations of a failing job -> sorted unique cause keys (falls back to the first failing gate). */
function causesFromAnnotations(annotations) {
  const failures = (annotations || []).filter((a) => a.annotation_level === 'failure').map((a) => a.message || '');
  const causes = new Set(failures.map(causeFromMessage).filter(Boolean));
  if (!causes.size) {
    for (const f of failures) {
      const g = f.match(/first failing gate: ([\w-]+)/);
      if (g) causes.add(g[1] === 'rebase' ? 'rebase conflict (Checks)' : `${g[1]} (no per-test annotation)`);
    }
  }
  return [...causes].sort();
}

/**
 * A run plus its jobs (and the refusing job's annotations) -> one record:
 * { id, branch, started, outcome: 'landed'|'refused'|'other', minutes, refusedIn, causes, fast, shard }
 * 'other' = cancelled, still running, skipped gauntlet with no Land, superseded.
 * Jobs match by EXACT name. "Checks (shard 2/2)" (BRO-7324 runner B) is advisory:
 * Land never needs it, so a landing is judged by the Land job, not the run's
 * conclusion (B failing or cancelled turns the run red while the change landed).
 * B's own wall time is reported apart as `shard` ({ conclusion, minutes }), never
 * as a refusal cause.
 */
function summarizeRun(run, jobs, annotations = []) {
  const start = run.run_started_at || run.created_at;
  const byName = (re) => (jobs || []).find((j) => re.test(j.name));
  const checks = byName(/^Checks$/);
  const land = byName(/^Land$/);
  const shardJob = byName(/^Checks \(shard 2\/2\)$/);
  const shard = shardJob ? { conclusion: shardJob.conclusion || null, minutes: shardJob.started_at && shardJob.completed_at ? round1(minutes(shardJob.started_at, shardJob.completed_at)) : null } : null;
  const fast = !!(checks && (checks.steps || []).some((s) => FAST_STEP_RE.test(s.name)));
  const collectStep = checks && (checks.steps || []).find((s) => /^Collect the node shard/.test(s.name || ''));
  const checksMinutes = checks && checks.started_at && checks.completed_at ? round1(minutes(checks.started_at, checks.completed_at)) : null;
  const collectSecs = collectStep && collectStep.started_at && collectStep.completed_at ? Math.round((Date.parse(collectStep.completed_at) - Date.parse(collectStep.started_at)) / 1000) : null;
  const rec = { id: run.id, branch: run.head_branch, started: start, outcome: 'other', minutes: null, refusedIn: null, causes: [], fast, shard, checksMinutes, collectSecs };
  if (run.status !== 'completed') return rec;
  if (land && land.conclusion === 'success' && land.completed_at) {
    return { ...rec, outcome: 'landed', minutes: round1(minutes(start, land.completed_at)) };
  }
  if (run.conclusion !== 'failure') return rec;
  // The job that said no: Checks (a red gate, a rebase conflict) or Land (a refused landing).
  const failed = [checks, land].find((j) => j && j.conclusion === 'failure');
  if (!failed || !failed.completed_at) return rec;
  let causes = causesFromAnnotations(annotations);
  const failedStep = (failed.steps || []).find((s) => s.conclusion === 'failure');
  if (!causes.length && failedStep) {
    if (/^Rebase onto/.test(failedStep.name)) causes = ['rebase conflict'];
    else if (FAST_STEP_RE.test(failedStep.name)) causes = ['fast-fail (no per-test annotation)'];
    else causes = [`${failed.name}: step "${failedStep.name}"`];
  }
  if (!causes.length) causes = [`${failed.name}: unknown`];
  return { ...rec, outcome: 'refused', minutes: round1(minutes(start, failed.completed_at)), refusedIn: failed.name, causes };
}

/** Records -> { runs, landed, refused, medianMinutesToLand, medianMinutesToRefusal, causes: [{cause, refusals}] } */
function aggregate(records) {
  const landed = records.filter((r) => r.outcome === 'landed');
  const refused = records.filter((r) => r.outcome === 'refused');
  const counts = new Map();
  for (const r of refused) for (const c of r.causes) counts.set(c, (counts.get(c) || 0) + 1);
  const causes = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([cause, refusals]) => ({ cause, refusals }));
  return {
    runs: records.length,
    landed: landed.length,
    refused: refused.length,
    medianMinutesToLand: round1(median(landed.map((r) => r.minutes))),
    p90MinutesToLand: round1(percentile(landed.map((r) => r.minutes), 90)),
    refusalRate: landed.length + refused.length ? Math.round((refused.length / (landed.length + refused.length)) * 1000) / 1000 : null,
    medianMinutesToRefusal: round1(median(refused.map((r) => r.minutes))),
    refusalsOver10Min: refused.filter((r) => r.minutes > 10).length,
    causes,
  };
}

/** Records -> { all, before, after } split by the fast-fail step (or an explicit ISO time). */
function report(records, { split = null } = {}) {
  const isAfter = split ? (r) => Date.parse(r.started) >= Date.parse(split) : (r) => r.fast;
  return {
    all: aggregate(records),
    before: aggregate(records.filter((r) => !isAfter(r))),
    after: aggregate(records.filter(isAfter)),
  };
}

/**
 * BRO-7324: per-gate seconds from landings.jsonl rows carrying `timing` (land-gate-timing.js).
 * Scoped runs are left out. Per-gate stats use every other run; wall stats only the runs
 * with the largest gateCount seen for that kind (a GAUNTLET_GATES-limited run is not full).
 */
function gateReport(rows, { days = 7, nowMs = Date.now() } = {}) {
  const since = nowMs - days * 86400000;
  const timed = (rows || []).filter(r => r && r.timing && r.timing.runs && Date.parse(r.ts) >= since);
  const kinds = {};
  for (const r of timed) {
    for (const [kind, run] of Object.entries(r.timing.runs)) {
      const k = kinds[kind] || (kinds[kind] = { runs: 0, scoped: 0, wall: [], gates: {} });
      k.runs += 1;
      if (run.scoped) { k.scoped += 1; continue; }
      // Wall time only compares like with like: a GAUNTLET_GATES-limited run (lazy base) is not a full run.
      if (Number.isFinite(run.wallSecs)) k.wall.push({ s: run.wallSecs, n: Number(run.gateCount) || 0 });
      for (const [g, v] of Object.entries(run.gateSecs || {})) if (Number.isFinite(v)) (k.gates[g] || (k.gates[g] = [])).push(v);
    }
  }
  const stat = (xs) => ({ n: xs.length, median: median(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });
  const out = {};
  for (const [kind, k] of Object.entries(kinds)) {
    const full = Math.max(0, ...k.wall.map(w => w.n));
    out[kind] = { runs: k.runs, scoped: k.scoped, fullGateCount: full, wallSecs: stat(k.wall.filter(w => w.n === full).map(w => w.s)), gates: Object.fromEntries(Object.entries(k.gates).map(([g, xs]) => [g, stat(xs)]).sort((a, b) => (b[1].median || 0) - (a[1].median || 0))) };
  }
  return { days, landings: timed.length, kinds: out };
}

/**
 * BRO-7324 goal. The landings that count: the Checks job split in two (part 2 from
 * runner B or re-run here), core data pinned AND used (attempt 1 only: a re-run
 * attempt never pins), the branch gauntlet ran all `gateCount` gates unscoped
 * (inert runs have no branch run), and a Checks wall read from the jobs API. Landings whose
 * branch had a red gate and paid for a base run are included on purpose: that is
 * real time to land. Newest last.
 */
function checksGoalRows(rows, { gateCount = GOAL.gates } = {}) {
  return (rows || []).filter((r) => {
    const t = r && r.timing; const c = t && t.checks;
    const br = t && t.runs && t.runs['land-gauntlet/branch'];
    return Boolean(c && (c.nodeShard === 'artifact' || c.nodeShard === 'local') && c.dataPinned === true
      && Number.isFinite(c.wallSecs) && br && !br.scoped && Number(br.gateCount) === gateCount);
  });
}

// gates follows the verdict's gate list, so adding a gate never strands the goal on a stale count.
const GOAL = { landings: 10, medianSecs: 1200, gates: require('./land-gate-delta.js').GATES.length };

/** -> { ok, n, medianSecs, rows, reason } over the newest GOAL.landings counted rows. */
function checksGoal(rows, goal = GOAL) {
  const all = checksGoalRows(rows, { gateCount: goal.gates });
  const last = all.slice(-goal.landings);
  const med = median(last.map((r) => r.timing.checks.wallSecs));
  if (last.length < goal.landings) return { ok: false, n: last.length, medianSecs: med, rows: last, reason: `only ${last.length} of ${goal.landings} pinned split landings with all ${goal.gates} gates are recorded in data/audit/landings.jsonl (Checks wall from the jobs API)` };
  const ok = med < goal.medianSecs;
  return { ok, n: last.length, medianSecs: med, rows: last, reason: ok ? `median Checks ${med}s < ${goal.medianSecs}s over the last ${last.length}` : `median Checks ${med}s is not under ${goal.medianSecs}s over the last ${last.length}` };
}

function printChecks(rows) {
  const split = (rows || []).filter((r) => r && r.timing && r.timing.checks && (r.timing.checks.nodeShard === 'artifact' || r.timing.checks.nodeShard === 'local'));
  if (!split.length) { console.log('\nChecks job (BRO-7324 split): no landing records it yet.'); return; }
  console.log(`\nChecks job, per landing (wall from the Actions jobs API; land-gauntlet/branch wall leaves out the collect wait):`);
  for (const r of split.slice(-20)) {
    const c = r.timing.checks; const br = (r.timing.runs || {})['land-gauntlet/branch'];
    const f = (v) => (v == null ? '-' : String(v));
    console.log(`  ${r.ts.slice(0, 16)} ${String(r.branch).padEnd(34).slice(0, 34)} checks ${f(c.wallSecs).padStart(5)}s  gauntlet ${f(br && br.wallSecs).padStart(5)}s  part2 ${f(c.nodeShard).padEnd(8)} wait ${f(c.waitSecs)}s local ${f(c.localSecs)}s collect ${f(c.collectSecs)}s  pinned ${c.dataPinned ? 'yes' : 'no'}  attempt ${f(c.attempt)}`);
  }
  const by = (pred) => median(split.filter(pred).map((r) => r.timing.checks.wallSecs).filter(Number.isFinite));
  console.log(`  median Checks: artifact ${by((r) => r.timing.checks.nodeShard === 'artifact') ?? '-'}s, local ${by((r) => r.timing.checks.nodeShard === 'local') ?? '-'}s, pinned+used ${by((r) => r.timing.checks.dataPinned) ?? '-'}s`);
  const g = checksGoal(rows);
  console.log(`  goal (median < ${GOAL.medianSecs}s over ${GOAL.landings} pinned split landings, ${GOAL.gates} gates): ${g.ok ? 'MET' : 'NOT MET'}: ${g.reason}`);
}

function printGates(rep) {
  console.log(`Gate timing from data/audit/landings.jsonl, last ${rep.days} day(s): ${rep.landings} landing(s) carry timing.`);
  if (!rep.landings) { console.log('No timed landings yet (the record starts with the second landing after BRO-7324 step 1).'); return; }
  console.log('Merge-train riders carry no timing (the holder writes their rows).');
  for (const [kind, k] of Object.entries(rep.kinds)) {
    const w = k.wallSecs;
    console.log(`\n${kind}: ${k.runs} run(s), ${k.scoped} scoped (left out). Wall over runs of all ${k.fullGateCount} gates: median ${w.median}s (min ${w.min}, max ${w.max}, n=${w.n})`);
    for (const [g, s] of Object.entries(k.gates)) console.log(`  ${g.padEnd(22)} median ${String(s.median).padStart(5)}s  min ${s.min}  max ${s.max}  n=${s.n}`);
  }
}

function parseArgs(argv) {
  const o = { days: 7, json: false, split: null, check: false, gates: false, repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--days=(\d+(?:\.\d+)?)$/))) o.days = Number(m[1]);
    else if (a === '--json') o.json = true;
    else if (a === '--gates') o.gates = true;
    else if (a === '--check-targets') o.check = true;
    else if (a === '--check-invariants') o.checkInvariants = true;
    else if ((m = a.match(/^--split=(.+)$/)) && Number.isFinite(Date.parse(m[1]))) o.split = m[1];
    else if ((m = a.match(/^--repo=([\w.-]+\/[\w.-]+)$/))) o.repo = m[1];
    else if (a === '-h' || a === '--help') o.help = true;
    else return { error: `unknown or malformed argument: ${a}` };
  }
  if (!(o.days > 0)) return { error: '--days must be positive' };
  if (o.gates && (o.check || o.checkInvariants || o.split)) return { error: '--gates reads the ledger only; it takes no --check-targets or --split' };
  return o;
}

/** Map with bounded concurrency. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function collect({ days, repo, api }) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  const base = `https://api.github.com/repos/${repo}`;
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api(`${base}/actions/workflows/land.yml/runs?per_page=100&page=${page}&created=%3E%3D${since}`);
    const batch = (r && r.workflow_runs) || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return pool(runs, 8, async (run) => {
    const j = await api(`${base}/actions/runs/${run.id}/jobs?per_page=50`);
    const jobs = (j && j.jobs) || [];
    let annotations = [];
    if (run.status === 'completed' && run.conclusion === 'failure') {
      const failed = jobs.find((x) => /^(Checks|Land)$/.test(x.name) && x.conclusion === 'failure');
      if (failed) annotations = (await api(`${base}/check-runs/${failed.id}/annotations?per_page=100`)) || [];
    }
    return summarizeRun(run, jobs, annotations);
  });
}

function printText(rep, { days, split }) {
  const line = (label, a) => `${label.padEnd(7)} runs ${String(a.runs).padStart(4)}  landed ${String(a.landed).padStart(3)} (median ${a.medianMinutesToLand ?? '-'} min, p90 ${a.p90MinutesToLand ?? '-'})  refusal rate ${a.refusalRate === null ? '-' : (a.refusalRate * 100).toFixed(1) + '%'}  refused ${String(a.refused).padStart(3)} (median ${a.medianMinutesToRefusal ?? '-'} min, ${a.refusalsOver10Min} after >10 min)`;
  console.log(`land.yml, last ${days} day(s); before/after split: ${split || 'runs with the Fast-fail step'}`);
  console.log(line('all', rep.all));
  console.log(line('before', rep.before));
  console.log(line('after', rep.after));
  console.log('\nRefusal causes, ranked (all runs):');
  for (const c of rep.all.causes.slice(0, 25)) console.log(`  ${String(c.refusals).padStart(3)}  ${c.cause}`);
}

/**
 * BRO-7150: land-fast-tests.js INVARIANT_TESTS is hand-kept from this report's ranked causes, so it
 * decays (12 test files behind 2+ refusals were missing by 2026-11-27). Per-file causes look like
 * "<gate>: <test file>"; a file behind >= minRefusals refusals that is neither an invariant nor known
 * slow belongs on the list. Pure: -> [{ file, gate, refusals }], most refusals first.
 */
function missingInvariants(causes, { invariants, slow = new Set(), minRefusals = 3 } = {}) {
  const have = new Set(invariants || []);
  const out = [];
  for (const c of causes || []) {
    const m = String(c.cause || '').match(/^([\w-]+): (\S+\.test\.m?[jt]sx?)$/);
    if (!m || c.refusals < minRefusals || have.has(m[2]) || slow.has(m[2])) continue;
    out.push({ file: m[2], gate: m[1], refusals: c.refusals });
  }
  return out.sort((a, b) => b.refusals - a.refusals || (a.file < b.file ? -1 : 1));
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: land-timing-report.js [--days=7] [--json] [--split=<ISO>] [--repo=owner/name] [--check-targets] [--check-invariants] | --gates [--days=7] [--json]'); return 0; }
  if (o.error) { console.error(`land-timing-report: ${o.error}`); return 2; }
  if (o.gates) {
    const { readLandings } = require('./landings-ledger.js');
    const led = readLandings(process.cwd());
    if (!led.available) { console.error('land-timing-report: data/audit/landings.jsonl not found (run from the repo root)'); return 1; }
    const rep = gateReport(led.rows, { days: o.days });
    if (o.json) console.log(JSON.stringify({ ...rep, checksGoal: checksGoal(led.rows) }, null, 2));
    else { printGates(rep); printChecks(led.rows); }
    return 0;
  }
  const { fetchGitHubJSON } = require('./gh-api-client.js');
  const api = (url) => fetchGitHubJSON(url, { caller: 'land-timing-report.js', timeoutMs: 30000 });
  let records;
  try {
    records = await collect({ days: o.days, repo: o.repo, api });
  } catch (e) {
    console.error(`land-timing-report: GitHub API failed: ${e.message}`);
    return 1;
  }
  const rep = report(records, { split: o.split });
  if (o.json) console.log(JSON.stringify({ days: o.days, split: o.split || 'fast-fail step', targets: TARGETS, ...rep, records }, null, 2));
  else printText(rep, o);
  let code = 0;
  if (o.checkInvariants) {
    const F = require('./land-fast-tests.js');
    const miss = missingInvariants(rep.all.causes, { invariants: F.INVARIANT_TESTS, slow: F.SLOW_TESTS });
    if (miss.length) {
      console.error(`INVARIANTS MISSING: ${miss.length} test file(s) refused 3+ lands but are not in INVARIANT_TESTS (scripts/lib/land-fast-tests.js); add the fast ones:`);
      for (const m of miss) console.error(`  ${m.refusals}x ${m.gate}: ${m.file}`);
      code = 1;
    } else console.error('INVARIANTS COVERED: every test file behind 3+ refusals is in INVARIANT_TESTS or SLOW_TESTS');
  }
  if (o.check) {
    // Judged on the whole trailing window: by the recheck date every run in it has the fast-fail step.
    const miss = checkTargets(rep.all);
    console.error(miss.length ? `TARGETS MISSED: ${miss.join('; ')}` : `TARGETS MET (${JSON.stringify(TARGETS)})`);
    if (miss.length) code = 1;
  }
  return code;
}

module.exports = { missingInvariants, median, percentile, TARGETS, checkTargets, causeFromMessage, causesFromAnnotations, summarizeRun, aggregate, report, parseArgs, FAST_STEP_RE, gateReport, checksGoalRows, checksGoal, GOAL };

if (require.main === module) main().then((code) => { process.exitCode = code; });
