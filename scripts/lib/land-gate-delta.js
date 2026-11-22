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
//   unit-tests-node / unit-tests-tsx / unit-tests-e2e / scripts-lib-tests:
//     `<repo-relative test file>::<test name>` via parseTapOutput (unlocated
//     `?::name` keys are ALWAYS new — see diffFailingSets for why), with the
//     block's failureType appended for anything but 'subtestsFailed'
//     (` [testCodeFailure]`, ` [cancelledByParent]`, …). Without that, a
//     file X red on base through one failing subtest (`X::sub` and, nested
//     shape, `X::<X> [subtestsFailed]`) that the branch breaks AT LOAD
//     (`X::<X>` only) would diff as "0 new, fixed" — a silent pass on a
//     branch that just deleted a test file's worth of coverage (Claude
//     adversarial review). The two unit batches are separate gates so a
//     batch that cannot start is its own zero-parsed-failures fail-safe,
//     never hidden behind the other batch's unchanged failures.
//   tsc / tsc-llm-scoring: `<file>::<TS code> <message>` — line:col dropped so
//     a shifted line is the same error, not a new one; a SECOND identical
//     diagnostic in the same file keys `… #2`, so adding one is new.
//   next-lint: `<file>::<rule> <message>` (same multiplicity rule), errors
//     only (warnings never fail `next lint`, so they never fail this gate).
//   lint-workflows: the failing audit's label (`::error::lint-workflows gate
//     failed: <label> (exit N)`) PLUS, for actionlint (structured output),
//     each diagnostic `<file>: <message> [rule]` with line:col dropped and the
//     multiplicity rule — so a new workflow error is new even while base is
//     already red on some other actionlint finding.
//   bash-integration (BRO-4150): the failing FILE's path (`::error::bash-
//     integration gate failed: <file> (exit N)`) — same one-key-per-check
//     shape as lint-workflows' label key, deliberately coarser than the TAP
//     gates: these are opaque shell scripts, not `node --test` output, so
//     there is no sub-assertion name to key on. A file red on both sides is
//     pre-existing; newly red on the branch is a refusal.
//   KNOWN LIMIT (same as merge-post-merge-test-gate.js): an audit keyed by
//   its label alone masks a NEW violation of that same audit while base is
//   already red on it. Do not read a green delta as proof while main is red.
//
// USAGE
//   node scripts/lib/land-gate-delta.js --base-dir D --branch-dir D
//        [--gates a,b,…] [--summary-file F] [--github-output F]
//     exit 0 = every gate passes under the rule; exit 1 = at least one NEW
//     failure (named on stdout as ::error:: annotations and in the summary).
//   node scripts/lib/land-gate-delta.js --red-gates D [--gates a,b,…]
//     prints the comma list of gates that are not green in result dir D
//     (non-zero exit, or no result). land.yml runs the base gauntlet for
//     exactly these: a gate green on the branch passes whatever the base says
//     (decideGateDelta), so its base result is never needed (BRO-5670).
//   node scripts/lib/land-gate-delta.js --rerun-scope D --gates a,b,… --out S
//     for each red TAP/bash-integration/toplevel-regression gate in branch result dir D whose every failure is
//     located in one of the gate's own test files (D/<gate>.files, written
//     by the gauntlet), writes S/<gate>.files: the base re-check runs only
//     those files (land-gauntlet.sh GAUNTLET_SCOPE_DIR, BRO-5728). Each red
//     gate's decision is printed; a gate with no S/<gate>.files runs in full.
//     A per-file subset is enough because the verdict only asks whether each
//     branch failure key also fails on base, and every key's file is in it.
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
const GATES = ['tsc', 'tsc-llm-scoring', 'next-lint', 'unit-tests-node', 'unit-tests-tsx', 'unit-tests-e2e', 'scripts-lib-tests', 'bash-integration', 'toplevel-regression', 'lint-workflows'];
// Gates that landed advisory first (CLAUDE.md §19). toplevel-regression
// (BRO-5117) is ARMED since 2026-10-12: across its first 15 land runs it was
// green 14 times and fired once, a true positive (BRO-2749's raw Date parse,
// which then turned main test.yml red as BRO-5140). Kill switch: repo variable
// LAND_TOPLEVEL_ADVISORY=1 puts it back to report-only.
// unit-tests-e2e (BRO-5161) is new, so it lands report-only; repo variable
// LAND_E2E_UNIT_BLOCKING=1 arms it once its land runs show no false positives.
// Each entry: is this gate report-only right now, and why (for the digest).
const ADVISORY_GATES = {
  'toplevel-regression': () => (process.env.LAND_TOPLEVEL_ADVISORY === '1'
    ? 'BRO-5117; LAND_TOPLEVEL_ADVISORY=1 is set' : null),
  'unit-tests-e2e': () => (process.env.LAND_E2E_UNIT_BLOCKING === '1'
    ? null : 'BRO-5161; arm with LAND_E2E_UNIT_BLOCKING=1'),
  // e2e-local (BRO-7106): browser E2E on a local build, run by land.yml's own
  // parallel `e2e-local` job (scripts/lib/land-e2e-local.sh), NOT the checks
  // job's gauntlet, so it is deliberately absent from GATES above; that job
  // passes --gates e2e-local. Report-only until LAND_E2E_BROWSER_BLOCKING=1.
  'e2e-local': () => (process.env.LAND_E2E_BROWSER_BLOCKING === '1'
    ? null : 'BRO-7106; arm with LAND_E2E_BROWSER_BLOCKING=1'),
};
const TAP_GATES = new Set(['unit-tests-node', 'unit-tests-tsx', 'unit-tests-e2e', 'scripts-lib-tests']);
// Gates whose failure key is the failing script's path in `.name` (BRO-5766).
const FILE_KEYED_GATES = new Set(['bash-integration', 'toplevel-regression']);
const TSC_GATES = new Set(['tsc', 'tsc-llm-scoring']);

// ── Parsers: gate output → Map<key, {file, name}> ───────────────────────────

// e2e-local (BRO-7106): one line per failing Playwright test, printed by
// scripts/lib/land-e2e-local-report.js, or one per infrastructure failure
// (build, server, missing browser, timeout) printed by land-e2e-local.sh.
// Key = `<spec file> > <title path>`, so a test red on base and branch alike
// is pre-existing and only a newly failing test counts.
function parseE2eLocalFailures(text) {
  const out = new Map();
  for (const raw of stripAnsi(text).split('\n')) {
    const m = /^::error::e2e-local gate failed: (.+?) \(exit \d+\)$/.exec(raw.trimEnd());
    if (m) out.set(`e2e-local::${m[1]}`, { file: 'e2e-local', name: m[1] });
  }
  return out;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

// Add a failure keyed `<file>::<name>`; a repeat of the SAME key in one run
// gets `#2`, `#3`, … so multiplicity counts: a branch that adds a second
// identical diagnostic to a file that already had one produces a NEW key.
function addWithMultiplicity(map, file, name) {
  const base = `${file}::${name}`;
  let key = base;
  for (let n = 2; map.has(key); n++) key = `${base} #${n}`;
  map.set(key, { file, name: key.slice(file.length + 2) });
}

function parseTscFailures(text) {
  const out = new Map();
  for (const line of stripAnsi(text).split('\n')) {
    // src/lib/x.ts(12,5): error TS2304: Cannot find name 'y'.
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trimEnd());
    if (!m) continue;
    // A symlinked node_modules resolves outside the tree, so tsc prints it relative to wherever
    // the run happened (../../../node_modules vs ../../../home/x/node_modules): key it by the part
    // that is the same on both sides (BRO-6252, base gates now run in a separate worktree).
    const file = m[1].trim();
    const nm = file.indexOf('node_modules/');
    addWithMultiplicity(out, nm > 0 && /^(\.\.\/)+/.test(file) ? file.slice(nm) : file, `${m[4]} ${m[5].trim()}`);
  }
  return out;
}

function parseNextLintFailures(text) {
  const out = new Map();
  let file = null;
  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // A non-indented path line opens a file block: ./src/app/page.tsx
    if (/^\.?\.?\/?[\w@][\w@./+-]*\.[A-Za-z]+$/.test(line) && !/\s/.test(line)) {
      // ESLint's stylish formatter prints absolute paths; key on the repo-relative one
      // so a base checkout in another directory compares equal.
      file = line.replace(/^\.\//, '').replace(/^\/.*?\/(?=src\/)/, '');
      continue;
    }
    // 12:5  Error: 'x' is defined but never used.  @typescript-eslint/no-unused-vars
    // (next's formatter does not indent detail lines; ESLint stylish does —
    // leading whitespace optional so both parse)
    const m = /^\s*(\d+):(\d+)\s+(Error|Warning|error|warning):?\s+(.*?)\s{2,}(\S+)\s*$/.exec(line);
    if (!m || !file) continue;
    if (!/^error$/i.test(m[3])) continue;
    addWithMultiplicity(out, file, `${m[5]} ${m[4].trim()}`);
  }
  return out;
}

function parseLintWorkflowsFailures(text) {
  const out = new Map();
  for (const raw of stripAnsi(text).split('\n')) {
    const line = raw.trimEnd();
    const m = /^::error::lint-workflows gate failed: (.+?) \(exit \d+\)$/.exec(line);
    if (m) { out.set(`lint-workflows::${m[1]}`, { file: 'lint-workflows', name: m[1] }); continue; }
    // actionlint: .github/workflows/x.yml:12:5: message [rule]
    const a = /^(\.github\/workflows\/[^:\s]+):(\d+):(\d+): (.*)$/.exec(line);
    if (a) addWithMultiplicity(out, 'lint-workflows', `actionlint ${a[1]}: ${a[4].trim()}`);
  }
  return out;
}

// bash-integration (BRO-4150): keyed by the failing test file's path, same
// one-line-per-check shape land-gauntlet.sh's bash_integration() emits.
function parseBashIntegrationFailures(text) {
  const out = new Map();
  for (const raw of stripAnsi(text).split('\n')) {
    const m = /^::error::bash-integration gate failed: (.+?) \(exit \d+\)$/.exec(raw.trimEnd());
    if (m) out.set(`bash-integration::${m[1]}`, { file: 'bash-integration', name: m[1] });
  }
  return out;
}

// toplevel-regression (BRO-5117): same file-path key as bash-integration.
function parseToplevelRegressionFailures(text) {
  const out = new Map();
  for (const raw of stripAnsi(text).split('\n')) {
    const m = /^::error::toplevel-regression gate failed: (.+?) \(exit \d+\)$/.exec(raw.trimEnd());
    if (m) out.set(`toplevel-regression::${m[1]}`, { file: 'toplevel-regression', name: m[1] });
  }
  return out;
}

// TAP failures re-keyed with their failureType (see KEYS above). A plain
// assertion failure keys `file::name [testCodeFailure]` on both sides — same
// key, same verdict; only a CHANGE of failure kind (subtests failed → file
// crashed at load) becomes a new key.
function parseTapGateFailures(text, treeRoot) {
  const out = new Map();
  for (const [key, v] of parseTapOutput(text, treeRoot).failures) {
    const ft = v.failureType && v.failureType !== 'subtestsFailed' ? ` [${v.failureType}]` : '';
    const name = `${v.name}${ft}`;
    // payload: aggregate guards (BRO-2793) are diffed on it by diffFailingSets.
    out.set(`${key}${ft}`, { file: v.file, name, payload: v.payload });
  }
  return out;
}

/** Map<key,{file,name}> of the failures a gate's captured output names. */
function parseGateFailures(gate, text, treeRoot) {
  if (TAP_GATES.has(gate)) return parseTapGateFailures(text, treeRoot);
  if (TSC_GATES.has(gate)) return parseTscFailures(text);
  if (gate === 'next-lint') return parseNextLintFailures(text);
  if (gate === 'lint-workflows') return parseLintWorkflowsFailures(text);
  if (gate === 'bash-integration') return parseBashIntegrationFailures(text);
  if (gate === 'toplevel-regression') return parseToplevelRegressionFailures(text);
  if (gate === 'e2e-local') return parseE2eLocalFailures(text);
  throw new Error(`land-gate-delta: no parser for gate ${JSON.stringify(gate)}`);
}

// ── The decision ────────────────────────────────────────────────────────────

// ── Shard manifests (BRO-7324 step A) ───────────────────────────────────────
// When a gate's result is the union of several runners' parts (step B's
// `land-gauntlet.sh --merge`), a part that is missing, was killed, or stopped
// before its final `# tests N` line would leave a merged log that looks like a
// smaller red run. With base red, that can read as "only pre-existing
// failures" and PASS a gate that never ran half its files. So a merged result
// dir carries `meta.json` `sharded: true` and one `<gate>.shards.json` per gate:
//   { "expected": ["1/2","2/2"], "parts": { "1/2": {"exit":1,"finished":true}, "2/2": null } }
// Any gap is an infrastructure failure: the gate is refused, never diffed.

const MAX_SHARDS = 16;

/** True when a TAP batch ran to its end: exit 0/1 and a final `# tests N` line. */
function tapRunFinished({ exit, text } = {}) {
  return (exit === 0 || exit === 1) && /^# tests \d+\s*$/m.test(text || '');
}

/**
 * One part's manifest record, from that runner's own exit and log. `whole`: the
 * gate ran entire on one runner (part "1/1"), so it is judged exactly as an
 * unsplit run would be: any ordinary exit counts as finished (a TAP gate with
 * nothing to run, or scoped to zero files, prints no `# tests N`). A slice of a
 * split TAP batch must reach its own `# tests N`. 124 (timeout) and 128+
 * (killed) never finish.
 */
function shardPart(gate, { exit, text } = {}, { whole = false } = {}) {
  const code = Number.isInteger(exit) ? exit : null;
  const finished = TAP_GATES.has(gate) && !whole ? tapRunFinished({ exit: code, text }) : (code !== null && code >= 0 && code < 124);
  return { exit: code, finished };
}

/** Pure. A gate's manifest entry → { complete, problems[] }. Anything odd is a problem. */
function checkShardManifest(gate, entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object' || entry.invalid) return { complete: false, problems: [entry && entry.invalid ? entry.invalid : 'shard manifest missing or unreadable'] };
  const expected = entry.expected;
  const parts = entry.parts;
  if (!Array.isArray(expected) || expected.length === 0 || !expected.every((k) => typeof k === 'string' && /^\d+\/\d+$/.test(k))) {
    return { complete: false, problems: ['shard manifest has no valid expected part list'] };
  }
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return { complete: false, problems: ['shard manifest has no parts object'] };
  const n = Number(expected[0].split('/')[1]);
  if (!(n >= 1 && n <= MAX_SHARDS)) return { complete: false, problems: [`shard count ${expected[0]} is outside 1..${MAX_SHARDS}`] };
  const want = Array.from({ length: n }, (_, i) => `${i + 1}/${n}`);
  if (expected.length !== n || want.some((k) => !expected.includes(k))) problems.push(`expected parts ${JSON.stringify(expected)} are not exactly 1/${n}..${n}/${n}`);
  if (n > 1 && !TAP_GATES.has(gate)) problems.push(`${gate} is not a TAP gate and cannot be split into ${n} parts`);
  for (const k of Object.keys(parts)) if (!expected.includes(k)) problems.push(`unexpected part ${k}`);
  for (const k of expected) {
    const part = parts[k];
    if (!part || typeof part !== 'object') { problems.push(`part ${k} is missing (its runner never reported)`); continue; }
    if (!Number.isInteger(part.exit)) { problems.push(`part ${k} has no exit code`); continue; }
    if ((TAP_GATES.has(gate) && n > 1 && part.exit !== 0 && part.exit !== 1) || part.exit < 0 || part.exit >= 124) { problems.push(`part ${k} exited ${part.exit} (killed or timed out)`); continue; }
    if (part.finished !== true) problems.push(`part ${k} did not finish (exit ${part.exit}, no final summary)`);
  }
  return { complete: problems.length === 0, problems };
}

/**
 * Pure. Does the merged exit/log agree with a complete manifest's parts? A
 * merge that dropped a red part's log or wrote exit 0 over a red part would
 * otherwise be judged on what survived.
 */
function mergedResultGaps(gate, merged, entry) {
  const parts = entry.expected.map((k) => entry.parts[k]);
  const allGreen = parts.every((p) => p.exit === 0);
  const gaps = [];
  if (allGreen !== (merged.exit === 0)) gaps.push(`merged exit ${merged.exit} disagrees with its parts' exits (${parts.map((p) => p.exit).join(', ')})`);
  if (TAP_GATES.has(gate) && parts.length > 1) {
    const summaries = ((merged.text || '').match(/^# tests \d+\s*$/gm) || []).length;
    if (summaries < parts.length) gaps.push(`merged log holds ${summaries} of ${parts.length} parts' final summaries (a part's log was lost)`);
  }
  return gaps;
}

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
  // BRO-7324: a merged result with a missing/killed/unfinished part is refused
  // before ANY verdict path, green included. Never downgraded to advisory.
  if (branch.shards !== undefined) {
    const m = checkShardManifest(gate, branch.shards);
    const gaps = m.complete ? mergedResultGaps(gate, branch, branch.shards) : m.problems;
    if (gaps.length) {
      return { gate, verdict: 'fail', mode: 'shard-incomplete', reason: `infrastructure failure, not your change: the split run is incomplete (${gaps.join('; ')}) — refusing rather than judge part of the gate`, newFailures: [], preExisting: [], fixed: [] };
    }
  }
  const baseShardGap = base && base.shards !== undefined && !checkShardManifest(gate, base.shards).complete;
  const baseKnown = !baseShardGap && base && typeof base.exit === 'number';
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
    const why = baseShardGap ? 'the base result is an incomplete split run, so it cannot vouch for anything' : !baseKnown ? 'no base result to diff against' : 'base is green';
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

/** Gates whose result in `dir` is not a clean exit 0, in GATES order. */
function redGates({ gates = GATES, dir, read = readGateResult }) {
  return gates.filter((gate) => {
    const r = read(dir, gate);
    return !r || r.exit !== 0;
  });
}

/**
 * Pure (BRO-5728, BRO-5766). Which files a base re-check of `gate` must run to
 * judge the branch's failures: only when every failure is located (`file::name`)
 * in a file the branch run actually ran for this gate. For bash-integration and
 * toplevel-regression the failing path is the key's `.name`. Anything else (a
 * non-TAP/non-file-keyed gate, a crash with nothing parsed, an unlocated `?::`
 * key, a location in a helper module, a budget-cut or timed-out script) runs
 * the gate in full. `isolated` (BRO-7134, the Codex runner): the scoped files are re-run alone on
 * the branch AND on base, so timing failures are scoped too instead of forcing a full run.
 * @param {{gate:string, branch:{exit:number|null,text:string,root?:string}|null, branchFiles:string[]|null, isolated?:boolean}} o
 * @returns {{gate:string, scoped:boolean, files:string[], reason:string}}
 */
function computeRerunScope({ gate, branch, branchFiles, isolated = false }) {
  const full = (reason) => ({ gate, scoped: false, files: [], reason });
  const fileKeyed = FILE_KEYED_GATES.has(gate);
  if (!TAP_GATES.has(gate) && !fileKeyed) return full('not keyed by test file');
  if (!branch || typeof branch.exit !== 'number') return full('no branch result');
  if (branch.exit === 0) return full('green on the branch');
  if (!Array.isArray(branchFiles) || branchFiles.length === 0) return full('the branch run recorded no file list');
  const failures = parseGateFailures(gate, branch.text, branch.root);
  if (failures.size === 0) return full('no failure could be parsed (crash/timeout?)');
  // BRO-7134: an isolated re-run only judges the files that printed a failure. A batch killed at
  // its time or output limit (exit not 1, or no final `# tests N` summary) never ran the rest, so
  // passing those few alone must not clear the gate: keep the batch verdict.
  if (isolated && (branch.exit !== 1 || !tapRunFinished(branch))) return full('the batch did not finish (killed or cut short)');
  // Normalized path -> the entry exactly as the gate listed it, so the
  // gauntlet matches its own spelling.
  const ran = new Map(branchFiles.map((p) => [normalizeTestPath(p), p]));
  const files = new Set();
  if (fileKeyed) {
    // A budget-cut key never ran; an exit-124 script timed out, maybe only
    // under full-batch load. Neither can be judged from a lone-file base run.
    for (const f of failures.values()) {
      if (/\[budget-exceeded-[^\]]*\]/.test(f.name)) return full(`budget-exceeded key "${f.name}"`);
    }
    const t = /^::error::\S+ gate failed: (.+?) \(exit 124\)$/m.exec(stripAnsi(branch.text).replace(/\r/g, '').replace(/[ \t]+$/gm, ''));
    if (t) return full(`timeout (exit 124) "${t[1]}"`);
    for (const f of failures.values()) {
      const file = normalizeTestPath(f.name);
      if (!ran.has(file)) return full(`failure located in ${file}, not a script of this gate`);
      files.add(ran.get(file));
    }
    const list = [...files].sort();
    return { gate, scoped: true, files: list, reason: `${list.length} file(s) hold all ${failures.size} failure(s)` };
  }
  for (const f of failures.values()) {
    if (!f.file || f.file === '?') return full(`unlocated failure "${f.name}"`);
    // A timeout or cancellation can come from full-batch load; alone on base it
    // may pass and turn a pre-existing failure into a refusal.
    // BRO-7134: with `isolated`, the caller re-runs these files alone on BOTH sides, so a
    // load-dependent timeout is judged alone vs alone and can be scoped like any failure.
    if (!isolated && / \[(testTimeoutFailure|cancelledByParent)\]$/.test(f.name)) return full(`timing failure "${f.name}"`);
    const file = normalizeTestPath(f.file);
    if (!ran.has(file)) return full(`failure located in ${file}, not a test file of this gate`);
    files.add(ran.get(file));
  }
  const list = [...files].sort();
  return { gate, scoped: true, files: list, reason: `${list.length} file(s) hold all ${failures.size} failure(s)` };
}

function normalizeTestPath(p) {
  return path.posix.normalize(String(p).trim().replace(/\\/g, '/')).replace(/^\.\//, '');
}

function readGateFiles(dir, gate) {
  try {
    return fs.readFileSync(path.join(dir, `${gate}.files`), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return null; }
}

/** Decide every gate. `read(dir, gate)` → {exit,text,root} | null. */
function decideAllGates({ gates = GATES, base, branch, read = readGateResult }) {
  return gates.map((gate) => {
    const branchResult = read(branch, gate);
    const d = decideGateDelta({ gate, base: base ? read(base, gate) : null, branch: branchResult });
    const advisoryWhy = ADVISORY_GATES[gate] ? ADVISORY_GATES[gate]() : null;
    // Only a gate that never ran ON THE BRANCH stays blocking. A base tree that
    // predates the gate (first land of it) also reaches fail-safe, and must not block.
    // A gate that produced no valid exit on the branch never ran: blocking too.
    if (d.verdict === 'pass' || !advisoryWhy || !branchResult || typeof branchResult.exit !== 'number' || d.mode === 'shard-incomplete') return d;
    return { ...d, verdict: 'pass', mode: 'advisory', reason: `ADVISORY (${advisoryWhy}): ${d.reason}` };
  });
}

/**
 * BRO-7950: the tests that fail on BOTH the branch and origin/main, flattened
 * across gates and deduped by file::name, for a second consumer (an
 * alert-router digest row) beyond the step-summary table. Pure; never changes
 * a verdict. Capped so a mass red cannot flood the digest.
 */
function preExistingAlertRows(decisions, { limit = 20 } = {}) {
  const seen = new Set();
  const rows = [];
  for (const d of decisions || []) {
    for (const f of (d && d.preExisting) || []) {
      const file = String((f && f.file) || '');
      const name = String((f && f.name) || '');
      const key = `${file}::${name}`;
      if (seen.has(key) || (!file && !name)) continue;
      seen.add(key);
      rows.push({ gate: d.gate, file, name });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
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
  const raw = fs.readFileSync(exitFile, 'utf8').trim();
  // An empty or garbled .exit file is "no exit", never Number('') === 0 (green).
  const exit = /^-?\d+$/.test(raw) ? Number(raw) : null;
  let text = '';
  try { text = fs.readFileSync(path.join(dir, `${gate}.log`), 'utf8'); } catch { text = ''; }
  const meta = readMeta(dir);
  const out = { exit: Number.isInteger(exit) ? exit : null, text, root: meta && meta.root ? meta.root : undefined };
  const shards = readShardEntry(dir, gate, meta);
  if (shards !== undefined) out.shards = shards;
  return out;
}

/**
 * The gate's shard manifest entry: undefined for an ordinary (unsplit) dir.
 * A dir marked `sharded` (or holding any manifest) must have a readable one
 * for EVERY gate; a gap becomes { invalid } so decideGateDelta refuses it.
 * Keep `<gate>.shards.json` beside `.exit` when a gate's log/exit is swapped
 * (land-local-check.js adoptAloneResult): it is what keeps a gap refused.
 */
function readShardEntry(dir, gate, meta) {
  const file = path.join(dir, `${gate}.shards.json`);
  // One runner's part of a split run that was never merged judges only a slice.
  if (meta && meta.mergeIncomplete) return { invalid: 'the split merge did not finish' };
  if (meta && meta.shard && !meta.sharded) return { invalid: `this dir is part ${meta.shard} of a split run that was never merged` };
  if (!fs.existsSync(file)) {
    if (meta && meta.sharded) return { invalid: `meta.json says the run was split but ${gate}.shards.json is missing` };
    // Any other gate's manifest also marks the dir as split (meta.json lost or overwritten).
    let other = false;
    try { other = fs.readdirSync(dir).some((f) => f.endsWith('.shards.json')); } catch { other = false; }
    return other ? { invalid: `other gates in this dir carry a split manifest but ${gate}.shards.json is missing` } : undefined;
  }
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    return entry && typeof entry === 'object' ? entry : { invalid: `${gate}.shards.json is not an object` };
  } catch (e) {
    return { invalid: `${gate}.shards.json is unreadable (${e.message})` };
  }
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

// Paths INERT_FOR_VERIFICATION_RE calls inert that a gate's verdict does
// depend on: the unit-test manifests (.txt — which files the batches run) and
// anything under tests/, plus tracked docs, because tests read them (the
// CLAUDE.md integrity audit, the .claude/CLOUD.md and AGENTS.md byte caps,
// docs/ and memory/ inventories). They are part of the cache key even though
// land-branch.js's re-check rule ignores most of them (Claude adversarial review;
// the byte-capped CLAUDE.md, AGENTS.md and .claude/CLOUD.md are NOT ignored, BRO-5732), and
// land-gauntlet-optimizer.js never skips the gauntlet for them: 8aa74a7f6
// landed CLOUD.md 503B over its cap through a skipped gauntlet and test.yml
// stayed red on main (BRO-5648). Doc-only commits were 15 of 2,980 on main in
// the 14 days before, about one extra gauntlet a day. data/audit/ data files
// stay out: bots rewrite them every few minutes, and tests read their snapshots
// as live checks.
const HASH_ALWAYS_RELEVANT_RE = /^(tests\/|docs\/|memory\/|cloud-memory\/|scripts\/lib\/claude-md-anchors\.json$)|\.md$/;

function isCacheKeyRelevant(file) {
  return HASH_ALWAYS_RELEVANT_RE.test(file) || !isInertForVerification(file);
}

/**
 * sha256 over `git ls-tree -r <sha>` minus INERT_FOR_VERIFICATION_RE paths
 * (except the always-relevant ones above). Two base shas that differ only in
 * bot data churn hash the same, so the cached base gauntlet is reused across
 * them; any code/workflow/test change hashes differently. `lsTree` is
 * injectable for tests. The private core data the unit batches read is NOT
 * in any tree here — land.yml salts the key per UTC day and re-decides any
 * refusal against a fresh base, which bounds that staleness.
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
    if (!isCacheKeyRelevant(file)) continue;
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
    console.log('usage: land-gate-delta.js --base-dir D --branch-dir D [--gates a,b] [--summary-file F] [--github-output F] [--base-source S] [--strict]\n       land-gate-delta.js --red-gates D [--gates a,b]\n       land-gate-delta.js --rerun-scope D --gates a,b --out S\n       land-gate-delta.js --code-hash <sha> [--cwd DIR]');
    return 0;
  }
  if (args['red-gates'] && args['red-gates'] !== true) {
    const gates = args.gates && args.gates !== true ? String(args.gates).split(',').map((g) => g.trim()).filter(Boolean) : GATES;
    console.log(redGates({ gates, dir: String(args['red-gates']) }).join(','));
    return 0;
  }
  if (args['rerun-scope'] && args['rerun-scope'] !== true) {
    const dir = String(args['rerun-scope']);
    const out = args.out && args.out !== true ? String(args.out) : null;
    if (!out) { console.error('usage: land-gate-delta.js --rerun-scope D --gates a,b --out S'); return 2; }
    const gates = args.gates && args.gates !== true ? String(args.gates).split(',').map((g) => g.trim()).filter(Boolean) : GATES;
    fs.mkdirSync(out, { recursive: true });
    for (const gate of gates) {
      const d = computeRerunScope({ gate, branch: readGateResult(dir, gate), branchFiles: readGateFiles(dir, gate) });
      if (d.scoped) fs.writeFileSync(path.join(out, `${gate}.files`), `${d.files.join('\n')}\n`);
      console.log(`${gate}: ${d.scoped ? 'base re-check scoped' : 'full base re-check'} — ${d.reason}`);
    }
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
  // --strict: the rollback switch (land.yml: repo variable LAND_STRICT_GATES=1)
  // — judge the branch with NO base at all, i.e. the pre-delta strict parity.
  const strict = args.strict === true || process.env.LAND_STRICT_GATES === '1';
  const baseDir = !strict && args['base-dir'] && args['base-dir'] !== true && fs.existsSync(path.join(String(args['base-dir']), 'meta.json')) ? String(args['base-dir']) : null;
  const gates = args.gates && args.gates !== true ? String(args.gates).split(',').map((s) => s.trim()).filter(Boolean) : GATES;
  const decisions = decideAllGates({ gates, base: baseDir, branch: branchDir });
  const baseMeta = baseDir ? readMeta(baseDir) : null;
  const branchMeta = readMeta(branchDir);

  for (const d of decisions) {
    console.log(`${d.verdict === 'pass' ? 'PASS' : 'FAIL'}  ${d.gate.padEnd(18)} ${d.mode.padEnd(9)} ${d.reason}`);
    for (const f of d.newFailures) console.log(`::${d.mode === 'advisory' ? 'warning' : 'error'}::${d.gate}: NEW failure on the branch (absent on origin/main): ${f.file}::${f.name}`);
    for (const f of d.preExisting) console.log(`  pre-existing (origin/main is red on this too, not blocking): ${f.file}::${f.name}`);
    for (const f of d.fixed) console.log(`  fixed by this branch: ${f.file}::${f.name}`);
  }
  const summary = formatSummary({ decisions, baseMeta, branchMeta, baseSource: strict ? 'NONE — strict mode (LAND_STRICT_GATES=1)' : args['base-source'] && args['base-source'] !== true ? String(args['base-source']) : null });
  if (args['summary-file'] && args['summary-file'] !== true) fs.appendFileSync(String(args['summary-file']), summary);
  else console.log(`\n${summary}`);
  const gate = firstFailingGate(decisions);
  if (args['github-output'] && args['github-output'] !== true) {
    const totals = decisions.reduce((t, d) => ({ n: t.n + d.newFailures.length, p: t.p + d.preExisting.length, f: t.f + d.fixed.length }), { n: 0, p: 0, f: 0 });
    fs.appendFileSync(String(args['github-output']), `gate=${gate}\nnew_failures=${totals.n}\npre_existing=${totals.p}\nfixed=${totals.f}\npre_existing_tests=${JSON.stringify(preExistingAlertRows(decisions))}\n`);
  }
  return gate ? 1 : 0;
}

module.exports = {
  GATES,
  ADVISORY_GATES,
  parseGateFailures,
  parseTscFailures,
  parseNextLintFailures,
  parseLintWorkflowsFailures,
  parseBashIntegrationFailures,
  parseTapGateFailures,
  parseE2eLocalFailures,
  addWithMultiplicity,
  isCacheKeyRelevant,
  decideGateDelta,
  tapRunFinished,
  shardPart,
  checkShardManifest,
  readShardEntry,
  mergedResultGaps,
  computeRerunScope,
  readGateFiles,
  decideAllGates,
  redGates,
  firstFailingGate,
  preExistingAlertRows,
  readGateResult,
  readMeta,
  formatSummary,
  computeCodeTreeHash,
  main,
};

if (require.main === module) {
  try {
    require('./exit-flushed.js').exitFlushed(main());
  } catch (err) {
    console.error(`land-gate-delta: fatal: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
