#!/usr/bin/env node
/**
 * land-gate-timing.js — per-gate seconds of one land.yml Checks job (BRO-7324).
 *
 * land-gauntlet.sh writes <out-dir>/meta.json with `gateSecs` (wall seconds per
 * gate) and `wallMs`. This collects every gauntlet out-dir under the given roots
 * that finished during THIS job (finishedAt >= --t0), so a base result restored
 * from actions/cache or another run's artifact (it carries its old meta.json) is
 * never counted as time spent here. land.yml hands the compact JSON to the Land
 * job, which stores it as `timing` on the landings.jsonl row; the reader is
 * `node scripts/lib/land-timing-report.js --gates`.
 *
 * Timing only: nothing here is an input to the verdict, and the CLI always exits 0.
 *
 *   node scripts/lib/land-gate-timing.js emit --t0=<epoch ms> --root=<dir> [--root=<dir>] [--github-output=<file>] [--summary-file=<file>]
 *
 * Shape: { v: 1, runs: { <root-name>/<dir>: { wallSecs, gateSecs: {gate: s}, gateCount, scoped } },
 *          checks?: { attempt, nodeShard, waitSecs, localSecs, dataPinned, wallSecs, collectSecs } }
 * `runs[*].wallSecs` is the gauntlet's own wall: it leaves out the split's collect
 * wait and local re-run. The Checks job's real wall is `checks.wallSecs`, read from
 * the Actions jobs API by the Land job (checksJobTiming) when it writes the row.
 * `checks.dataPinned` is true only when the collect step read the pinned core-data
 * rev (a pin requested but not used is false).
 * A scoped run (land-gate-delta.js --rerun-scope, $OUT/SCOPED) or one limited by
 * GAUNTLET_GATES covers only some gates: compare gateCount before mixing wall times.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Pure. A dir that is one part of a two-runner split (BRO-7324 step C), not a
 * whole result: a part still running (`partial`), a finished part (`shard`), or
 * a merge that has not finished (`mergeIncomplete`). Its time is already in the
 * merged dir (partWallMs), so counting it would double the run. A merged dir
 * drops `shard` and `mergeIncomplete`, keeping the parts only as partSha/partWallMs.
 */
function isSplitPart(meta) {
  return Boolean(meta && (meta.partial || meta.shard || meta.mergeIncomplete));
}

/** Collect the runs under `roots` finished at or after t0Ms. Never throws. */
function collectTiming({ roots = [], t0Ms = 0 } = {}) {
  const runs = {};
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const meta = readJson(path.join(dir, 'meta.json'));
      if (!meta || typeof meta !== 'object') continue;
      if (isSplitPart(meta)) continue;
      const fin = Date.parse(meta.finishedAt || '');
      if (!Number.isFinite(fin) || fin < t0Ms) continue;
      const gateSecs = {};
      for (const [g, v] of Object.entries(meta.gateSecs || {})) if (Number.isFinite(v)) gateSecs[g] = Math.round(v);
      runs[`${path.basename(root)}/${e.name}`] = {
        wallSecs: Number.isFinite(meta.wallMs) ? Math.round(meta.wallMs / 1000) : null,
        gateSecs,
        gateCount: Array.isArray(meta.gates) ? meta.gates.length : 0,
        scoped: fs.existsSync(path.join(dir, 'SCOPED')),
      };
    }
  }
  return { v: 1, runs };
}

/** One summary line per run, gates slowest first. Gate seconds overlap (background lane): never add them up. */
function summaryLines(timing) {
  const lines = ['### Gate timing (advisory, BRO-7324)', ''];
  for (const [name, r] of Object.entries(timing.runs)) {
    const gates = Object.entries(r.gateSecs).sort((a, b) => b[1] - a[1]).map(([g, s]) => `${g} ${s}s`).join(', ');
    lines.push(`- ${name}${r.scoped ? ' (scoped)' : ''}: wall ${r.wallSecs}s; ${gates || 'no gate times'}`);
  }
  if (!Object.keys(timing.runs).length) lines.push('- no gauntlet ran in this job');
  if (timing.checks) {
    const c = timing.checks;
    lines.push(`- node shard part 2/2: ${c.nodeShard} (waited ${c.waitSecs}s for runner B, ran here ${c.localSecs}s); core data pinned and used: ${c.dataPinned ? 'yes' : 'no'}; attempt ${c.attempt}`);
  }
  return lines;
}

/**
 * Pure. What the Checks job itself knows about the two-runner split (BRO-7324):
 * which source part 2 came from, the seconds spent waiting for runner B and
 * re-running part 2 here, and whether the pinned core-data rev was really used.
 * null when the run was not split (no shard source).
 */
function splitFacts({ attempt, nodeShard, waitSecs, localSecs, pinnedRev, usedRev } = {}) {
  if (nodeShard !== 'artifact' && nodeShard !== 'local') return null;
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    attempt: num(attempt),
    nodeShard,
    waitSecs: num(waitSecs),
    localSecs: num(localSecs),
    dataPinned: Boolean(pinnedRev) && pinnedRev === usedRev && num(attempt) === 1,
  };
}

const seconds = (a, b) => (a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null);

/**
 * Pure. The Checks job's wall seconds and the "Collect the node shard" step's
 * seconds from one attempt's jobs API listing ({ jobs: [...] } or the array).
 * Exact job name; the last match wins (a re-run attempt lists the job once).
 */
function checksJobTiming(listing) {
  const jobs = Array.isArray(listing) ? listing : ((listing && listing.jobs) || []);
  const job = jobs.filter((j) => j && j.name === 'Checks').pop();
  if (!job) return null;
  const step = (job.steps || []).find((s) => /^Collect the node shard/.test(s.name || ''));
  return { wallSecs: seconds(job.started_at, job.completed_at), collectSecs: step ? seconds(step.started_at, step.completed_at) : null };
}

/** Pure. Add the API's Checks timing to a timing record (never throws; returns the record). */
function withChecksJob(timing, listing) {
  try {
    const t = timing && typeof timing === 'object' ? timing : null;
    const c = checksJobTiming(listing);
    if (!t || !c) return timing;
    t.checks = { ...(t.checks || {}), ...c };
    return t;
  } catch { return timing; }
}

function parseArgs(argv) {
  const o = { cmd: argv[0], roots: [], t0: 0, githubOutput: null, summaryFile: null, split: {} };
  const splitKeys = { attempt: 'attempt', 'node-shard': 'nodeShard', 'wait-secs': 'waitSecs', 'local-secs': 'localSecs', 'pinned-rev': 'pinnedRev', 'used-rev': 'usedRev' };
  for (const a of argv.slice(1)) {
    const m = /^--([a-z0-9-]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'root') o.roots.push(m[2]);
    else if (m[1] === 't0') o.t0 = Number(m[2]) || 0;
    else if (m[1] === 'github-output') o.githubOutput = m[2];
    else if (m[1] === 'summary-file') o.summaryFile = m[2];
    else if (splitKeys[m[1]]) o.split[splitKeys[m[1]]] = m[2];
  }
  return o;
}

function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    if (o.cmd !== 'emit') { console.log('usage: land-gate-timing.js emit --t0=<ms> --root=<dir> [...]'); return 0; }
    if (!o.t0) console.log('::warning::gate timing: no --t0, so a restored base result may be counted as run here');
    const timing = collectTiming({ roots: o.roots, t0Ms: o.t0 });
    const checks = splitFacts(o.split);
    if (checks) timing.checks = checks;
    const json = JSON.stringify(timing);
    console.log(json);
    if (o.githubOutput) fs.appendFileSync(o.githubOutput, `timing=${json}\n`);
    if (o.summaryFile) fs.appendFileSync(o.summaryFile, `${summaryLines(timing).join('\n')}\n`);
  } catch (e) {
    console.log(`::warning::gate timing not recorded: ${e && e.message}`);
  }
  return 0;
}

module.exports = { collectTiming, summaryLines, parseArgs, isSplitPart, splitFacts, checksJobTiming, withChecksJob };

if (require.main === module) process.exitCode = main();
