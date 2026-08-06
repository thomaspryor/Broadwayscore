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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_REL_PATH = '.claude/hooks/infra-plan-review-gate.sh';
const SETTINGS_REL_PATH = '.claude/settings.json';
const SCOPE_LIB_REPO_PATH = 'scripts/lib/infra-review-scope.js';
const DEFAULT_PROBE_TARGET = 'scripts/lib/backlog-drain.js'; // known 'critical' tier, never EXEMPT

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
 * @returns {{ok: boolean, detail: string}}
 */
function checkScopeLibOnOrigin({ repoRoot }) {
  if (!repoRoot) return { ok: false, detail: 'no repoRoot given' };
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
  const ok = failed.length === 0;
  return {
    ok,
    checks,
    summary: ok
      ? 'infra-review gate registered, hook present, scope lib on origin/main, synthetic block confirmed'
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

module.exports = {
  HOOK_REL_PATH,
  SETTINGS_REL_PATH,
  SCOPE_LIB_REPO_PATH,
  DEFAULT_PROBE_TARGET,
  REPAIR_STEPS,
  checkSettingsRegistration,
  checkHookFileExists,
  checkScopeLibOnOrigin,
  probeSyntheticBlock,
  runInfraGateRegistrationCheck,
  buildAlertPayload,
};
