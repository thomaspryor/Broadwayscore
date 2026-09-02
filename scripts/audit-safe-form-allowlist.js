#!/usr/bin/env node
/**
 * audit-safe-form-allowlist.js — mechanically re-verify the read-only claim
 * behind every basename on the safe-form generic audit-/lint- allowlist in
 * scripts/lib/autonomous-triage-core.js (BRO-2718).
 *
 * WHY THIS EXISTS
 * The allowlist's own comment states the admission standard: a basename may
 * only be listed if it has "ZERO fs.writeFileSync/appendFileSync/renameSync/
 * unlinkSync/mkdirSync calls anywhere in the file", and warns that "nothing
 * here detects a new violator automatically". That was true — the standard
 * was enforced once, by hand, at admission time. Adding a write to an
 * already-listed script, or listing a script from memory without the grep,
 * silently converts an injection gate into a write primitive: checkableDone
 * text is LLM-authored from untrusted card notes and is EXECUTED by a later
 * sprint (see autonomous-triage-core.js's threat model comment).
 *
 * This script makes the standard continuously enforced instead:
 *   - default mode  : every basename the LIVE gate accepts must still scan clean
 *                     (exit 1 if not). Wired into a unit test + CI.
 *   - --candidates  : list audit-/lint- scripts that would scan clean but are
 *                     NOT yet allowlisted, so widening is evidence-driven.
 *
 * The allowlist is read from the exported constant, and separately
 * cross-checked against the LIVE gate (explainUnsafeCheckCommand) so the two
 * cannot drift — see genericFormBasenames() for why probing alone is not
 * enough to identify which SAFE_CHECK_FORMS entry admitted a basename.
 *
 * READ-ONLY: prints only. No fs writes anywhere in this file.
 *
 * Usage:
 *   node scripts/audit-safe-form-allowlist.js            # gate mode (exit 1 on violation)
 *   node scripts/audit-safe-form-allowlist.js --json     # machine-readable, same exit codes
 *   node scripts/audit-safe-form-allowlist.js --candidates
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO, 'scripts');

// fs mutation APIs.
//
// Matched with NO required leading dot: `const { writeFile } = require('fs/
// promises'); await writeFile(p, s)` and `const { writeFileSync } =
// require('fs')` are idiomatic in this repo and mutate exactly as much as
// `fs.writeFileSync` does. An earlier cut of this regex required `\.<name>(`
// and would have scanned both of those clean — the single highest-severity
// finding of the adversarial review of this file. The lookbehind still keeps
// `process.stdout.write(` out (`write` is not in the list) and
// `res.writeHead(` out (nor is `writeHead`).
//
// This is deliberately fail-CLOSED: a local helper coincidentally named
// `rm()` or `link()` trips it and its script is simply not allowlisted, which
// costs one card an acceptance command. The opposite error costs an
// injection gate.
const FS_WRITE_METHODS = [
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'renameSync', 'rename', 'unlinkSync', 'unlink', 'rmSync', 'rm',
  'rmdirSync', 'rmdir', 'mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp',
  'copyFileSync', 'copyFile', 'cpSync', 'createWriteStream',
  'truncateSync', 'truncate', 'ftruncateSync', 'writeSync',
  'symlinkSync', 'symlink', 'linkSync', 'link', 'chmodSync', 'chmod',
  'utimesSync', 'utimes', 'openSync',
];
const FS_WRITE_RE = new RegExp(`(?<![\\w$])(?:${FS_WRITE_METHODS.join('|')})\\s*\\(`);

// Constructs that defeat static scanning outright: code this scanner can
// never have read. `eval` / `new Function` / `vm` / `worker_threads`, and a
// require/import whose specifier is a COMPUTED expression (concatenation,
// template literal, member access, call result).
//
// `require(SOME_CONST)` — a bare identifier — is deliberately NOT flagged.
// This repo's audit scripts routinely do `require(SHOWS_PATH)` to load a JSON
// data file, and treating that as a hazard disqualified
// audit-review-contamination.js, an entry that has been on the allowlist and
// working since task #1827. The threat model here is an untrusted CARD naming
// an existing repo script, not an attacker authoring the script — a committed
// script that wanted to write could call fs directly. Flagging genuinely
// unreadable specifiers is worth it; flagging a constant is not.
//
// The lookahead enumerates the two SAFE argument forms — a lone string
// literal, or a lone identifier — and flags everything else, rather than
// enumerating unsafe ones. A first cut wrote the lookahead as `(?!['"]|IDENT)`
// and let `require('./lib/' + name + '.js')` through: the argument STARTS with
// a quote, so "not a quote" was false, while REQUIRE_RE also declined to
// follow it (it needs `['"]...['"]\s*\)`). Unflagged and unwalked is the exact
// hole this check exists to close; the test suite pins it.
const DYNAMIC_RE = /require\(\s*(?!(?:['"][^'"]*['"]|[A-Za-z_$][A-Za-z0-9_$]*)\s*\))|(?<![.\w$])import\s*\(|(?<![.\w$])eval\s*\(|new\s+Function\s*\(|process\.binding\s*\(|require\(\s*['"](?:node:)?(?:worker_threads|vm)['"]\s*\)/;

// Shelling out is a write primitive we cannot statically bound (`git commit`,
// `rm`, a `gh api -X POST`). A script that spawns anything is refused rather
// than argv-analysed — this gate fails closed by design.
//
// The lookbehind matters: `re.exec(src)` and `m.exec(line)` are RegExp reads,
// not process spawns, and this repo's audit scripts are full of them (a first
// cut without it reported audit-help-flag-safety.js as a spawner on six
// separate RegExp lines). Requiring the call NOT be a property access keeps
// `child_process.exec(...)` — which IS a spawn — matched via the
// require-detection half of the alternation instead.
const SPAWN_RE = /require\(\s*['"](?:node:)?child_process['"]\s*\)|(?<![.\w$])(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(/;

// A check command is executed unattended. One that reaches the network can
// burn metered credits (ScrapingBee/Bright Data), trip a rate limit, or POST
// to Notion/Linear/Resend — none of which `git status` would show afterwards,
// so the fs-write scan alone would call it clean. Refused for the generic
// form; an individually-vetted narrow entry can still opt in with a written
// justification (scripts/lib/check-sb-credits.js does exactly that, and is
// admitted through its OWN regex entry, not through this basename set).
const NETWORK_RE = /require\(\s*['"](?:node:)?(?:https?|net|tls|dgram)['"]\s*\)|(?<![.\w$])fetch\s*\(|\baxios\b|\bnode-fetch\b|\bfetchPage\s*\(|require\(\s*['"][^'"]*\/(?:scraper|linear-client|notion-client|serp)[^'"]*['"]\s*\)/;

// Local relative requires only. Bare specifiers (node builtins, npm deps) are
// not followed: `fs` itself is the thing being checked for, and an npm dep
// writing to the repo tree is out of scope for a per-script read-only claim.
const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Blank out comment TEXT without moving anything.
 *
 * Two properties matter and a naive `.replace(..., ' ')` has neither:
 *  - Line numbers must survive, so a block comment is replaced character-for-
 *    character with spaces (newlines preserved) rather than collapsed.
 *  - Stripping must never HIDE code. A `//` inside a regex literal or a URL is
 *    not a comment, and a naive `[^:]//.*$` strip deletes the rest of that
 *    line: `const re = /a\/\/b/; fs.writeFileSync(p, s)` scans CLEAN under it
 *    (found by the adversarial review of this file). Writing a JS lexer to be
 *    sure is out of proportion; instead a line comment is only recognised
 *    where a real one can start — at the beginning of a line, or immediately
 *    after `;`, `,`, `{`, `}`, `)`, `]` — which no `//` inside a regex literal,
 *    string or URL can satisfy. The residual error is a comment left UNstripped
 *    (a false positive: the script is merely not allowlisted), never code
 *    silently removed.
 */
const LINE_COMMENT_RE = /(^[ \t]*|[;,{}()\]][ \t]*)\/\/[^\n]*/gm;
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(LINE_COMMENT_RE, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * TRANSITIVE-SCAN BASELINE — only ever shrink this.
 *
 * The allowlist's stated admission standard is file-scoped: "ZERO
 * fs.writeFileSync/... calls anywhere in the FILE". Every existing entry was
 * hand-checked against exactly that. Walking the require graph instead — which
 * this script also does, because a script that merely delegates its writes to
 * a helper is no more read-only than one that inlines them — is a STRICTER bar
 * that one grandfathered entry does not clear:
 *
 *   audit-review-contamination.js pulls a 64-module graph that includes
 *   scripts/lib/scraper.js (network), review-write-guard.js and
 *   url-change-invariant.js (both write review-text files). Nothing here
 *   proves those code paths are REACHABLE from its main() — a `require` runs a
 *   module's top level, not its exported writers — so this is an unproven
 *   claim, not a demonstrated leak.
 *
 * Removing it outright would disarm live cards on no evidence, so it is
 * baselined: the direct-file gate below still applies to it in full, and the
 * transitive result is reported as advisory. Discharge this entry by tracing
 * (or severing) the graph, never by adding a second name to it — a NEW
 * basename must clear both bars, which is why every basename added in BRO-2718
 * is transitively clean.
 */
const TRANSITIVE_SCAN_BASELINE = new Set([
  'audit-review-contamination.js',
]);

/**
 * Walk a script for mutation hazards.
 *
 * @param {string} entryFile absolute path to the script
 * @param {{transitive?: boolean}} opts transitive:false scans ONLY entryFile
 *   (the allowlist's own stated file-scoped standard); transitive:true (the
 *   default) also follows local relative requires.
 * Returns { clean, hazards: [{file, kind, line, text}], visited }.
 */
function scanReadOnly(entryFile, opts = {}) {
  const transitive = opts.transitive !== false;
  const hazards = [];
  const visited = new Set();
  const queue = [entryFile];

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      hazards.push({ file: path.relative(REPO, file), kind: 'unreadable', line: 0, text: '' });
      continue;
    }
    const src = stripComments(raw);
    const rawLines = raw.split('\n');
    const rel = path.relative(REPO, file);

    // EVERY hazard kind on a line is recorded, not the first match only: an
    // if/else-if chain would report a line's fs-write and hide that the same
    // line also spawns. That never changed the pass/fail verdict (any hazard
    // means not clean) but it made the report lie about what a script does.
    src.split('\n').forEach((line, i) => {
      const text = (line.trim() || (rawLines[i] ?? '').trim()).slice(0, 140);
      if (FS_WRITE_RE.test(line)) hazards.push({ file: rel, kind: 'fs-write', line: i + 1, text });
      if (SPAWN_RE.test(line)) hazards.push({ file: rel, kind: 'spawn', line: i + 1, text });
      if (NETWORK_RE.test(line)) hazards.push({ file: rel, kind: 'network', line: i + 1, text });
      if (DYNAMIC_RE.test(line)) hazards.push({ file: rel, kind: 'dynamic', line: i + 1, text });
    });

    if (!transitive) continue;
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src)) !== null) {
      const dep = resolveLocal(file, m[1]);
      if (dep && !visited.has(dep)) queue.push(dep);
    }
  }

  return { clean: hazards.length === 0, hazards, visited: [...visited].map(f => path.relative(REPO, f)) };
}

/** All scripts/(audit|lint)-*.js basenames on disk. */
function auditLintScripts() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter(f => /^(?:audit|lint)-[A-Za-z0-9_-]+\.js$/.test(f))
    .sort();
}

/**
 * The generic audit-/lint- form's basename set — the ONLY part of
 * SAFE_CHECK_FORMS this gate governs.
 *
 * Read from the exported constant, not derived by probing, because probing
 * cannot tell the generic form apart from the individually-vetted narrow
 * regex entries above it in SAFE_CHECK_FORMS. Those narrow entries hold
 * scripts that DO write under other flags (audit-sibling-title-misroute.js
 * writes review-text files under --fix; audit-cv-flag-contradiction.js writes
 * a baseline under --update-baseline) and are admitted bare-only after a
 * human read the flag guards. Auditing them against a zero-write standard
 * they were never held to would produce 6 permanent false failures and train
 * the next reader to ignore this gate.
 */
function genericFormBasenames() {
  const core = require('./lib/autonomous-triage-core.js');
  const set = core.AUDIT_LINT_GENERIC_FORM_ALLOWED;
  if (!set || typeof set.has !== 'function') {
    throw new Error(
      'autonomous-triage-core.js no longer exports AUDIT_LINT_GENERIC_FORM_ALLOWED — ' +
      'this audit cannot verify the allowlist it is supposed to gate. Fix the export; ' +
      'do not weaken this to a probe (see genericFormBasenames comment).'
    );
  }
  return [...set].sort();
}

/**
 * Cross-check: every basename in the constant must actually be accepted by
 * the live gate, and no basename outside it may be. Catches the constant and
 * the regex drifting apart (e.g. a name added with a typo, or a second form
 * quietly admitting a basename).
 */
function gateAgreementFailures(explain, listed) {
  const listedSet = new Set(listed);
  const failures = [];
  for (const name of listed) {
    // --gate is accepted by the generic form for ANY listed basename; none of
    // the narrow per-script entries above it accept that flag, so this probes
    // the generic form specifically.
    if (!explain(`node scripts/${name} --gate`).ok) {
      failures.push({ name, kind: 'listed-but-refused' });
    }
  }
  for (const name of auditLintScripts()) {
    if (listedSet.has(name)) continue;
    if (explain(`node scripts/${name} --gate`).ok) {
      failures.push({ name, kind: 'accepted-but-not-listed' });
    }
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const JSON_OUT = args.includes('--json');
  const CANDIDATES = args.includes('--candidates');

  const { explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');

  // Names on the allowlist that have no file on disk yet are admitted by
  // shape only (the allowlist comment documents this for
  // audit-worktree-unpushed.js) — they cannot be scanned, but they also
  // cannot execute. Probing over on-disk files alone would silently drop
  // them from the audit, so surface them explicitly.
  const onDisk = new Set(auditLintScripts());
  const allowed = genericFormBasenames();
  const agreement = gateAgreementFailures(explainUnsafeCheckCommand, allowed);

  const violations = [];   // hard fail
  const advisory = [];     // baselined transitive-only findings
  const staleBaseline = []; // baselined but now clean — shrink the baseline
  const verified = [];
  for (const name of allowed) {
    if (!onDisk.has(name)) continue; // shape-only admission; nothing to scan, cannot execute
    const file = path.join(SCRIPTS_DIR, name);
    const direct = scanReadOnly(file, { transitive: false });
    const graph = scanReadOnly(file);

    if (!direct.clean) {
      // The file-scoped standard the allowlist itself states. Never baselined.
      violations.push({ name, scope: 'direct', hazards: direct.hazards.slice(0, 6), hazardCount: direct.hazards.length });
      continue;
    }
    if (graph.clean) {
      verified.push({ name, files: graph.visited.length });
      if (TRANSITIVE_SCAN_BASELINE.has(name)) staleBaseline.push(name);
    } else if (TRANSITIVE_SCAN_BASELINE.has(name)) {
      advisory.push({ name, hazards: graph.hazards.slice(0, 4), hazardCount: graph.hazards.length });
    } else {
      violations.push({ name, scope: 'transitive', hazards: graph.hazards.slice(0, 6), hazardCount: graph.hazards.length });
    }
  }

  let candidates = [];
  if (CANDIDATES) {
    const allowedSet = new Set(allowed);
    for (const name of auditLintScripts()) {
      if (allowedSet.has(name)) continue;
      const res = scanReadOnly(path.join(SCRIPTS_DIR, name));
      if (res.clean) candidates.push({ name, files: res.visited.length });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    allowedCount: allowed.length,
    verifiedCount: verified.length,
    violationCount: violations.length,
    shapeOnlyNotOnDisk: allowed.filter(n => !onDisk.has(n)),
    advisoryCount: advisory.length,
    violations,
    advisory,
    staleBaseline,
    gateAgreementFailures: agreement,
    ...(CANDIDATES ? { candidateCount: candidates.length, candidates } : {}),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`safe-form allowlist audit — ${allowed.length} basename(s) accepted by the live gate`);
    for (const v of verified) console.log(`  ✅ ${v.name} (read-only across ${v.files} file(s) in its require graph)`);
    for (const v of advisory) {
      console.log(`  ⚪ ${v.name} — direct-clean; ${v.hazardCount} transitive hazard(s), BASELINED:`);
      for (const h of v.hazards) console.log(`       ${h.kind} ${h.file}:${h.line} ${h.text}`);
    }
    for (const n of staleBaseline) console.log(`  🧹 ${n} — now transitively clean; remove it from TRANSITIVE_SCAN_BASELINE`);
    for (const v of violations) {
      console.log(`  ❌ ${v.name} — ${v.hazardCount} ${v.scope} hazard(s):`);
      for (const h of v.hazards) console.log(`       ${h.kind} ${h.file}:${h.line} ${h.text}`);
    }
    if (CANDIDATES) {
      console.log(`\ncandidates (scan clean, NOT yet allowlisted): ${candidates.length}`);
      for (const c of candidates) console.log(`  + ${c.name} (${c.files} file(s))`);
    }
  }

  if (!JSON_OUT) {
    for (const f of agreement) console.log(`  ⚠️  gate disagreement: ${f.name} — ${f.kind}`);
  }

  if (violations.length > 0 || agreement.length > 0) {
    if (!JSON_OUT) {
      if (violations.length > 0) {
        console.error(`\n❌ ${violations.length} allowlisted basename(s) can mutate state or reach the network.`);
        console.error(`   Remove them from AUDIT_LINT_GENERIC_FORM_ALLOWED in`);
        console.error(`   scripts/lib/autonomous-triage-core.js, or narrow the script so the`);
        console.error(`   hazardous paths are unreachable. Do NOT baseline this — the whole point`);
        console.error(`   of the allowlist is that a listed script cannot write.`);
      }
      if (agreement.length > 0) {
        console.error(`\n❌ ${agreement.length} basename(s) where the constant and the live gate disagree.`);
      }
    }
    process.exit(1);
  }
  process.exit(0);
}

module.exports = {
  scanReadOnly,
  auditLintScripts,
  genericFormBasenames,
  gateAgreementFailures,
  TRANSITIVE_SCAN_BASELINE,
  FS_WRITE_RE,
  DYNAMIC_RE,
  SPAWN_RE,
  NETWORK_RE,
};

if (require.main === module) main();
