/**
 * infra-gate-registration-check — decision logic for
 * scripts/check-infra-gate-registration.js (task #1094).
 *
 * The #1079 pre-implementation review gate (~/.claude/hooks/infra-plan-review-gate.sh,
 * registered via a single ~/.claude/settings.json PreToolUse entry) is the same
 * "live blocking gate, nothing checks it's actually wired" shape already closed
 * for corpus audits (#1063, #1066-#1069): if the settings.json entry or the
 * hook file disappears, every session keeps working and main keeps accepting
 * shared-infra edits with zero signal. A real 8-minute fail-open window
 * happened on 2026-08-06 (#1093) and was only caught because a human noticed.
 *
 * Four checks, in increasing order of how much they actually prove:
 *   1. checkSettingsRegistration — settings.json PreToolUse references the hook
 *   2. checkHookFileExists       — the hook file exists and is non-empty
 *   3. checkScopeLibOnOrigin     — scripts/lib/infra-review-scope.js is on
 *                                  origin/main (the hook needs it to classify
 *                                  anything; a repo without it is unguarded)
 *   4. probeSyntheticBlock       — RUNS the hook against a synthetic
 *                                  critical-infra edit for an unknown session
 *                                  id and asserts it actually exits 2. This is
 *                                  the check that distinguishes "the file is
 *                                  present" from "the gate still blocks" — a
 *                                  hook can exist, be registered, and still be
 *                                  broken (wrong permissions, a bug that makes
 *                                  it always fail open, jq/node missing from
 *                                  PATH). Checks 1-3 alone are exactly the
 *                                  vacuous-gate class this card exists to
 *                                  close: they look, they don't run anything.
 *
 * Checks 1-2 read ~/.claude — only meaningful on the Mac where the hook
 * system lives (mirrors scripts/lib/claude-auth-health.js: the condition this
 * detects never reaches CI, so the detector can't run in CI either).
 * scripts/check-infra-gate-registration.js is the runner + alert wiring
 * (launchd job, not a GitHub Action — see scripts/launchd/com.broadwayscore.
 * infra-gate-registration.plist).
 *
 * Tested by scripts/tests/infra-gate-registration.test.mjs (CLAUDE.md rule 15
 * — the test require()s these functions against real fixture states AND the
 * real hook file on this machine; it does not restate the checks).
 *
 * ---
 *
 * GENERALIZED HOOK LIVENESS (task #1104).
 *
 * The four checks above watch exactly ONE hook (infra-plan-review-gate.sh),
 * hardcoded via HOOK_REL_PATH. Every other hook registered in
 * ~/.claude/settings.json (34 on this machine as of 2026-08-06) can vanish
 * from the active path with nothing detecting it — proven on 2026-08-06 when
 * hook-syntax-guard.sh quarantined TWO healthy hooks for the same reason
 * (validated bash-5.3 files with bash 3.2): infra-plan-review-gate.sh was
 * caught only because this file watches it specifically; notion-card-
 * required-stop.sh was silently disabled for ~4 hours because nothing did.
 *
 * runHookLivenessCheck() below is the generalization: it treats
 * ~/.claude/settings.json and <repo>/.claude/settings.json as the source of
 * truth for what SHOULD be running (not a directory listing — a hook file
 * sitting in ~/.claude/hooks/ that no settings.json references is not
 * "supposed to run" and is out of scope here), resolves every referenced hook
 * command to a path, and asserts each one exists, is non-empty, is
 * executable, and parses under its OWN declared interpreter (interpFor()
 * below is a JS port of the resolution logic in
 * ~/.claude/bin/hook-syntax-guard.sh lines 79-112 — resolved by absolute
 * path, never `command -v`, per that script's own hard-won fix for the
 * bash-3.2-vs-5.3 bug; a non-shell shebang like `#!/usr/bin/env zsh` is
 * UNVALIDATABLE, not broken — judging a language we can't parse is exactly
 * the mistake that produced the 2026-08-06 incident in reverse).
 * probeSyntheticBlock() is kept and layered in as an EXTRA check specifically
 * for infra-plan-review-gate.sh — presence and parseability prove less than
 * "actually blocks," which only the #1079 gate has a synthetic-block probe
 * for.
 *
 * checkGuardHeartbeat() covers the adjacent gap the card flagged: the guard
 * itself (hook-syntax-guard.sh, launchd job com.broadwayscore.hook-syntax-
 * guard) has no positive heartbeat — if launchd unloads it or it stops
 * parsing, its log goes quiet, which looks identical to a healthy quiet run.
 *
 * Tested by scripts/tests/hook-liveness.test.mjs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { repoDepthArgs } = require('./shallow-fetch-args.js');

const HOOK_REL_PATH = '.claude/hooks/infra-plan-review-gate.sh';
const SETTINGS_REL_PATH = '.claude/settings.json';
const SCOPE_LIB_REPO_PATH = 'scripts/lib/infra-review-scope.js';
const DEFAULT_PROBE_TARGET = 'scripts/lib/backlog-drain.js'; // known 'critical' tier, never EXEMPT
const GUARD_LAUNCHD_LABEL = 'com.broadwayscore.hook-syntax-guard';

/**
 * @param {object} a
 * @param {string} a.settingsPath  path to a ~/.claude/settings.json (or a fixture standing in for one)
 * @returns {{ok: boolean, detail: string}}
 */
function checkSettingsRegistration({ settingsPath }) {
  if (!settingsPath) return { ok: false, detail: 'no settingsPath given' };
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, detail: `settings.json not found at ${settingsPath}` };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `settings.json unparseable: ${err.message}` };
  }
  const preToolUse = (settings.hooks && settings.hooks.PreToolUse) || [];
  const matchingEntries = preToolUse.filter((entry) =>
    Array.isArray(entry && entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes('infra-plan-review-gate.sh'))
  );
  if (matchingEntries.length === 0) {
    return { ok: false, detail: 'no PreToolUse entry references infra-plan-review-gate.sh — the gate is unregistered' };
  }
  // A command referencing the hook is not enough on its own: the hook's real
  // scope is `Edit|Write|MultiEdit|NotebookEdit|Bash` (its file-write and
  // shell-write routes — see infra-plan-review-gate.sh's own header). A
  // matcher narrowed to e.g. 'Read' would still make this check report
  // healthy while every real edit fail-opens (ship-check finding). Require
  // coverage of BOTH the direct edit tools and Bash, since scope-scope.js's
  // hardest-won fix (bashWriteTargets) exists specifically because Bash is
  // the dodge that closes.
  const adequatelyScoped = matchingEntries.some((entry) =>
    typeof entry.matcher === 'string' && entry.matcher.includes('Edit') && entry.matcher.includes('Bash')
  );
  if (!adequatelyScoped) {
    const matchers = matchingEntries.map((e) => e.matcher).join(', ');
    return {
      ok: false,
      detail: `a PreToolUse entry references infra-plan-review-gate.sh but its matcher ("${matchers}") does not cover both Edit and Bash — real edits or shell writes would fail-open even though the hook looks registered`,
    };
  }
  return { ok: true, detail: 'PreToolUse has an entry whose command references infra-plan-review-gate.sh and whose matcher covers Edit + Bash' };
}

/**
 * @param {object} a
 * @param {string} a.hookPath  path to infra-plan-review-gate.sh (or a fixture)
 * @returns {{ok: boolean, detail: string}}
 */
function checkHookFileExists({ hookPath }) {
  if (!hookPath) return { ok: false, detail: 'no hookPath given' };
  // existsSync + statSync is a TOCTOU window (deletion, permission change, or
  // a dangling symlink between the two calls) — statSync alone can throw.
  // Catch it as a real "broken" finding rather than letting it escape as an
  // uncaught exception (ship-check finding).
  let stat;
  try {
    stat = fs.statSync(hookPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, detail: `hook file missing at ${hookPath}` };
    return { ok: false, detail: `hook file at ${hookPath} could not be stat'd: ${err.message}` };
  }
  if (stat.size === 0) {
    return { ok: false, detail: `hook file at ${hookPath} exists but is empty (0 bytes)` };
  }
  return { ok: true, detail: `hook file present (${stat.size} bytes) at ${hookPath}` };
}

/**
 * @param {object} a
 * @param {string} a.repoRoot  a checkout of the Broadwayscore repo (any branch — this reads origin/main directly)
 * @returns {{ok: boolean, inconclusive?: boolean, detail: string}}
 */
function checkScopeLibOnOrigin({ repoRoot }) {
  if (!repoRoot) return { ok: false, detail: 'no repoRoot given' };
  // A checkout without an origin/main remote-tracking ref cannot answer this
  // question as-is. actions/checkout defaults to fetch-depth: 1, and on a
  // pull_request event it fetches only refs/pull/<n>/merge — so origin/main is
  // absent and `git cat-file origin/main:<path>` exits non-zero for a reason
  // that has nothing to do with the file. Reporting that as a FAILURE made
  // every PR's Unit Tests job red regardless of its diff (observed on PR #573,
  // run 31563016374, while the same test passed on push-to-main runs of the
  // same commit range).
  //
  // Fetch the ref rather than giving up: this check exists to catch a silently
  // broken safety gate, so "we couldn't look" is a hole, not an answer. Same
  // shape as autofix-canary.js's markerExistsOnOriginMain — depth-bounded, so
  // a shallow CI clone pulls the delta and not the whole ~2.1 GB history
  // (task #466 class). Only if the fetch ITSELF fails (offline, no remote) do
  // we fall back to inconclusive.
  const hasOriginMain = () =>
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    }).status === 0;
  if (!hasOriginMain()) {
    const depthArgs = repoDepthArgs({ repoRoot });
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    spawnSync('git', ['fetch', ...depthArgs, '--quiet', 'origin', 'main'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (!hasOriginMain()) {
      return {
        ok: true,
        inconclusive: true,
        detail:
          'no origin/main ref in this checkout and `git fetch origin main` could not create one (offline / no remote) — cannot verify, not treating as a violation',
      };
    }
  }
  const r = spawnSync('git', ['cat-file', '-e', `origin/main:${SCOPE_LIB_REPO_PATH}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.error) return { ok: false, detail: `git check failed to run: ${r.error.message}` };
  if (r.status === 0) {
    return { ok: true, detail: `${SCOPE_LIB_REPO_PATH} present on origin/main` };
  }
  return { ok: false, detail: `${SCOPE_LIB_REPO_PATH} missing on origin/main (git cat-file exit ${r.status}) — the hook would classify nothing` };
}

/**
 * Best-effort: is targetPath still classified 'critical' tier by THIS repo's
 * live infra-review-scope.js? DEFAULT_PROBE_TARGET is a soft coupling to that
 * file's rules (ship-check finding) — if a future scope edit reclassifies it
 * to 'shared' or exempt, the hook would legitimately stop blocking it (exit 0
 * or a warn), and probeSyntheticBlock would misreport a healthy gate as
 * broken. Returns null (inconclusive, not false) if the scope lib can't be
 * loaded — that failure is already surfaced by checkScopeLibOnOrigin, this
 * function must not duplicate it as a probe failure.
 */
function isProbeTargetStillCritical({ repoRoot, targetPath }) {
  try {
    const scope = require(path.join(repoRoot, 'scripts', 'lib', 'infra-review-scope.js'));
    const c = scope.classifyPath(targetPath);
    return c.tier === 'critical';
  } catch {
    return null;
  }
}

/**
 * RUNS the real hook against a synthetic PreToolUse Edit of known critical-tier
 * infra, for a session id that can hold no ledger verdict, and asserts it
 * actually blocks (exit 2). This is the difference between this check and the
 * vacuous ones it replaces (#1063 class) — it exercises the hook's actual
 * decision path (jq/node available, the ledger query resolving, the block
 * exit code), not just its file presence.
 *
 * @param {object} a
 * @param {string} a.hookPath    path to infra-plan-review-gate.sh
 * @param {string} a.repoRoot    a Broadwayscore checkout (the hook resolves
 *                                CANONICAL_ROOT from this via git)
 * @param {string} a.sessionId   an id guaranteed to have no ledger verdict —
 *                                callers should pass something unique per call
 * @param {string} [a.targetPath] a path that must classify as 'critical' tier
 * @returns {{ok: boolean, exitCode: number|null, detail: string, staleTarget?: boolean}}
 */
function probeSyntheticBlock({ hookPath, repoRoot, sessionId, targetPath = DEFAULT_PROBE_TARGET }) {
  if (!hookPath) return { ok: false, exitCode: null, detail: 'no hookPath given' };
  if (!repoRoot) return { ok: false, exitCode: null, detail: 'no repoRoot given' };
  if (!sessionId) return { ok: false, exitCode: null, detail: 'no sessionId given' };
  if (!fs.existsSync(hookPath)) {
    return { ok: false, exitCode: null, detail: `cannot probe — hook file missing at ${hookPath}` };
  }

  // Guard against the exact failure mode a reviewer flagged: if targetPath
  // has been reclassified out of the 'critical' tier since DEFAULT_PROBE_TARGET
  // was chosen, exit 0/warn from the hook is CORRECT behaviour, not a broken
  // gate — misreporting it as "gate not blocking" would be a false alarm this
  // whole check exists to avoid.
  const stillCritical = isProbeTargetStillCritical({ repoRoot, targetPath });
  if (stillCritical === false) {
    return {
      ok: false,
      exitCode: null,
      staleTarget: true,
      detail: `probe target "${targetPath}" no longer classifies as 'critical' tier in this repo's infra-review-scope.js — DEFAULT_PROBE_TARGET needs updating; this is NOT evidence the gate itself is broken`,
    };
  }

  const input = JSON.stringify({
    tool_name: 'Edit',
    session_id: sessionId,
    tool_input: { file_path: targetPath },
  });

  const r = spawnSync('bash', [hookPath], {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    timeout: 30000,
  });

  if (r.error) {
    return { ok: false, exitCode: null, detail: `hook failed to run: ${r.error.message}` };
  }
  const exitCode = r.status;
  const ok = exitCode === 2;
  return {
    ok,
    exitCode,
    detail: ok
      ? `hook blocked the synthetic critical-infra edit as expected (exit 2, target=${targetPath})`
      : `hook did NOT block a synthetic critical-infra edit for an unrecorded session (target=${targetPath}) — exit ${exitCode}; stderr: ${(r.stderr || '').slice(0, 300)}`,
  };
}

/**
 * Run all four checks and aggregate. Any single failure fails the whole
 * result — this mirrors the other vacuous-gate closures (#1066-#1069): a
 * check that can silently drop one of its sub-checks and still report "ok"
 * is exactly the bug class.
 *
 * @param {object} a
 * @param {string} a.homeDir     defaults to process.env.HOME
 * @param {string} a.repoRoot    a Broadwayscore checkout
 * @param {string} [a.sessionId] defaults to a fresh crypto.randomUUID()
 * @returns {{ok: boolean, checks: object, summary: string}}
 */
function runInfraGateRegistrationCheck({ homeDir = process.env.HOME, repoRoot, sessionId } = {}) {
  const { randomUUID } = require('crypto');
  const effectiveSessionId = sessionId || `infra-gate-selfcheck-${randomUUID()}`;
  const settingsPath = path.join(homeDir || '', SETTINGS_REL_PATH);
  const hookPath = path.join(homeDir || '', HOOK_REL_PATH);

  const checks = {
    settings: checkSettingsRegistration({ settingsPath }),
    hook: checkHookFileExists({ hookPath }),
    scopeLib: checkScopeLibOnOrigin({ repoRoot }),
    // Only the file-presence checks gate whether probing is meaningful — a
    // missing hook file can't be probed, but scopeLib failing doesn't stop us
    // from still learning whether the LOCAL hook blocks (it may be running a
    // stale but still-functional copy).
    probe: probeSyntheticBlock({ hookPath, repoRoot, sessionId: effectiveSessionId }),
  };

  const failed = Object.entries(checks).filter(([, r]) => !r.ok);
  const inconclusive = Object.entries(checks).filter(([, r]) => r.ok && r.inconclusive);
  const ok = failed.length === 0;
  // Never let an inconclusive check be reported as a verified one — that is how
  // a green summary starts meaning "we didn't look" instead of "we checked".
  const caveat = inconclusive.length
    ? ` (unverified — ${inconclusive.map(([k, r]) => `${k}: ${r.detail}`).join(' | ')})`
    : '';
  return {
    ok,
    inconclusive: inconclusive.map(([k]) => k),
    checks,
    summary: ok
      ? `infra-review gate registered, hook present, scope lib on origin/main, synthetic block confirmed${caveat}`
      : `infra-review gate check FAILED — ${failed.map(([k, r]) => `${k}: ${r.detail}`).join(' | ')}`,
  };
}

const REPAIR_STEPS = 'Check ~/.claude/settings.json PreToolUse for an entry referencing infra-plan-review-gate.sh, confirm ~/.claude/hooks/infra-plan-review-gate.sh exists and is non-empty, then re-run: node scripts/check-infra-gate-registration.js';

/**
 * Builds the routeAlert() payload for a failed check result. Pure — never
 * calls routeAlert itself. disposition='digest' + severity='error' (not
 * 'human'/page): the card asks for "an error-severity digest row, not a
 * warning", not an immediate page — this is a silently-broken safety net, not
 * an active incident with a ticking clock.
 */
function buildAlertPayload(result) {
  return {
    conditionKey: 'infra-gate-registration:broken',
    title: 'The #1079 infra-review gate is unregistered, missing, or not actually blocking',
    description: `check-infra-gate-registration.js: ${result.summary}. Shared-infrastructure edits (dispatch layer, spend guards, concurrency primitives, CI gates, hooks) are ${result.checks && !result.checks.probe?.ok ? 'no longer' : 'may no longer be'} getting a pre-implementation review — the same gap #1093 closed for 8 minutes on 2026-08-06 before a human noticed. Repair: ${REPAIR_STEPS}`,
    severity: 'error',
    disposition: 'digest',
    hint: REPAIR_STEPS,
  };
}

// ── Generalized hook liveness (task #1104) ─────────────────────────────────

// Absolute-path candidates for a modern bash, in preference order — mirrors
// BASH5_CANDIDATES in ~/.claude/bin/hook-syntax-guard.sh. Deliberately not
// resolved via `command -v`/PATH: launchd's default PATH finds macOS bash
// 3.2, which is the exact bug that quarantined two healthy hooks on
// 2026-08-06 (see file header).
const BASH5_CANDIDATES = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'];

function isExecutablePath(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function modernBash() {
  for (const c of BASH5_CANDIDATES) {
    if (isExecutablePath(c)) return c;
  }
  return '/bin/bash';
}

/**
 * Resolve the interpreter a hook file DECLARES via its shebang, so liveness
 * checks validate what will actually run — not what this process's own
 * shell happens to be. JS port of interp_for() in
 * ~/.claude/bin/hook-syntax-guard.sh (lines 79-112); keep the two in sync if
 * either changes. Returns an absolute interpreter path, or the literal
 * string 'UNVALIDATABLE' for a shebang this function has no business judging
 * (zsh, python, node, no shebang at all) — NOT being able to judge a file is
 * not evidence against it.
 * @param {string} filePath
 * @returns {string}
 */
function interpFor(filePath) {
  let shebang;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      shebang = buf.slice(0, n).toString('utf8').split('\n', 1)[0].replace(/\r$/, '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'UNVALIDATABLE';
  }
  if (!shebang.startsWith('#!')) return 'UNVALIDATABLE';

  // '#!'*env\ bash* — checked FIRST, before the generic /sh suffix check,
  // matching the arm order in the bash original (a *sh) arm placed first
  // would wrongly capture "#!/usr/bin/env bash" too, since it ends in "sh").
  if (/\benv\s+bash\b/.test(shebang)) return modernBash();
  // Literal ".../sh" shebang only — "#!/bin/bash" does not end in "/sh".
  if (/\/sh$/.test(shebang)) return '/bin/sh';

  const envMatch = shebang.match(/\benv\s+(.*)$/);
  if (envMatch) {
    let rest = envMatch[1].trim();
    if (rest.startsWith('-S ')) rest = rest.slice(3).trim(); // env -S bash -e
    const interp = rest.split(/\s+/)[0];
    if (interp === 'bash') return modernBash();
    if (interp === 'sh') return '/bin/sh';
    return 'UNVALIDATABLE'; // zsh/python/node: not ours to judge
  }

  const absMatch = shebang.match(/^#!(\/\S*)/);
  if (absMatch) {
    const i = absMatch[1];
    if (/\/(bash|sh)$/.test(i)) {
      return isExecutablePath(i) ? i : modernBash();
    }
    return 'UNVALIDATABLE'; // e.g. /usr/bin/python3
  }
  return 'UNVALIDATABLE';
}

/**
 * Assert a hook file exists, is non-empty, is executable (when execute
 * permission is actually load-bearing — see requireExecutable), and parses
 * under its own declared interpreter. This is the per-hook liveness
 * assertion the card asks for — file presence alone (checkHookFileExists
 * above) is the exact vacuous-gate class this generalization exists to
 * close.
 * @param {object} a
 * @param {string} a.hookPath
 * @param {boolean} [a.requireExecutable=true]  every registered command in
 *   this repo's settings.json invokes an interpreter explicitly (`bash
 *   ~/.claude/hooks/x.sh`, never a bare `~/.claude/hooks/x.sh`), so the
 *   file's own +x bit is not load-bearing for those — `bash <path>` runs the
 *   content regardless. runHookLivenessCheck() passes false for any command
 *   shaped that way; a real regression WOULD be caught anyway by the parse
 *   check below, which reads the same bytes bash would read. Caught in
 *   practice: memory-index-cap-postcheck.sh is 644 on this machine and has
 *   run fine since 2026-06-05 — an unconditional +x requirement would have
 *   reported a working hook as broken on every run.
 * @returns {{ok: boolean, detail: string, unvalidatable?: boolean}}
 */
function checkHookLiveness({ hookPath, requireExecutable = true }) {
  if (!hookPath) return { ok: false, detail: 'no hookPath given' };
  let stat;
  try {
    stat = fs.statSync(hookPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, detail: `hook file missing at ${hookPath}` };
    return { ok: false, detail: `hook file at ${hookPath} could not be stat'd: ${err.message}` };
  }
  if (stat.size === 0) {
    return { ok: false, detail: `hook file at ${hookPath} exists but is empty (0 bytes)` };
  }
  if (requireExecutable && (stat.mode & 0o111) === 0) {
    return { ok: false, detail: `hook file at ${hookPath} exists but is not executable` };
  }

  const interp = interpFor(hookPath);
  if (interp === 'UNVALIDATABLE') {
    return {
      ok: true,
      unvalidatable: true,
      detail: `hook file present, non-empty, executable at ${hookPath} — declared interpreter is not shell-syntax-checkable (not reported as broken)`,
    };
  }
  const r = spawnSync(interp, ['-n', hookPath], { encoding: 'utf8', timeout: 10000 });
  if (r.error) {
    return { ok: false, detail: `parse check via ${interp} failed to run: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      detail: `hook file at ${hookPath} does not parse under its declared interpreter (${interp}): ${(r.stderr || '').trim().slice(0, 300)}`,
    };
  }
  return { ok: true, detail: `hook file present, non-empty, executable, parses under ${interp}` };
}

/**
 * Walk every hook-event array in a parsed settings.json (PreToolUse,
 * PostToolUse, Stop, SessionStart, ... — whatever event keys are present,
 * generically) and extract each hook command's script path. Only commands
 * referencing a `.sh` file are extracted — every hook registered in this
 * repo's settings.json is a shell script (see file header); a future
 * non-shell hook command would need its own liveness notion and is out of
 * scope here rather than silently mis-checked.
 * @param {object} settings  parsed settings.json
 * @returns {{matched: Array<{event: string, matcher: string, command: string, rawPath: string}>, unmatched: Array<{event: string, matcher: string, command: string}>}}
 */
function extractHookCommandPaths(settings) {
  const matched = [];
  const unmatched = [];
  const hooksByEvent = (settings && settings.hooks) || {};
  for (const [event, entries] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
      const hookCmds = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of hookCmds) {
        const command = typeof h.command === 'string' ? h.command : '';
        // Negative lookbehind excludes a match starting right after a shell
        // variable reference (e.g. the `/` in `$R/.claude/hooks/x.sh`, BRO-2439's
        // CLAUDE_PROJECT_DIR-anchored resolver) so extraction lands on the
        // stable `.claude/hooks/x.sh` suffix instead of misreading the `/` as
        // an absolute-path prefix. `~/.claude/hooks/x.sh` (global settings,
        // preceded by a quote/space) and `.claude/hooks/x.sh` (repo-relative)
        // still match exactly as before.
        const m = command.match(/(?<![\w}])[~./][^\s'"]*\.sh\b/);
        if (m) {
          matched.push({ event, matcher, command, rawPath: m[0] });
        } else {
          // A hook command that isn't recognized isn't "not our problem" —
          // it's exactly the silent coverage gap this card exists to close.
          // If a future hook command is rewritten to `node hook.js` or
          // wrapped in a shell function this extraction can't parse, it
          // must not just vanish from the checked set with zero signal.
          unmatched.push({ event, matcher, command });
        }
      }
    }
  }
  return { matched, unmatched };
}

/**
 * Does this command execute rawPath DIRECTLY (no interpreter prefix), such
 * that the file's own +x bit is load-bearing? True for a bare
 * `~/.claude/hooks/x.sh`; false for `bash ~/.claude/hooks/x.sh` or
 * `bash -lc '~/.claude/hooks/x.sh'` — both invoke an explicit interpreter on
 * the path, so the OS never needs to exec the file itself.
 * @param {string} command
 * @param {string} rawPath
 * @returns {boolean}
 */
function commandInvokesPathDirectly(command, rawPath) {
  const trimmed = (command || '').trim();
  return trimmed === rawPath || trimmed.startsWith(`${rawPath} `);
}

/**
 * Resolve a raw path token from a hook command to an absolute filesystem
 * path. `~/...` expands against homeDir (how ~/.claude/settings.json
 * commands are written); an absolute path is returned as-is; anything else
 * is relative to baseDir (how the repo's .claude/settings.json commands
 * write ".claude/hooks/foo.sh", relative to the repo root).
 * @param {string} rawPath
 * @param {object} a
 * @param {string} a.homeDir
 * @param {string} a.baseDir
 * @returns {string}
 */
function resolveHookPath(rawPath, { homeDir, baseDir }) {
  if (rawPath.startsWith('~/')) return path.join(homeDir || '', rawPath.slice(2));
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(baseDir || '', rawPath);
}

/**
 * Load and resolve every hook command registered in one settings.json.
 * @param {object} a
 * @param {string} a.settingsPath
 * @param {string} a.homeDir
 * @param {string} a.baseDir
 * @param {string} a.label  human-readable name for this settings source, used in reports
 * @returns {{ok: boolean, detail?: string, hooks: Array<object>}}
 */
function loadRegisteredHooks({ settingsPath, homeDir, baseDir, label }) {
  if (!settingsPath) return { ok: false, detail: 'no settingsPath given', hooks: [], unmatched: [] };
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, detail: `settings.json not found at ${settingsPath}`, hooks: [], unmatched: [] };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    return { ok: false, detail: `settings.json at ${settingsPath} unparseable: ${err.message}`, hooks: [], unmatched: [] };
  }
  const { matched, unmatched } = extractHookCommandPaths(settings);
  const hooks = matched.map((entry) => ({
    ...entry,
    label,
    absPath: resolveHookPath(entry.rawPath, { homeDir, baseDir }),
  }));
  return { ok: true, hooks, unmatched: unmatched.map((u) => ({ ...u, label })) };
}

/**
 * Run the generalized liveness check across one or more settings.json
 * sources and report per-hook, naming which hook is down — the acceptance
 * criterion this card exists to satisfy. infra-plan-review-gate.sh gets the
 * extra probeSyntheticBlock() assertion layered on top of the generic
 * liveness check, same as before; every other hook only gets the generic
 * check (existence, non-empty, executable, parses under its declared
 * interpreter).
 * @param {object} a
 * @param {Array<{settingsPath: string, homeDir?: string, baseDir?: string, label: string}>} a.settingsSources
 * @param {string} [a.repoRoot]    needed only to run the #1079 synthetic-block probe
 * @param {string} [a.sessionId]
 * @returns {{ok: boolean, hookCount: number, hooks: Array<object>, sourceFailures: Array<object>, summary: string}}
 */
function runHookLivenessCheck({ settingsSources, repoRoot, sessionId } = {}) {
  const { randomUUID } = require('crypto');
  const effectiveSessionId = sessionId || `hook-liveness-selfcheck-${randomUUID()}`;
  const sources = settingsSources || [];
  const hooks = [];
  const sourceFailures = [];
  const unmatchedCommands = [];

  for (const src of sources) {
    const loaded = loadRegisteredHooks(src);
    if (!loaded.ok) {
      sourceFailures.push({ label: src.label, detail: loaded.detail });
      continue;
    }
    unmatchedCommands.push(...(loaded.unmatched || []));
    for (const entry of loaded.hooks) {
      const requireExecutable = commandInvokesPathDirectly(entry.command, entry.rawPath);
      const liveness = checkHookLiveness({ hookPath: entry.absPath, requireExecutable });
      let probe = null;
      if (repoRoot && liveness.ok && path.basename(entry.absPath) === 'infra-plan-review-gate.sh') {
        probe = probeSyntheticBlock({ hookPath: entry.absPath, repoRoot, sessionId: effectiveSessionId });
      }
      const ok = liveness.ok && (!probe || probe.ok);
      hooks.push({
        label: entry.label,
        event: entry.event,
        rawPath: entry.rawPath,
        absPath: entry.absPath,
        ok,
        unvalidatable: !!liveness.unvalidatable,
        detail: probe && !probe.ok ? `${liveness.detail}; SYNTHETIC-BLOCK PROBE FAILED: ${probe.detail}` : liveness.detail,
      });
    }
  }

  const failedHooks = hooks.filter((h) => !h.ok);
  const ok = sourceFailures.length === 0 && failedHooks.length === 0 && unmatchedCommands.length === 0;
  const summaryParts = [
    ...sourceFailures.map((f) => `${f.label}: ${f.detail}`),
    ...failedHooks.map((h) => `${path.basename(h.absPath)} (${h.label}, ${h.event}): ${h.detail}`),
    ...unmatchedCommands.map((u) => `unrecognized hook command in ${u.label}/${u.event} (coverage gap, not checked): "${u.command}"`),
  ];
  return {
    ok,
    hookCount: hooks.length,
    hooks,
    sourceFailures,
    unmatchedCommands,
    summary: ok
      ? `hook-liveness clean — ${hooks.length} registered hook(s) checked across ${sources.length} settings source(s)`
      : `hook-liveness FAILED — ${summaryParts.join(' | ')}`,
  };
}

/**
 * The guard (hook-syntax-guard.sh, launchd job com.broadwayscore.hook-
 * syntax-guard) has no positive heartbeat: if launchd unloads the job or the
 * script stops parsing, its log simply stops growing, which is
 * indistinguishable from "nothing has been broken in the last 2 minutes." —
 * confirmed on this machine: hook-syntax-guard.sh's own verbose log
 * (~/.claude/hook-syntax-guard.log) only grows on a quarantine/restore
 * ("only log quiet runs occasionally" is the script's own comment), so a
 * dozen quiet, perfectly healthy runs leave its mtime untouched. Checking
 * THAT file's mtime would false-alarm on every calm stretch — the guard now
 * additionally stamps ~/.claude/hook-syntax-guard.heartbeat unconditionally
 * on every run, regardless of outcome, specifically so a liveness check has
 * something that means "still alive" rather than "something broke."
 * Assert the job is actually loaded AND has stamped that heartbeat recently.
 * @param {object} a
 * @param {string} a.heartbeatPath  the unconditional per-run stamp file, NOT the verbose log
 * @param {number} [a.maxAgeMinutes=10]  the guard runs every ~2min (StartInterval 120); 10 gives headroom for a slow tick without masking a real stall
 * @param {string} [a.launchctlLabel='com.broadwayscore.hook-syntax-guard']
 * @param {string} [a.launchctlOutput]  inject `launchctl list` output for testing; omit to run it live
 * @returns {{ok: boolean, detail: string}}
 */
function checkGuardHeartbeat({ heartbeatPath, maxAgeMinutes = 10, launchctlLabel = GUARD_LAUNCHD_LABEL, launchctlOutput } = {}) {
  if (!heartbeatPath) return { ok: false, detail: 'no heartbeatPath given' };

  let listOutput = launchctlOutput;
  if (listOutput === undefined) {
    const r = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 10000 });
    listOutput = r.error ? '' : r.stdout || '';
  }
  // Exact match on the whitespace-split label field, not a substring search:
  // `launchctl list` output is `PID\tStatus\tLabel` and a substring match
  // would report "loaded" off a DIFFERENT job whose label merely contains
  // this one (e.g. a future "com.broadwayscore.hook-syntax-guard-v2"). This
  // exact bug class already bit the restore loop in hook-syntax-guard.sh
  // itself (unanchored "notify.sh" matching "config-change-notify.sh",
  // 2026-08-06) — a heartbeat check making the same mistake would silently
  // trust the wrong job.
  const loaded = listOutput
    .split('\n')
    .some((line) => line.trim().split(/\s+/).pop() === launchctlLabel);
  if (!loaded) {
    return { ok: false, detail: `launchd job ${launchctlLabel} is not loaded — the hook-syntax-guard heartbeat cannot be trusted` };
  }

  let stat;
  try {
    stat = fs.statSync(heartbeatPath);
  } catch (err) {
    return { ok: false, detail: `guard heartbeat file missing at ${heartbeatPath} — cannot confirm it has run (${err.code || err.message})` };
  }
  const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
  if (ageMinutes > maxAgeMinutes) {
    return {
      ok: false,
      detail: `guard heartbeat at ${heartbeatPath} has not been stamped in ${ageMinutes.toFixed(1)}min (job reports loaded but appears stalled; expected every ~2min)`,
    };
  }
  return { ok: true, detail: `guard job loaded, heartbeat stamped ${ageMinutes.toFixed(1)}min ago` };
}

/**
 * routeAlert() payload for a failed generalized hook-liveness check. Same
 * disposition/severity convention as buildAlertPayload above (digest, not a
 * page) — names the specific broken hook(s) rather than a generic "a hook is
 * down", the exact gap that let notion-card-required-stop.sh sit disabled
 * for 4 hours unreported.
 */
function buildHookLivenessAlertPayload(result) {
  const brokenNames = (result.hooks || []).filter((h) => !h.ok).map((h) => path.basename(h.absPath));
  const named = [...brokenNames, ...(result.sourceFailures || []).map((f) => f.label)];
  return {
    conditionKey: 'hook-liveness:broken',
    title: named.length
      ? `${named.length} registered Claude hook(s) broken or unregistered: ${named.join(', ')}`
      : 'Hook liveness check failed',
    description: `check-hook-liveness.js: ${result.summary}. A hook can vanish or stop parsing with zero signal — notion-card-required-stop.sh was silently disabled for ~4h on 2026-08-06 before a human noticed (#1104). Repair: fix or restore the named hook file(s), confirm settings.json still references them, then re-run: node scripts/check-hook-liveness.js`,
    severity: 'error',
    disposition: 'digest',
    hint: 'Check the named hook file(s) exist, are executable, and parse under their declared interpreter.',
  };
}

module.exports = {
  HOOK_REL_PATH,
  SETTINGS_REL_PATH,
  SCOPE_LIB_REPO_PATH,
  DEFAULT_PROBE_TARGET,
  GUARD_LAUNCHD_LABEL,
  REPAIR_STEPS,
  checkSettingsRegistration,
  checkHookFileExists,
  checkScopeLibOnOrigin,
  probeSyntheticBlock,
  runInfraGateRegistrationCheck,
  buildAlertPayload,
  interpFor,
  checkHookLiveness,
  extractHookCommandPaths,
  commandInvokesPathDirectly,
  resolveHookPath,
  loadRegisteredHooks,
  runHookLivenessCheck,
  checkGuardHeartbeat,
  buildHookLivenessAlertPayload,
};
