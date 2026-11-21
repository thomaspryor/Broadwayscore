'use strict';
// BRO-791: the subscriber senders that a workflow runs on a schedule
// (send-follow-notifications, send-welcome-emails) must not also be run for
// real from a laptop or a Claude session. Two runners at once share no lock:
// the follow sender's checkpoint and digest prune are plain files, so a local
// run and the cron can both mail the same followers, and a local run's
// checkpoint never reaches the repo.
//
// Rule: in CI, send. Locally, the script's own preview flags (e.g. --dry-run)
// always run. A local real send is refused unless --allow-local-send is given,
// and even then it is refused while the workflow has a queued or running run.
// The opening-night broadcast has its own lock (scripts/lib/send-lock.js);
// this guard is for the transactional cron senders, so it never blocks on that
// lock's 5-minute TTL.

const { execFileSync } = require('child_process');

const ALLOW_FLAG = '--allow-local-send';

// GITHUB_ACTIONS only: both workflows set it, while plain CI=true is exported
// by many local tools and would skip the guard.
function isCI(env = process.env) {
  return env.GITHUB_ACTIONS === 'true';
}

// previewFlags are the flags THIS script honours as no-real-send. Each script
// passes its own list: a flag the script ignores (e.g. --send-to= on the
// follow sender) must not count, or it becomes a full real send. An entry
// ending in '=' matches as a prefix.
function isPreview(argv, previewFlags) {
  return argv.some((a) => previewFlags.some((f) => (f.endsWith('=') ? a.startsWith(f) : a === f)));
}

// Pure decision. activeRuns is the count of queued/in-progress runs of the
// workflow, or null when it could not be checked (treated as busy).
function decideLocalSend({ argv, env = process.env, workflow, previewFlags, activeRuns }) {
  if (!Array.isArray(previewFlags)) throw new Error('decideLocalSend: previewFlags is required');
  if (isCI(env)) return { allow: true, reason: 'ci' };
  if (isPreview(argv, previewFlags)) return { allow: true, reason: 'preview' };
  if (!argv.includes(ALLOW_FLAG)) {
    return {
      allow: false,
      reason: `Refusing a real send from a local machine: ${workflow} sends this on a schedule. `
        + `Use --dry-run to preview, or pass ${ALLOW_FLAG} if you mean it.`,
    };
  }
  if (activeRuns === null || activeRuns === undefined) {
    return { allow: false, reason: `Refusing: could not check whether ${workflow} is running (gh unavailable?).` };
  }
  if (activeRuns > 0) {
    return { allow: false, reason: `Refusing: ${workflow} has ${activeRuns} queued or running run(s). Wait for it to finish.` };
  }
  return { allow: true, reason: 'local-override' };
}

function countActiveRuns(workflow, { repo = 'thomaspryor/Broadwayscore', exec = execFileSync } = {}) {
  let total = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const out = exec('gh', ['api', `repos/${repo}/actions/workflows/${workflow}/runs?status=${status}&per_page=1`, '--jq', '.total_count'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
      const n = Number(String(out).trim());
      if (!Number.isFinite(n)) return null;
      total += n;
    } catch {
      return null;
    }
  }
  return total;
}

// Call at the top of main(). Exits 2 when the send is refused.
function enforceLocalSendGuard(workflow, { previewFlags, argv = process.argv.slice(2), env = process.env } = {}) {
  const needsCheck = !isCI(env) && !isPreview(argv, previewFlags || []) && argv.includes(ALLOW_FLAG);
  const activeRuns = needsCheck ? countActiveRuns(workflow) : 0;
  const d = decideLocalSend({ argv, env, workflow, previewFlags, activeRuns });
  if (!d.allow) {
    console.error(d.reason);
    process.exit(2);
  }
  return d;
}

module.exports = { decideLocalSend, enforceLocalSendGuard, countActiveRuns, isPreview, ALLOW_FLAG };
