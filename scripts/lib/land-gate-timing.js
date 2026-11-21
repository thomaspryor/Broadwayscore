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
 * Shape: { v: 1, runs: { <root-name>/<dir>: { wallSecs, gateSecs: {gate: s}, gates: [..], scoped } } }
 * A scoped run (land-gate-delta.js --rerun-scope, $OUT/SCOPED) or one limited by
 * GAUNTLET_GATES covers only some gates: compare `gates` before mixing runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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
      const fin = Date.parse(meta.finishedAt || '');
      if (!Number.isFinite(fin) || fin < t0Ms) continue;
      const gateSecs = {};
      for (const [g, v] of Object.entries(meta.gateSecs || {})) if (Number.isFinite(v)) gateSecs[g] = Math.round(v);
      runs[`${path.basename(root)}/${e.name}`] = {
        wallSecs: Number.isFinite(meta.wallMs) ? Math.round(meta.wallMs / 1000) : null,
        gateSecs,
        gates: Array.isArray(meta.gates) ? meta.gates : [],
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
  return lines;
}

function parseArgs(argv) {
  const o = { cmd: argv[0], roots: [], t0: 0, githubOutput: null, summaryFile: null };
  for (const a of argv.slice(1)) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'root') o.roots.push(m[2]);
    else if (m[1] === 't0') o.t0 = Number(m[2]) || 0;
    else if (m[1] === 'github-output') o.githubOutput = m[2];
    else if (m[1] === 'summary-file') o.summaryFile = m[2];
  }
  return o;
}

function main(argv = process.argv.slice(2)) {
  try {
    const o = parseArgs(argv);
    if (o.cmd !== 'emit') { console.log('usage: land-gate-timing.js emit --t0=<ms> --root=<dir> [...]'); return 0; }
    const timing = collectTiming({ roots: o.roots, t0Ms: o.t0 });
    const json = JSON.stringify(timing);
    console.log(json);
    if (o.githubOutput) fs.appendFileSync(o.githubOutput, `timing=${json}\n`);
    if (o.summaryFile) fs.appendFileSync(o.summaryFile, `${summaryLines(timing).join('\n')}\n`);
  } catch (e) {
    console.log(`::warning::gate timing not recorded: ${e && e.message}`);
  }
  return 0;
}

module.exports = { collectTiming, summaryLines, parseArgs };

if (require.main === module) process.exitCode = main();
