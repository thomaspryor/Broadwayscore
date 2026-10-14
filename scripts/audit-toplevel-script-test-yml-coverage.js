#!/usr/bin/env node
/**
 * Advisory guard (BRO-172 follow-up): flag top-level scripts/*.js files that
 * (a) are in the collected node batch (scripts/lib/unit-test-collection.js,
 * BRO-2483; formerly tests/unit-test-manifest.txt) or
 * tests/unit-test-manifest-tsx.txt (so CI DOES run their test — this is not
 * about untested scripts, most of the 900+ top-level scripts have no test at
 * all by design) but (b) have no matching entry in test.yml's `on.push.paths`
 * push-trigger allow-list, and so a solo push touching only that script (or
 * its colocated test) triggers ZERO CI even though the test exists and would
 * have caught the bug.
 *
 * Background: scripts/fix-platform-ticket-links.js had a region-mismatch bug
 * (Ticketmaster SERP re-verification silently overwrote a West End show's
 * correct ticketmaster.co.uk link with a wrong US ticketmaster.com page) that
 * regressed shows.json at least 6 times in the private data repo's history
 * before anyone noticed, because the script had no test.yml path entry at
 * all — nothing ever ran its logic on push. scripts/lib/** closed this gap
 * class for scripts/lib/ (task #1745); scripts/audit-test-yml-lib-deps.js and
 * scripts/audit-review-texts-test-yml-coverage.js catch two narrower shapes
 * of it. This is the general top-level-scripts/ version: any script sitting
 * in the manifest (proof a test exists and is meant to run in CI) but missing
 * from the push-path allow-list (proof a push touching it will ever fire).
 *
 * The CLI exits 0 always; the floor test in
 * audit-toplevel-script-test-yml-coverage.test.mjs (findGaps() === []) is
 * what blocks. Four shapes: a top-level scripts/*.test file and its sibling
 * source; a top-level source a tests/ file require()s (BRO-3202); a script a
 * push-running test.yml job executes (BRO-3207); a script a collected test or
 * scripts/lib/*.test.mjs names by path, literal or path.join (BRO-5261).
 *
 * Usage:
 *   node scripts/audit-toplevel-script-test-yml-coverage.js            # human-readable, exit 0 always
 *   node scripts/audit-toplevel-script-test-yml-coverage.js --json      # JSON output for CI/scripts
 */
'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const path = require('path');
const { readPushPaths, isCovered, resolveDepPath, relativeSpecifiers, stripComments } = require('./audit-test-yml-lib-deps.js');
const { readManifest } = require('./lib/test-manifest.js');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');
const { NODE_MANIFEST_REL, TSX_MANIFEST_REL, treeUsesCollector } = require('./lib/unit-test-collection.js');
const MANIFESTS = [
  path.join(ROOT, NODE_MANIFEST_REL),
  path.join(ROOT, TSX_MANIFEST_REL),
];

// scripts/*.test.(mjs|ts) directly under scripts/ (not scripts/lib/, not
// scripts/tests/) — those two subdirectories already have their own coverage
// (scripts/lib/** and scripts/tests/** globs, BRO-5309).
const TOPLEVEL_TEST_RE = /^scripts\/[^/]+\.test\.(mjs|ts)$/;

// tests/unit/*.test.(mjs|ts) — the SECOND shape (BRO-3202). These test files
// are themselves always covered, because test.yml push-lists 'tests/**'. The
// gap is the other direction: the top-level scripts/ SOURCE the test requires
// is usually not path-listed, so editing the source ALONE triggers zero CI
// while the test that would have caught it sits there un-run. That is the
// dangerous direction — the source is what changes behaviour.
//
// This was hand-listed four times before it was measured (check-orphan-
// commits.js, check-missed-broadcasts.js, freeze-ledgers.js, check-cloud-
// secrets.js, then audit-dependencies.js as #5), and each entry's comment
// notes that no audit catches the shape. Measuring it found 28 uncovered
// sources, so hand-listing was never going to converge. Neither sibling audit
// covers this: audit-test-yml-lib-deps.js walks only scripts/lib/*.test.mjs,
// and the TOPLEVEL_TEST_RE pass above matches only tests that live under
// scripts/ themselves.
const TESTS_DIR_TEST_RE = /^tests\/.+\.test\.(mjs|cjs|js|ts|tsx)$/;

// A dep worth reporting: any scripts/ source file OUTSIDE scripts/lib/ (which
// is already covered by the scripts/lib/** glob). Originally single-segment
// only, which missed scripts/llm-scoring/input-builder.ts — required by three
// manifest-registered tests and absent from on.push.paths (BRO-3202
// ship-check). Subdirectories under scripts/ are not special; they were just
// out of the first version's field of view.
const SOURCE_RE = /^scripts\/(?!lib\/).+\.(js|mjs|cjs|ts|tsx)$/;

/** Pure: filter raw manifest lines down to top-level scripts/*.test.(mjs|ts)
 * entries (excludes scripts/lib/, scripts/tests/, tests/, and blank/comment
 * lines). Exported separately from the disk read so it's unit-testable. */
function filterToplevelTestEntries(lines) {
  return lines.map((l) => l.trim()).filter((t) => t && TOPLEVEL_TEST_RE.test(t));
}

/** Pure: filter raw manifest lines down to tests/**\/*.test.(mjs|ts) entries.
 * Counterpart to filterToplevelTestEntries for the second gap shape. */
function filterTestsDirEntries(lines) {
  return lines.map((l) => l.trim()).filter((t) => t && TESTS_DIR_TEST_RE.test(t));
}

// BRO-2483: the node-batch path resolves to the collected list (readManifest
// special-cases it by name); the tombstone file is never parsed as a list.
function readManifestLines() {
  const lines = [];
  for (const manifestPath of MANIFESTS) {
    // Skip a missing file as before, unless it is the node manifest path in a
    // tree that collects (then the path names the collected batch, file or not).
    const collected = manifestPath === path.join(ROOT, NODE_MANIFEST_REL) && treeUsesCollector(ROOT);
    if (!collected && !fs.existsSync(manifestPath)) continue;
    lines.push(...readManifest(manifestPath, ROOT));
  }
  return lines;
}

function readManifestEntries() {
  return filterToplevelTestEntries(readManifestLines());
}

function readTestsDirEntries() {
  return filterTestsDirEntries(readManifestLines());
}

/** Pure: given a test file's source text and the directory it lives in, return
 * the repo-relative top-level scripts/ files it require()s or imports. Reuses
 * relativeSpecifiers + resolveDepPath from audit-test-yml-lib-deps.js so
 * specifier parsing and extension resolution stay identical across the two
 * audits (a second copy would drift — and the first copy of that regex had a
 * multi-line blind spot, see the comment on REQUIRE_RE there). */
function toplevelScriptDeps(src, fromDir) {
  const out = new Set();
  for (const rel of relativeSpecifiers(src)) {
    const abs = resolveDepPath(fromDir, rel);
    if (!abs) continue; // package import, or nothing on disk
    const repoRel = path.relative(ROOT, abs);
    if (SOURCE_RE.test(repoRel)) out.add(repoRel);
  }
  return Array.from(out).sort();
}

/** Pure: top-level scripts/ files a test NAMES by path, outside require():
 *   - a quoted repo-relative literal: execFileSync(node, ['scripts/x.js']),
 *     readFileSync('scripts/x.js');
 *   - a path.join()/path.resolve() of string literals, the shape a CLI test
 *     uses to spawn the script: path.join(here, '..', 'discard-stuck-broadcast-drafts.js').
 *     The first identifier argument is read as the test's own directory, else
 *     the repo root is tried. A call with a template segment is skipped.
 * Comments are stripped first. A require() parse never sees these, so a solo
 * edit to such a script ran zero CI (BRO-3087 retro-review, BRO-5261).
 * `exists` is injectable for tests. */
const PATH_CALL_RE = /path\.(?:join|resolve)\(([^()]*)\)/g;
const SCRIPT_LITERAL_RE = /(['"`])(scripts\/[\w./-]+\.(?:js|mjs|cjs))\1/g;
function pathJoinedScriptDeps(src, fromDir, exists = (abs) => fs.existsSync(abs) && fs.statSync(abs).isFile()) {
  const code = stripComments(src);
  const out = new Set();
  const keep = (abs) => {
    const repoRel = path.relative(ROOT, abs);
    if (repoRel.startsWith('..') || !SOURCE_RE.test(repoRel) || !exists(abs)) return false;
    out.add(repoRel);
    return true;
  };
  for (const m of code.matchAll(SCRIPT_LITERAL_RE)) keep(path.join(ROOT, m[2]));
  for (const m of code.matchAll(PATH_CALL_RE)) {
    if (m[1].includes('${')) continue;
    const segs = [...m[1].matchAll(/(['"`])([^'"`]+)\1/g)].map((x) => x[2]);
    const last = segs[segs.length - 1];
    if (!last || !/\.(js|mjs|cjs)$/.test(last)) continue;
    for (const base of [fromDir, ROOT]) if (keep(path.resolve(base, ...segs))) break;
  }
  return Array.from(out).sort();
}

function siblingSourcePath(testRelPath) {
  // scripts/foo.test.mjs -> scripts/foo.js ; scripts/foo.test.ts -> scripts/foo.ts
  const m = testRelPath.match(/^(scripts\/[^/]+)\.test\.(mjs|ts)$/);
  if (!m) return null;
  const [, stem, ext] = m;
  const candidate = ext === 'ts' ? `${stem}.ts` : `${stem}.js`;
  return fs.existsSync(path.join(ROOT, candidate)) ? candidate : null;
}

// --- BRO-3207: the third shape — a script test.yml itself EXECUTES from a
// `run:` step in a job that runs on push, with no push-path entry of its own.
// Editing such a script alone triggers zero CI, so the step that would have
// run it never fires (scripts/test-temporal-override-regression.js, the
// CLAUDE.md §12 scoring gate, was one of 14 hand-listed in BRO-3202).
//
// Job-aware on purpose: a job whose `if:` limits it to schedule /
// workflow_dispatch never runs on push, and a push-path entry for a script
// only that job runs buys nothing. Flagging those would train people to add
// dead entries. When an `if:` can't be understood the job is assumed to run on
// push, so the audit over-reports rather than under-reports.

/** Split an expression on top-level `||` (ignoring ones inside parens). */
function splitTopLevelOr(expr) {
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0 && c === '|' && expr[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function stripOuterParens(expr) {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let i = 0; i < e.length - 1; i++) {
      if (e[i] === '(') depth++;
      else if (e[i] === ')') depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (!wraps) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/** Pure: can a job with this `if:` expression run on a `push` event?
 * False only when EVERY top-level `||` branch is a plain `&&` chain containing
 * `github.event_name == '<not push>'` (or `!= 'push'`). Anything else —
 * no event_name test, negation, nested `||`, unparseable — returns true. */
function jobRunsOnPush(ifExpr) {
  if (!ifExpr || !ifExpr.trim()) return true;
  const expr = ifExpr.replace(/^\$\{\{|\}\}$/g, '').trim();
  if (!/github\.event_name/.test(expr)) return true;
  return splitTopLevelOr(expr).some((branch) => {
    const b = stripOuterParens(branch);
    if (/\|\||!\s*\(|!\s*github/.test(b)) return true; // can't reason about it: assume push
    const excludesPush = [...b.matchAll(/github\.event_name\s*(==|!=)\s*'([^']+)'/g)]
      .some(([, op, ev]) => (op === '==' && ev !== 'push') || (op === '!=' && ev === 'push'));
    return !excludesPush;
  });
}

/** Pure: parse test.yml into [{ name, ifExpr, runLines }] — indentation-aware
 * line scan in the style of readPushPaths (no YAML dependency). `runLines` are
 * the lines of `run:` step bodies only (inline or block scalar), never
 * comments or `name:` text. */
function parseJobs(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) throw new Error("could not find 'jobs:' in test.yml");
  const jobs = [];
  let job = null, ifIndent = -1, runIndent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && !trimmed.startsWith('#')) break; // next top-level key
    if (trimmed.startsWith('#')) continue;
    // Block scalar continuation (`if: >` / `run: |`): deeper than its key.
    if (ifIndent >= 0) {
      if (indent > ifIndent) { job.ifExpr += ' ' + trimmed; continue; }
      ifIndent = -1;
    }
    if (runIndent >= 0) {
      if (indent > runIndent) { job.runLines.push(trimmed); continue; }
      runIndent = -1;
    }
    let m;
    if (indent === 2 && (m = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/))) {
      job = { name: m[1], ifExpr: '', runLines: [] };
      jobs.push(job);
    } else if (job && indent === 4 && (m = trimmed.match(/^if:\s*(.*)$/))) {
      const v = m[1].trim();
      if (/^[>|][+-]?$/.test(v)) { ifIndent = indent; job.ifExpr = ''; } else job.ifExpr = v;
    } else if (job && (m = trimmed.match(/^(?:-\s+)?run:\s*(.*)$/))) {
      const v = m[1].trim();
      if (/^[>|][+-]?$/.test(v)) runIndent = indent + (trimmed.startsWith('-') ? 2 : 0);
      else if (v) job.runLines.push(v);
    }
  }
  return jobs;
}

// Every `scripts/<file>` operand of a node/tsx/bash/sh command segment, so
// flag values (`--test-timeout 60000`, `-r dotenv/config`), several files after
// `node --test`, and `./scripts/x.js` are all caught. Segments are split on
// shell separators and a segment only counts when it starts with the command
// (optionally `npx`), so `echo "Run: node scripts/x.js"` text is not a step.
const SEGMENT_SPLIT_RE = /&&|\|\||;|\|/;
const COMMAND_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|timeout\s+\d+\S*|time|npx|sudo)\s+)*(node|tsx|bash|sh)\s+(.*)$/;
const SCRIPT_OPERAND_RE = /(?:^|\s|=)(?:\.\/)?(scripts\/[\w./-]+\.(?:js|mjs|cjs|ts|sh))(?=\s|$|['"])/g;

/** Pure: repo-relative scripts a run-step body line executes. */
function scriptsExecutedBy(line) {
  const out = [];
  for (const segment of line.split(SEGMENT_SPLIT_RE)) {
    const m = segment.trim().match(COMMAND_RE);
    if (!m) continue;
    const [, cmd, rest] = m;
    for (const [, rel] of rest.matchAll(SCRIPT_OPERAND_RE)) {
      if (rel.endsWith('.sh') ? (cmd === 'bash' || cmd === 'sh') : (cmd === 'node' || cmd === 'tsx')) out.push(rel);
    }
  }
  return out;
}

/** Pure: join backslash-continued shell lines so a command split across lines
 * is matched as one. */
function joinContinuations(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const piece = cur === null ? l : `${cur} ${l}`;
    if (piece.endsWith('\\')) cur = piece.slice(0, -1).trimEnd();
    else { out.push(piece); cur = null; }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Pure: gaps for scripts a push-running job executes but push.paths misses.
 * `exists(rel)` is injected so tests don't need real files. */
function findWorkflowRunGaps(yml, pathEntries, exists = (rel) => fs.existsSync(path.join(ROOT, rel))) {
  const gaps = [];
  const seen = new Set();
  for (const job of parseJobs(yml)) {
    if (!jobRunsOnPush(job.ifExpr)) continue;
    for (const line of joinContinuations(job.runLines)) {
      for (const rel of scriptsExecutedBy(line)) {
        if (seen.has(rel) || !exists(rel) || isCovered(rel, pathEntries)) continue;
        seen.add(rel);
        gaps.push({
          test: `test.yml:${job.name}`,
          testCovered: true,
          source: rel,
          sourceCovered: false,
          via: 'workflow-run',
        });
      }
    }
  }
  return gaps;
}

function findGaps() {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const pathEntries = readPushPaths(yml);
  const gaps = [];

  for (const testRelPath of readManifestEntries()) {
    const testCovered = isCovered(testRelPath, pathEntries);
    const sourceRelPath = siblingSourcePath(testRelPath);
    const sourceCovered = sourceRelPath ? isCovered(sourceRelPath, pathEntries) : true; // no sibling source = nothing more to check

    if (!testCovered || !sourceCovered) {
      gaps.push({
        test: testRelPath,
        testCovered,
        source: sourceRelPath,
        sourceCovered,
        via: 'sibling',
      });
    }
  }

  // Second shape (BRO-3202): manifest-registered tests under tests/ whose
  // required scripts/ source has no push-path entry. The test file is covered
  // by the 'tests/**' glob; the source is the uncovered half.
  //
  // `seen` is seeded from the first loop's gaps so one source can't be reported
  // twice under two different `via` values (ship-check finding).
  const seen = new Set(gaps.map((g) => g.source).filter(Boolean));
  for (const testRelPath of readTestsDirEntries()) {
    const abs = path.join(ROOT, testRelPath);
    if (!fs.existsSync(abs)) continue; // stale manifest row — not this audit's job
    const src = fs.readFileSync(abs, 'utf8');
    for (const sourceRelPath of toplevelScriptDeps(src, path.dirname(abs))) {
      if (isCovered(sourceRelPath, pathEntries)) continue;
      if (seen.has(sourceRelPath)) continue; // report each source once
      seen.add(sourceRelPath);
      gaps.push({
        test: testRelPath,
        testCovered: true, // 'tests/**' glob
        source: sourceRelPath,
        sourceCovered: false,
        via: 'require',
      });
    }
  }

  // Fourth shape (BRO-5261): any collected test that spawns a top-level script
  // by path (literal or joined), plus scripts/lib/*.test.mjs (run by test.yml's own glob,
  // not the manifest).
  const libTests = fs.readdirSync(path.join(ROOT, 'scripts', 'lib')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scripts/lib/${f}`);
  const collected = readManifestLines().map((l) => l.trim()).filter((t) => t && /\.test\.(mjs|cjs|js|ts)$/.test(t));
  for (const testRelPath of [...new Set([...collected, ...libTests])]) {
    const abs = path.join(ROOT, testRelPath);
    if (!fs.existsSync(abs)) continue;
    for (const sourceRelPath of pathJoinedScriptDeps(fs.readFileSync(abs, 'utf8'), path.dirname(abs))) {
      if (isCovered(sourceRelPath, pathEntries) || seen.has(sourceRelPath)) continue;
      seen.add(sourceRelPath);
      gaps.push({ test: testRelPath, testCovered: isCovered(testRelPath, pathEntries), source: sourceRelPath, sourceCovered: false, via: 'path-named' });
    }
  }

  // Third shape (BRO-3207): scripts test.yml itself runs on push. Dedupe against
  // sources already reported above.
  for (const g of findWorkflowRunGaps(yml, pathEntries)) {
    if (seen.has(g.source)) continue;
    seen.add(g.source);
    gaps.push(g);
  }

  return gaps;
}

const USAGE = `Usage:
  node scripts/audit-toplevel-script-test-yml-coverage.js            # human-readable, exit 0 always
  node scripts/audit-toplevel-script-test-yml-coverage.js --json      # JSON output for CI/scripts
`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const gaps = findGaps();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ gaps }, null, 2));
  } else if (gaps.length === 0) {
    console.log('audit-toplevel-script-test-yml-coverage: no gaps found — every manifest-registered top-level scripts/*.test file (and its sibling source) is path-listed in test.yml.');
  } else {
    console.log(`::warning::audit-toplevel-script-test-yml-coverage: ${gaps.length} top-level script source(s) a test depends on are NOT (fully) covered by test.yml's on.push.paths allow-list (a solo push touching only these files triggers zero CI even though a test exists):`);
    for (const g of gaps) {
      const parts = [];
      if (!g.testCovered) parts.push(`test file ${g.test} missing`);
      if (g.source && !g.sourceCovered) parts.push(`source file ${g.source} missing`);
      console.log(`  ${g.test} -> ${parts.join('; ')}${g.via === 'workflow-run' ? ' (executed by a push-running job)' : ''}`);
    }
    console.log("Add the missing path(s) to on.push.paths in .github/workflows/test.yml.");
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = {
  readManifestEntries, filterToplevelTestEntries, siblingSourcePath, findGaps,
  readTestsDirEntries, filterTestsDirEntries, toplevelScriptDeps,
  jobRunsOnPush, parseJobs, findWorkflowRunGaps, scriptsExecutedBy, joinContinuations, pathJoinedScriptDeps,
};

if (require.main === module) main();
