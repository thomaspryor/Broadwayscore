#!/usr/bin/env node
'use strict';
//
// land-gate-delta.js — NEW-FAILURES-VS-BASE verdict for land.yml's `checks`
// job (BRO-3873 step 3 follow-up).
//
// WHY
//   land.yml first shipped with strict Test Suite parity: any red gate on the
//   rebased branch refused the landing. While main itself is red (three
//   data-dependent unit tests + one lint-workflows audit on 2026-09-20) that
//   means NOTHING can land — including the fix. scripts/lib/land-branch.js's
//   merged-tree gate and scripts/lib/merge-post-merge-test-gate.js already
//   answer this the right way: run the same suite on the base (origin/main)
//   and on the branch, and block only on a failure that is present in the
//   branch and absent in the base. This module applies that same rule to
//   every gate the `checks` job runs, reusing merge-post-merge-test-gate.js's
//   diffFailingSets() for the set arithmetic and tap-failure-parser.js for
//   the TAP gates rather than writing a third baseline implementation.
//
// INPUT SHAPE
//   scripts/lib/land-gauntlet.sh runs the gauntlet once per tree and writes,
//   per gate, `<dir>/<gate>.exit` (the exit code) and `<dir>/<gate>.log`
//   (stdout+stderr), plus `<dir>/meta.json` ({sha, root, wallMs, …}). This
//   module reads a base dir and a branch dir and decides per gate.
//
// THE RULE, per gate
//   branch green (exit 0)         → PASS. Every base failure is reported as
//                                   FIXED.
//   no base result / base green   → STRICT: branch red is a refusal, its
//                                   parsed failures are all NEW. (tsc and
//                                   lint-workflows "stay strict while green on
//                                   base" is this row — and it is the same
//                                   outcome the delta rule gives, because
//                                   against an empty base set every failure
//                                   is new.)
//   base red AND branch red       → DELTA: parse both, diff. PASS iff no
//                                   failure is new. Pre-existing and fixed
//                                   sets are reported, never hidden.
//   FAIL-SAFE                     → a red run whose output parses to ZERO
//                                   failures (crash, timeout, unsupported
//                                   reporter) cannot be diffed — refuse rather
//                                   than pass a run that validated nothing
//                                   (the same guard merge-post-merge-test-
//                                   gate.js applies to both of its runs).
//
// KEYS
//   unit-tests / scripts-lib-tests: `<repo-relative test file>::<test name>`
//     via parseTapOutput (unlocated `?::name` keys are ALWAYS new — see
//     diffFailingSets for why).
//   tsc / tsc-llm-scoring: `<file>::<TS code> <message>` — line:col dropped so
//     a shifted line is the same error, not a new one.
//   next-lint: `<file>::<rule> <message>`, errors only (warnings never fail
//     `next lint`, so they never fail this gate either).
//   lint-workflows: the failing audit's label (`::error::lint-workflows gate
//     failed: <label> (exit N)`).
//   KNOWN LIMIT (same as merge-post-merge-test-gate.js): an aggregate guard
//   keyed by one name masks a NEW violation of the same guard while base is
//   already red on it. Do not read a green delta as proof while main is red.
//
// USAGE
//   node scripts/lib/land-gate-delta.js --base-dir D --branch-dir D
//        [--gates a,b,…] [--summary-file F] [--github-output F]
//     exit 0 = every gate passes under the rule; exit 1 = at least one NEW
//     failure (named on stdout as ::error:: annotations and in the summary).
//   node scripts/lib/land-gate-delta.js --code-hash <sha> [--cwd DIR]
//     prints the base cache key material: a sha256 over the tree's
//     verification-relevant paths (INERT_FOR_VERIFICATION_RE from
//     land-branch.js excluded), so bot data churn on main does not miss the
//     cache while any code change does.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseTapOutput } = require('./tap-failure-parser.js');
const { diffFailingSets } = require('./merge-post-merge-test-gate.js');
const { isInertForVerification } = require('./land-branch.js');

// The gates land.yml's checks job runs, in verdict order (the first failing
// one names the digest line). Keep in step with scripts/lib/land-gauntlet.sh.
const GATES = ['tsc', 'tsc-llm-scoring', 'next-lint', 'unit-tests', 'scripts-lib-tests', 'lint-workflows'];
const TAP_GATES = new Set(['unit-tests', 'scripts-lib-tests']);
const TSC_GATES = new Set(['tsc', 'tsc-llm-scoring']);

// ── Parsers: gate output → Map<key, {file, name}> ───────────────────────────

function parseTscFailures(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    // src/lib/x.ts(12,5): error TS2304: Cannot find name 'y'.
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trimEnd());
    if (!m) continue;
    const file = m[1].trim();
    const name = `${m[4]} ${m[5].trim()}`;
    out.set(`${file}::${name}`, { file, name });
  }
  return out;
}

function parseNextLintFailures(text) {
  const out = new Map();
  let file = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // A non-indented path line opens a file block: ./src/app/page.tsx
    if (/^\.?\.?\/?[\w@][\w@./+-]*\.[A-Za-z]+$/.test(line) && !/\s/.test(line)) {
      file = line.replace(/^\.\//, '');
      continue;
    }
    // 12:5  Error: 'x' is defined but never used.  @typescript-eslint/no-unused-vars
    // (next's formatter does not indent detail lines; ESLint stylish does —
    // leading whitespace optional so both parse)
    const m = /^\s*(\d+):(\d+)\s+(Error|Warning|error|warning):?\s+(.*?)\s{2,}(\S+)\s*$/.exec(line);
    if (!m || !file) continue;
    if (!/^error$/i.test(m[3])) continue;
    const name = `${m[5]} ${m[4].trim()}`;
    out.set(`${file}::${name}`, { file, name });
  }
  return out;
}

function parseLintWorkflowsFailures(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^::error::lint-workflows gate failed: (.+?) \(exit \d+\)\s*$/.exec(line);
    if (!m) continue;
    out.set(`lint-workflows::${m[1]}`, { file: 'lint-workflows', name: m[1] });
  }
  return out;
}

/** Map<key,{file,name}> of the failures a gate's captured output names. */
function parseGateFailures(gate, text, treeRoot) {
  if (TAP_GATES.has(gate)) return parseTapOutput(text, treeRoot).failures;
  if (TSC_GATES.has(gate)) return parseTscFailures(text);
  if (gate === 'next-lint') return parseNextLintFailures(text);
  if (gate === 'lint-workflows') return parseLintWorkflowsFailures(text);
  throw new Error(`land-gate-delta: no parser for gate ${JSON.stringify(gate)}`);
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Pure. `base` / `branch` are { exit: number|null, text: string, root?: string }
 * (base may be null/undefined: no baseline available → strict).
 * @returns {{gate:string, verdict:'pass'|'fail', mode:'green'|'strict'|'delta'|'fail-safe',
 *            reason:string, newFailures:Array, preExisting:Array, fixed:Array}}
 */
function decideGateDelta({ gate, base, branch }) {
  if (!branch || typeof branch.exit !== 'number') {
    return { gate, verdict: 'fail', mode: 'fail-safe', reason: 'no branch result — the gate never ran', newFailures: [], preExisting: [], fixed: [] };
  }
  const baseKnown = base && typeof base.exit === 'number';
  const baseFailures = baseKnown && base.exit !== 0 ? parseGateFailures(gate, base.text, base.root) : new Map();

  if (branch.exit === 0) {
    return {
      gate, verdict: 'pass', mode: 'green',
      reason: baseFailures.size ? `green on the branch; ${baseFailures.size} base failure(s) fixed` : 'green',
      newFailures: [], preExisting: [], fixed: [...baseFailures.values()],
    };
  }

  const branchFailures = parseGateFailures(gate, branch.text, branch.root);
  const exitNote = `exit ${branch.exit}`;

  if (!baseKnown || base.exit === 0) {
    // Strict: nothing on the base to subtract. Every parsed failure is new;
    // an unparseable red run is still a red run.
    const why = !baseKnown ? 'no base result to diff against' : 'base is green';
    return {
      gate, verdict: 'fail', mode: 'strict',
      reason: `${why} — ${exitNote}, ${branchFailures.size} failure(s)${branchFailures.size ? '' : ' (none parseable — crash/timeout?)'}`,
      newFailures: [...branchFailures.values()], preExisting: [], fixed: [],
    };
  }

  // Both red. Refuse to diff anything that parsed to nothing.
  if (branchFailures.size === 0) {
    return { gate, verdict: 'fail', mode: 'fail-safe', reason: `${exitNote} but no individual failure could be parsed from the branch run (crash/timeout/syntax error) — refusing rather than pass a run that validated nothing`, newFailures: [], preExisting: [], fixed: [] };
  }
  if (baseFailures.size === 0) {
    return { gate, verdict: 'fail', mode: 'fail-safe', reason: `base exit ${base.exit} but no individual failure could be parsed from the base run — cannot tell pre-existing from new, refusing`, newFailures: [...branchFailures.values()], preExisting: [], fixed: [] };
  }
  const { newFailures, preExisting } = diffFailingSets(baseFailures, branchFailures);
  const fixed = [...baseFailures.entries()].filter(([k]) => !branchFailures.has(k)).map(([, v]) => v);
  return {
    gate, verdict: newFailures.length ? 'fail' : 'pass', mode: 'delta',
    reason: `${exitNote} on both — ${newFailures.length} new, ${preExisting.length} pre-existing, ${fixed.length} fixed`,
    newFailures, preExisting, fixed,
  };
}

/** Decide every gate. `read(dir, gate)` → {exit,text,root} | null. */
function decideAllGates({ gates = GATES, base, branch, read = readGateResult }) {
  return gates.map((gate) => decideGateDelta({ gate, base: base ? read(base, gate) : null, branch: read(branch, gate) }));
}

function firstFailingGate(decisions) {
  const d = (decisions || []).find((x) => x && x.verdict !== 'pass');
  return d ? d.gate : '';
}

// ── Result dirs (written by scripts/lib/land-gauntlet.sh) ───────────────────

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
}

function readGateResult(dir, gate) {
  if (!dir) return null;
  const exitFile = path.join(dir, `${gate}.exit`);
  if (!fs.existsSync(exitFile)) return null;
  const exit = Number(fs.readFileSync(exitFile, 'utf8').trim());
  let text = '';
  try { text = fs.readFileSync(path.join(dir, `${gate}.log`), 'utf8'); } catch { text = ''; }
  const meta = readMeta(dir);
  return { exit: Number.isInteger(exit) ? exit : null, text, root: meta && meta.root ? meta.root : undefined };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function fmtList(items) {
  return items.map((f) => `  - \`${f.file}::${f.name}\``).join('\n');
}

function formatSummary({ decisions, baseMeta, branchMeta, baseSource }) {
  const lines = ['### land.yml gate verdicts — new-failures-vs-base', ''];
  const bs = baseMeta && Number.isFinite(baseMeta.wallMs) ? `${(baseMeta.wallMs / 1000).toFixed(0)}s` : 'n/a';
  const rs = branchMeta && Number.isFinite(branchMeta.wallMs) ? `${(branchMeta.wallMs / 1000).toFixed(0)}s` : 'n/a';
  lines.push(`- base gauntlet: ${baseSource || (baseMeta ? 'ran' : 'NONE')}${baseMeta ? ` — sha \`${String(baseMeta.sha || '').slice(0, 10)}\`, ${bs} wall` : ''}`);
  lines.push(`- branch gauntlet: ran now${branchMeta ? ` — sha \`${String(branchMeta.sha || '').slice(0, 10)}\`, ${rs} wall` : ''}`);
  lines.push('', '| gate | verdict | mode | new | pre-existing | fixed | note |', '|---|---|---|---|---|---|---|');
  for (const d of decisions) {
    lines.push(`| ${d.gate} | ${d.verdict === 'pass' ? 'PASS' : '**FAIL**'} | ${d.mode} | ${d.newFailures.length} | ${d.preExisting.length} | ${d.fixed.length} | ${d.reason} |`);
  }
  for (const d of decisions) {
    if (d.newFailures.length) lines.push('', `#### ${d.gate} — NEW on the branch (blocking)`, fmtList(d.newFailures));
    if (d.preExisting.length) lines.push('', `#### ${d.gate} — pre-existing on origin/main (not blocking; still real, file an issue)`, fmtList(d.preExisting));
    if (d.fixed.length) lines.push('', `#### ${d.gate} — fixed by the branch`, fmtList(d.fixed));
  }
  return `${lines.join('\n')}\n`;
}

// ── Base cache key: a hash of the verification-relevant tree ────────────────

/**
 * sha256 over `git ls-tree -r <sha>` minus INERT_FOR_VERIFICATION_RE paths.
 * Two base shas that differ only in bot data churn hash the same, so the
 * cached base gauntlet is reused across them; any code/workflow/test change
 * hashes differently. `lsTree` is injectable for tests.
 */
function computeCodeTreeHash(sha, { cwd = process.cwd(), lsTree = null } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) throw new Error(`computeCodeTreeHash: need a full 40-hex sha (got ${JSON.stringify(sha)})`);
  const listing = lsTree
    ? lsTree(sha)
    : execFileSync('git', ['ls-tree', '-r', sha], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const h = crypto.createHash('sha256');
  let kept = 0;
  for (const line of String(listing).split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const file = tab === -1 ? line : line.slice(tab + 1);
    if (isInertForVerification(file)) continue;
    h.update(line);
    h.update('\n');
    kept++;
  }
  return { hash: h.digest('hex'), kept };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[t.slice(2)] = next; i++; } else a[t.slice(2)] = true;
  }
  return a;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log('usage: land-gate-delta.js --base-dir D --branch-dir D [--gates a,b] [--summary-file F] [--github-output F] [--base-source S]\n       land-gate-delta.js --code-hash <sha> [--cwd DIR]');
    return 0;
  }
  if (args['code-hash']) {
    const { hash, kept } = computeCodeTreeHash(String(args['code-hash']), { cwd: args.cwd ? String(args.cwd) : process.cwd() });
    console.error(`code tree hash over ${kept} verification-relevant path(s)`);
    console.log(hash);
    return 0;
  }
  if (!args['branch-dir'] || args['branch-dir'] === true) {
    console.error('usage: land-gate-delta.js --base-dir D --branch-dir D');
    return 2;
  }
  const branchDir = String(args['branch-dir']);
  const baseDir = args['base-dir'] && args['base-dir'] !== true && fs.existsSync(path.join(String(args['base-dir']), 'meta.json')) ? String(args['base-dir']) : null;
  const gates = args.gates && args.gates !== true ? String(args.gates).split(',').map((s) => s.trim()).filter(Boolean) : GATES;
  const decisions = decideAllGates({ gates, base: baseDir, branch: branchDir });
  const baseMeta = baseDir ? readMeta(baseDir) : null;
  const branchMeta = readMeta(branchDir);

  for (const d of decisions) {
    console.log(`${d.verdict === 'pass' ? 'PASS' : 'FAIL'}  ${d.gate.padEnd(18)} ${d.mode.padEnd(9)} ${d.reason}`);
    for (const f of d.newFailures) console.log(`::error::${d.gate}: NEW failure on the branch (absent on origin/main): ${f.file}::${f.name}`);
    for (const f of d.preExisting) console.log(`  pre-existing (origin/main is red on this too, not blocking): ${f.file}::${f.name}`);
    for (const f of d.fixed) console.log(`  fixed by this branch: ${f.file}::${f.name}`);
  }
  const summary = formatSummary({ decisions, baseMeta, branchMeta, baseSource: args['base-source'] && args['base-source'] !== true ? String(args['base-source']) : null });
  if (args['summary-file'] && args['summary-file'] !== true) fs.appendFileSync(String(args['summary-file']), summary);
  else console.log(`\n${summary}`);
  const gate = firstFailingGate(decisions);
  if (args['github-output'] && args['github-output'] !== true) {
    const totals = decisions.reduce((t, d) => ({ n: t.n + d.newFailures.length, p: t.p + d.preExisting.length, f: t.f + d.fixed.length }), { n: 0, p: 0, f: 0 });
    fs.appendFileSync(String(args['github-output']), `gate=${gate}\nnew_failures=${totals.n}\npre_existing=${totals.p}\nfixed=${totals.f}\n`);
  }
  return gate ? 1 : 0;
}

module.exports = {
  GATES,
  parseGateFailures,
  parseTscFailures,
  parseNextLintFailures,
  parseLintWorkflowsFailures,
  decideGateDelta,
  decideAllGates,
  firstFailingGate,
  readGateResult,
  readMeta,
  formatSummary,
  computeCodeTreeHash,
  main,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`land-gate-delta: fatal: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
