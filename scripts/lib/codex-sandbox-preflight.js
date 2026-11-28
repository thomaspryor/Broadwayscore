'use strict';
// BRO-5856: Codex's `workspace-write` sandbox is bubblewrap on Linux, which needs unprivileged user
// namespaces. The cloud routine container refuses them ("unshare: write failed /proc/self/uid_map:
// Operation not permitted"), so every codex exec was blocked and every card came back with no diff.
// Probe once up front and pick a sandbox mode that works, or say plainly that Codex is unusable here.

const WORKSPACE_WRITE = 'workspace-write';
const FULL_ACCESS = 'danger-full-access';

/**
 * Can this host create the user namespace bubblewrap needs? Only Linux uses bwrap (macOS = seatbelt).
 * `run(cmd, args)` -> { code, out }; injected so the decision is testable without a container.
 */
function probeNamespaceSandbox(run, platform = process.platform) {
  if (platform !== 'linux') return { usable: true, reason: `${platform}: no bubblewrap` };
  // User + mount + pid namespaces: what bwrap needs (a user-namespace-only probe passes under AppArmor restrictions).
  const ns = run('unshare', ['-U', '-r', '-m', '-p', '-f', 'true']);
  if (ns.code === 0) return { usable: true, reason: 'user namespaces available' };
  return { usable: false, reason: `unshare -U -r -m -p -f true failed (exit ${ns.code}): ${String(ns.out || '').trim().slice(0, 200) || 'no output (is unshare installed?)'}` };
}

/**
 * Decide the codex `--sandbox` mode. An unusable namespace sandbox is a hard "unusable": the runner
 * stops before claiming a card, its lock is released, and cloud-worker-pick stops reserving cards for
 * Codex. danger-full-access is NOT the default fallback (review, BRO-5856): the runner loads and runs
 * ROOT's own scripts with real tokens after each exec, and full access lets Codex rewrite them. It is
 * available only on explicit opt-in (CODEX_RUNNER_ALLOW_FULL_ACCESS=1) inside a cloud container.
 */
function chooseSandbox(probe, env = process.env) {
  if (probe.usable) return { mode: WORKSPACE_WRITE, ok: true, reason: probe.reason };
  if (env.CLAUDE_CODE_REMOTE === 'true' && env.CODEX_RUNNER_ALLOW_FULL_ACCESS === '1') {
    return { mode: FULL_ACCESS, ok: true, reason: `${probe.reason}; CODEX_RUNNER_ALLOW_FULL_ACCESS=1 so using ${FULL_ACCESS}` };
  }
  return { mode: null, ok: false, reason: `codex unusable here: ${probe.reason}` };
}

module.exports = { probeNamespaceSandbox, chooseSandbox, WORKSPACE_WRITE, FULL_ACCESS };
