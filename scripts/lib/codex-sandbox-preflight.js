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
  const ns = run('unshare', ['-U', '-r', 'true']);
  if (ns.code === 0) return { usable: true, reason: 'user namespaces available' };
  return { usable: false, reason: `unshare -U -r true failed (exit ${ns.code}): ${String(ns.out || '').trim().slice(0, 200)}` };
}

/**
 * Decide the codex `--sandbox` mode. An unusable namespace sandbox falls back to danger-full-access
 * ONLY inside a cloud container (CLAUDE_CODE_REMOTE=true), which is already an isolated throwaway VM;
 * anywhere else it is a hard "unusable" so nothing runs unsandboxed on a developer machine.
 */
function chooseSandbox(probe, env = process.env) {
  if (probe.usable) return { mode: WORKSPACE_WRITE, ok: true, reason: probe.reason };
  if (env.CLAUDE_CODE_REMOTE === 'true') {
    return { mode: FULL_ACCESS, ok: true, reason: `${probe.reason}; using ${FULL_ACCESS} inside the isolated cloud VM` };
  }
  return { mode: null, ok: false, reason: `codex unusable here: ${probe.reason}` };
}

module.exports = { probeNamespaceSandbox, chooseSandbox, WORKSPACE_WRITE, FULL_ACCESS };
