/**
 * opening-night-monitor — headless (non-cmux) session primitive for the
 * opening-night babysitter (scripts/opening-night-monitor-launch.js).
 *
 * Replaces cmux-launch.js for this one caller. Root cause (card #650, proven
 * not guessed): cmux refuses connections from launchd-parented ancestry —
 * `cmux list-workspaces` from a perl double-fork+setsid orphan (PPID=1,
 * matching launchd's process shape) reproduces the exact failure the
 * launcher hit 344/344 times: "ERROR: Access denied — only processes
 * started inside cmux can connect" / "Failed to write to socket (Broken
 * pipe, errno 32)". The identical command run from inside a real cmux
 * workspace succeeds — the gate is process ancestry, not environment
 * (`env -i` does not reproduce it).
 *
 * `claude -p` has no such requirement: the SAME double-fork+setsid orphan
 * ancestry ran `claude -p "reply with exactly: pong" --output-format json`
 * to completion (exit 0, `"result":"pong"`) with zero cmux involvement,
 * verified live 2026-07-30. scripts/lib/claude-cli.js's runClaudeCli is
 * already the repo's one shared headless-spawn primitive (autonomous-run.js,
 * bsc-runner.js) — this file is a thin, monitor-shaped wrapper around it,
 * not a second implementation.
 */

'use strict';

const { runClaudeCli, FORBIDDEN_MODEL_RE } = require('./claude-cli.js');

// runClaudeCli refuses fable/mythos for unattended runs (task #459 — expensive
// interactive tiers must never leak into headless dispatch). The monitor's
// cmux-era default was 'fable' (owner decision 2026-07-24, chosen for an
// INTERACTIVE session); that choice cannot carry over to the headless path,
// so callers must pick a model runClaudeCli will actually accept.
function isModelAllowed(model) {
  return !FORBIDDEN_MODEL_RE.test(String(model || ''));
}

/**
 * Run one bounded opening-night-monitor pass headless and normalize the
 * result to the shape the launcher's decision/ledger/alert code expects.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.cwd
 * @param {string} opts.model
 * @param {string} [opts.settingsPath]
 * @param {number} [opts.maxWallMin]  default 15 — comfortably under the
 *                                    20-min launchd tick interval so a
 *                                    normal pass always finishes before the
 *                                    next tick fires.
 * @param {string} [opts.logFile]
 * @param {object} [opts.env]     extra env merged over runClaudeCli's stripped base (test seam)
 * @param {(pid:number)=>void} [opts.onSpawn]
 * @returns {Promise<{ok:boolean, stage:string|null, error:string|null,
 *                    resultText:string, wallMin:number, usd:number,
 *                    pid:number|null, sessionId:string|null}>}
 */
async function runMonitorPass({ prompt, cwd, model, settingsPath = null, maxWallMin = 15, logFile = null, env, onSpawn = null }) {
  const r = await runClaudeCli({
    prompt, cwd, model, settingsPath, logFile, onSpawn,
    ...(env ? { env } : {}),
    timeoutMs: maxWallMin * 60 * 1000,
  });
  return {
    ok: r.ok,
    stage: r.stage,
    error: r.errorDetail,
    resultText: r.resultText,
    wallMin: r.durationMs / 60000,
    usd: r.costUSD || 0,
    pid: r.pid,
    sessionId: r.sessionId,
  };
}

module.exports = { runMonitorPass, isModelAllowed };
