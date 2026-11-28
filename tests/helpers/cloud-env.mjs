// BRO-7609. Tests that spawn linear-brain.js / linear-next.js / linear-session.js, or call their main()
// in-process, behave differently inside a cloud container: CLAUDE_CODE_REMOTE=true arms the BRO-7554 cloud
// dispatch refusal, and CLAUDE_CODE_REMOTE_SESSION_ID makes every Linear comment carry a session footer.
// A suite that asserts on a plain-world outcome must run in a plain world. Call scrubCloudEnv() at the top
// of such a file (it edits process.env in place, so every child it spawns inherits the clean env).
export const CLOUD_ENV_KEYS = [
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE',
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'LINEAR_NEXT_ALLOW_CLOUD',
];

/** Remove every cloud/session variable from `env` (default process.env), in place. Returns env. */
export function scrubCloudEnv(env = process.env) {
  for (const k of CLOUD_ENV_KEYS) delete env[k];
  return env;
}

/** A copy of `base` that looks like a cloud worker session (for the guard's own cloud-mode run). */
export function simulatedCloudEnv(base = process.env) {
  return {
    ...base,
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01TESTSIMULATEDCLOUDSESSION',
    CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000000',
    CLAUDE_CODE_ENTRYPOINT: 'remote_mobile',
  };
}
