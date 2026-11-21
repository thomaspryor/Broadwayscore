#!/usr/bin/env node
/**
 * live-data-lane.js (BRO-7101) — which tests block main, and which run in the
 * non-blocking live-data lane (check-corpus-drift.yml).
 *
 * A test that asserts on the repo's live, bot-rewritten state (shows.json,
 * reviews.json, review-texts, audit ledgers ...) turns main red whenever a bot
 * commits data, with no code change. Those tests declare themselves live with a
 * `// LIVE-DATA-LANE: <why>` comment in their first 40 lines (or a
 * -live-data.test.* name); test.yml's blocking batches skip them and
 * check-corpus-drift.yml runs them, routing each failure to one card
 * (live-data-routing.js).
 *
 * The evidence is a runtime trace, not a source scan: run tests with
 *   LIVE_DATA_READ_LOG=<file> node --import ./scripts/lib/live-data-read-hook.mjs --test ...
 * and every read of <repo>/data/** is logged as {test, path, direct}.
 *
 * Rule (classify): a test is LIVE when
 *   (a) the test file or a helper under tests/ reads a data/ path itself
 *       (direct), except code-owned ratchet baselines (data/audit/*baseline*); or
 *   (b) anything it runs reads a HOT path: one git does not track (private core
 *       data such as data/shows.json, data/reviews.json, data/review-texts/**),
 *       or a non-baseline file under data/audit/ (bot-written ledgers).
 * A library loading a TRACKED config table at import (venue lists, outlet
 * registry, critic aliases) does not make a test live: those change with code
 * review, and counting them would empty a third of the blocking batch.
 *
 * Usage:
 *   node scripts/live-data-lane.js --filter=blocking|live [files...]
 *       prints the given files (args, or stdin lines) that belong to that lane.
 *   node scripts/live-data-lane.js --classify <trace.jsonl>... [--json]
 *       per-test verdict with the paths that made it live.
 *   node scripts/live-data-lane.js --check <trace.jsonl>... [--files=a,b] [--advisory]
 *       undeclared live tests (exit 1 unless --advisory) and stale markers
 *       (declared live, traced, no live read: warning only).
 *   node scripts/live-data-lane.js --mark <trace.jsonl>...
 *       inserts the marker into every undeclared test the trace classifies live.
 *   node scripts/live-data-lane.js --verify-changed [--base=<sha>]
 *       the land check (land-gauntlet.sh lint-workflows > live-data-lane): runs
 *       the unit test files changed since the base (LAND_BASE, else
 *       origin/main) under the tracer and --check's them. ADVISORY (::warning::,
 *       exit 0) until LAND_LIVE_DATA_LANE_BLOCKING=1 (CLAUDE.md §19).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const { isDeclaredLive, MARKER } = require('./lib/live-data-paths.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_RE = /^data\/audit\/(.*\/)?[^/]*baseline[^/]*$/;

/** PURE. Code-owned ratchet baseline: committed with the code that reads it. */
function isBaseline(rel) { return BASELINE_RE.test(rel); }

/**
 * PURE. Bot-rewritten or private state.
 * @param {string} rel repo-relative path under data/
 * @param {{tracked:Set<string>, trackedDirs:Set<string>}} git
 */
function isHotPath(rel, git) {
  if (rel === 'data') return false; // listing the data/ root asserts nothing
  if (isBaseline(rel)) return false;
  if (rel === 'data/review-texts' || rel.startsWith('data/review-texts/')) return true;
  if (rel === 'data/audit' || rel.startsWith('data/audit/')) return true;
  if (git.tracked.has(rel) || git.trackedDirs.has(rel)) return false;
  return true; // untracked: private core data, refreshed by CI
}

/** PURE. Does one trace record make its test live? Returns the reason or null. */
function liveReason(rec, git) {
  if (rec.path === 'data') return null;
  if (rec.direct && !isBaseline(rec.path)) return `${rec.path} (read by the test)`;
  if (isHotPath(rec.path, git)) return `${rec.path} (${git.tracked.has(rec.path) ? 'bot ledger' : 'untracked core data'})`;
  return null;
}

/**
 * PURE. records → Map<test, {live:boolean, reasons:string[], reads:number}>.
 * Every traced test appears, live or not, so a stale marker is detectable.
 */
function classify(records, git) {
  const out = new Map();
  for (const r of records) {
    if (!r || !r.test || !r.path) continue;
    const e = out.get(r.test) || { live: false, reasons: [], reads: 0 };
    e.reads += 1;
    const why = liveReason(r, git);
    if (why && !e.reasons.includes(why)) { e.live = true; e.reasons.push(why); }
    out.set(r.test, e);
  }
  return out;
}

/**
 * PURE. Compare the trace verdicts with the files' declarations.
 * @param {Map} verdicts from classify
 * @param {(rel:string)=>boolean} declared
 * @param {string[]|null} scope only judge these files (null = all traced)
 */
function check(verdicts, declared, scope = null) {
  const inScope = scope ? new Set(scope) : null;
  const undeclared = [];
  const stale = [];
  for (const [test, v] of verdicts) {
    if (inScope && !inScope.has(test)) continue;
    const d = declared(test);
    if (v.live && !d) undeclared.push({ test, reasons: v.reasons });
    if (!v.live && d) stale.push(test);
  }
  return { undeclared, stale };
}

/** PURE. Insert the marker line; keeps a shebang first. */
function withMarker(text, reasons) {
  const shown = reasons.slice(0, 3).join('; ') + (reasons.length > 3 ? `; +${reasons.length - 3} more` : '');
  const line = `// ${MARKER} reads ${shown}. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).`;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    return `${text.slice(0, nl + 1)}${line}\n${text.slice(nl + 1)}`;
  }
  return `${line}\n${text}`;
}

function readTrace(files) {
  const recs = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch { /* torn line from a killed process */ }
    }
  }
  return recs;
}

function gitIndex(root = ROOT) {
  const out = execFileSync('git', ['ls-files', '-z', 'data'], { cwd: root, maxBuffer: 256 << 20 }).toString();
  const tracked = new Set(out.split('\0').filter(Boolean));
  const trackedDirs = new Set();
  for (const f of tracked) {
    for (let d = path.posix.dirname(f); d !== '.' && d !== 'data' && !trackedDirs.has(d); d = path.posix.dirname(d)) trackedDirs.add(d);
  }
  return { tracked, trackedDirs };
}

function declaredFile(rel, root = ROOT) {
  try { return isDeclaredLive(rel, fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return isDeclaredLive(rel, ''); }
}

/** Lane of each file: 'live' when declared, else 'blocking'. */
function filterLane(files, lane, root = ROOT) {
  return files.filter((f) => (declaredFile(f, root) ? 'live' : 'blocking') === lane);
}

const TEST_RE = /\.test\.(mjs|cjs|js|ts|tsx)$/;

/**
 * PURE. Which changed files are unit tests a blocking batch runs, by runner.
 * @param {string[]} changed repo-relative paths
 * @param {{node:Set<string>, tsx:Set<string>}} batches every file each runner collects
 */
function changedUnitTests(changed, batches) {
  const node = [];
  const tsx = [];
  for (const f of changed) {
    if (!TEST_RE.test(f)) continue;
    if (batches.tsx.has(f)) tsx.push(f);
    else if (batches.node.has(f)) node.push(f);
  }
  return { node, tsx };
}

function unitBatches(root = ROOT) {
  const { collectLane, TSX_MANIFEST_REL } = require('./lib/unit-test-collection.js');
  const node = new Set(collectLane(root, 'all'));
  for (const f of fs.readdirSync(path.join(root, 'scripts/lib'))) if (f.endsWith('.test.mjs')) node.add(`scripts/lib/${f}`);
  let tsxLines = [];
  try { tsxLines = fs.readFileSync(path.join(root, TSX_MANIFEST_REL), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { /* none */ }
  return { node, tsx: new Set(tsxLines) };
}

/** Trace-run the files (test failures are ignored: only the reads matter). */
// Per runner; node + tsx together stay under 20 minutes of the land budget.
const TRACE_TIMEOUT_MS = 10 * 60 * 1000;

function traceRun(files, runner, log, root = ROOT) {
  if (!files.length) return true;
  const hook = path.join(root, 'scripts/lib/live-data-read-hook.mjs');
  const env = { ...process.env, LIVE_DATA_READ_LOG: log };
  for (const k of ['NODE_TEST_CONTEXT', 'LIVE_DATA_TEST']) delete env[k];
  const args = ['--import', hook, '--test', '--test-reporter=dot', '--test-timeout', '300000', ...files];
  const r = runner === 'tsx'
    ? spawnSync('npx', ['tsx', ...args], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], timeout: TRACE_TIMEOUT_MS })
    : spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'], timeout: TRACE_TIMEOUT_MS });
  console.log(`# traced ${files.length} ${runner} file(s), test exit ${r.status} (test results are not judged here)`);
  // A failing test still leaves its reads in the log; a run killed by the
  // timeout or a signal (or one that never started) does not, so its trace
  // is incomplete. Returns false then.
  return !(r.error || r.signal || r.status === null);
}

// Advisory mode must never fail a land: any unexpected throw (an unreadable
// manifest, a full tmp dir) is a warning and exit 0. Once blocking, the same
// throw fails the gate, since a check that cannot run proves nothing.
function verifyChanged(args) {
  const blocking = process.env.LAND_LIVE_DATA_LANE_BLOCKING === '1';
  try {
    return verifyChangedInner(args);
  } catch (e) {
    console.log(`::${blocking ? 'error' : 'warning'}::live-data-lane: --verify-changed crashed (${String(e && e.message).split('\n')[0]}).`);
    return blocking ? 1 : 0;
  }
}

function verifyChangedInner(args) {
  const blocking = process.env.LAND_LIVE_DATA_LANE_BLOCKING === '1';
  const baseArg = args.find((a) => a.startsWith('--base='));
  const base = baseArg ? baseArg.slice(7) : (process.env.LAND_BASE || 'origin/main');
  let changed;
  try {
    changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (e) {
    const level = blocking ? 'error' : 'warning';
    console.log(`::${level}::live-data-lane: cannot diff against ${base} (${String(e.message).split('\n')[0]}); skipped.`);
    return blocking ? 1 : 0;
  }
  const { node, tsx } = changedUnitTests(changed, unitBatches());
  console.log(`live-data-lane: ${node.length + tsx.length} changed unit test file(s) since ${base}`);
  if (!node.length && !tsx.length) return 0;
  // A bulk edit (a marker sweep, a rename) would re-run hundreds of files
  // inside the land; the full trace (--classify/--check on a traced batch run)
  // is the tool for that, so skip loudly instead of eating the land budget.
  const max = Number(process.env.LIVE_DATA_LANE_VERIFY_MAX || 80);
  if (node.length + tsx.length > max) {
    console.log(`::notice::live-data-lane: ${node.length + tsx.length} changed test files > ${max}; skipped (bulk change). Trace them by hand: see the header of scripts/live-data-lane.js.`);
    return 0;
  }
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-lane-')), 'reads.jsonl');
  fs.writeFileSync(log, '');
  const complete = [traceRun(node, 'node', log), traceRun(tsx, 'tsx', log)].every(Boolean);
  if (!complete) {
    console.log(`::${blocking ? 'error' : 'warning'}::live-data-lane: a trace run timed out or was killed, so its reads are incomplete; a clean result below proves nothing.`);
  }
  const scope = [...node, ...tsx];
  const { undeclared, stale } = check(classify(readTrace([log]), gitIndex()), (t) => declaredFile(t), scope);
  const level = blocking ? 'error' : 'warning';
  for (const u of undeclared) {
    console.log(`::${level}::${u.test} reads live data (${u.reasons.slice(0, 3).join('; ')}) but would run in test.yml's blocking batch, so a bot data commit can turn main red. Fix: assert on a fixture, or add "// ${MARKER} <why>" to its first 40 lines so it runs in check-corpus-drift.yml instead.`);
  }
  for (const t of stale) console.log(`::notice::${t} declares ${MARKER} but read no live data here; drop the marker if that holds, so it blocks again.`);
  console.log(`live-data-lane: ${undeclared.length} undeclared live test(s), ${stale.length} stale marker(s)${blocking ? '' : ' (ADVISORY until LAND_LIVE_DATA_LANE_BLOCKING=1)'}.`);
  return (undeclared.length || !complete) && blocking ? 1 : 0;
}

module.exports = { changedUnitTests, isBaseline, isHotPath, liveReason, classify, check, withMarker, filterLane, gitIndex, readTrace };

const USAGE = 'Usage: live-data-lane.js --filter=blocking|live [files] | --classify|--check|--mark <trace.jsonl>... | --verify-changed [--base=<sha>]';

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
  const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const positional = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--verify-changed')) process.exit(verifyChanged(args));
  const lane = opt('filter');
  if (lane) {
    if (!['blocking', 'live'].includes(lane)) { console.error('--filter must be blocking or live'); process.exit(2); }
    const files = positional.length ? positional : fs.readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const kept = filterLane(files, lane);
    if (kept.length) process.stdout.write(kept.join('\n') + '\n');
    process.exit(0);
  }
  const mode = ['--classify', '--check', '--mark'].find((m) => args.includes(m));
  if (!mode || positional.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const verdicts = classify(readTrace(positional), gitIndex());
  if (mode === '--classify') {
    const rows = [...verdicts].sort(([a], [b]) => a.localeCompare(b));
    if (args.includes('--json')) { console.log(JSON.stringify(Object.fromEntries(rows), null, 2)); process.exit(0); }
    for (const [t, v] of rows) console.log(`${v.live ? 'LIVE ' : 'clean'}\t${t}\t${v.reasons.join('; ')}`);
    const n = rows.filter(([, v]) => v.live).length;
    console.error(`${rows.length} traced test files read data/; ${n} live by the rule.`);
    process.exit(0);
  }
  const scope = opt('files') ? opt('files').split(',').filter(Boolean) : null;
  const { undeclared, stale } = check(verdicts, (t) => declaredFile(t), scope);
  if (mode === '--mark') {
    for (const u of undeclared) {
      const p = path.join(ROOT, u.test);
      if (!fs.existsSync(p)) continue;
      fs.writeFileSync(p, withMarker(fs.readFileSync(p, 'utf8'), u.reasons));
      console.log(`marked ${u.test}`);
    }
    console.error(`${undeclared.length} file(s) marked live.`);
    process.exit(0);
  }
  for (const s of stale) console.log(`::warning::${s} is declared LIVE-DATA-LANE but read no live data this run; if that holds, drop the marker so it blocks again.`);
  for (const u of undeclared) {
    console.log(`::error::${u.test} reads live data (${u.reasons.join('; ')}) but is in the blocking unit batch. Fix: assert on a fixture instead, or add "// ${MARKER} <why>" to its first 40 lines so it runs in check-corpus-drift.yml.`);
  }
  console.log(`live-data-lane check: ${undeclared.length} undeclared live test(s), ${stale.length} stale marker(s).`);
  process.exit(undeclared.length && !args.includes('--advisory') ? 1 : 0);
}
