'use strict';
/**
 * Child worker session ending a turn on KEEP OPEN while waiting on CI (BRO-6264).
 *
 * A child has no human and no subscription to the run it fired, so nothing
 * wakes it (BRO-6154 sat ~1 day after dispatching we-historical-tr-probe.yml).
 * The generic WAKELESS gate passed it because any earlier background Bash
 * counts as an armed wake. For a child waiting on CI, a wake only counts if it
 * was armed AFTER the last run the session started: a background poll/Monitor
 * (its exit wakes the turn) or a report-back to @parent.
 *
 * Pure decision; verify-edits.sh feeds it a compact view of the transcript
 * through the CLI at the bottom (stdin JSON -> stdout JSON).
 *
 * Input: { firstPrompt, env, closing, tools: [{idx, name, input, ok, result}],
 *          done: [task ids with a completion notice, after their start] }
 */

// Child sessions are started with a prompt carrying a `BUDGET: <1-12>h` line
// (block-prompting-remote-tools.sh enforces it); a parent id in env also counts.
const CHILD_PROMPT_RE = /(^|\n)\s*BUDGET:[ \t]*(?:[1-9]|1[0-2])h\b/;

// "waiting on CI", "the test run is in progress", "awaiting CI", "once it finishes" ...
const CI_NOUN = '(?:ci|checks?|tests?|workflows?|runs?|land(?:\\.yml| run)?|build|deploy(?:ment)?|actions?)';
const CI_WAIT_RE = new RegExp(
  '\\b' + CI_NOUN + '\\b[^.;\\n]{0,60}?\\b(?:in progress|in flight|is running|still running|running|pending|queued|to (?:finish|complete)|has not finished|hasn.t finished|kicked off)\\b'
  + '|\\b(?:waiting|awaiting|wait)\\b[^.;\\n]{0,40}\\b' + CI_NOUN + '\\b'
  + '|\\bonce (?:it|the (?:run|workflow|tests?|ci|checks?))\\b[^.;\\n]{0,30}\\b(?:finish|complete|pass|land)',
  'i'
);
// A line that says nothing is pending is not a wait.
const NOT_WAITING_RE = /\b(?:nothing|no\b[^.\n]{0,30}\b(?:running|pending)|finished|completed|passed|green|landed|done)\b/i;

// Commands / tools that start something this session will then wait on.
const DISPATCH_CMD_RE = /\bgh\s+workflow\s+run\b|\bgh\s+run\s+rerun\b|\bgh\s+api\b[^\n]*\/(?:dispatches|runs\/\d+\/rerun)|\bgit\b[^\n|;&]*\bpush\b|merge-worktree-to-main|push-with-retry/;
// A background command only counts as a wake if it actually polls a run/deploy.
const POLL_CMD_RE = /\bgh\s+(?:run|api|pr)\b|actions\/runs|wait-for-(?:land|run)|check-prod-deploy|land\.yml/;
const DISPATCH_TOOL_RE = /run_workflow|workflow_dispatch|actions_run_trigger|rerun_workflow|(?:^|__)create_pull_request$/i;

function isChildSession({ firstPrompt = '', env = {} } = {}) {
  return CHILD_PROMPT_RE.test(firstPrompt || '')
    || !!(env.CLAUDE_PARENT_SESSION_ID || env.PARENT_SESSION_ID);
}

function startedRun(t) {
  if (!t || !t.ok) return false;
  if (t.name === 'Bash') return DISPATCH_CMD_RE.test(String((t.input || {}).command || ''));
  return DISPATCH_TOOL_RE.test(String(t.name || ''));
}

function isWake(t, done) {
  if (!t || !t.ok) return false;
  const inp = t.input || {};
  if (t.name === 'Monitor') return !(t.taskId && done.includes(t.taskId));
  if (t.name === 'Bash' && inp.run_in_background) {
    return POLL_CMD_RE.test(String(inp.command || '')) && !(t.taskId && done.includes(t.taskId));
  }
  return false;
}

/** @returns {{block: boolean, reason: string}} */
function childWaitDecision(input) {
  const { firstPrompt, env, closing = '', tools = [], done = [] } = input || {};
  const no = (reason) => ({ block: false, reason });
  if (!isChildSession({ firstPrompt, env })) return no('not a child session');
  if (!/^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT)\b/m.test(closing.split('\n').filter((l) => l.trim()).slice(-1)[0] || '')) {
    return no('closing verdict is not KEEP OPEN');
  }
  // Only the verdict line and "Still running:" lines state what is awaited.
  const waitLines = closing.split('\n').filter((l) => /^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT|Still running)\b/i.test(l));
  if (!waitLines.some((l) => CI_WAIT_RE.test(l) && !NOT_WAITING_RE.test(l.replace(/^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT)\b/i, '')))) {
    return no('KEEP OPEN does not wait on CI or a run');
  }
  let lastRun = -1;
  for (const t of tools) if (startedRun(t) && t.idx > lastRun) lastRun = t.idx;
  // >= : one background command may dispatch the run and then poll it.
  const armed = tools.some((t) => t.idx >= lastRun && isWake(t, done));
  if (armed) return no('a wake was armed after the last run this session started');
  return { block: true, reason: 'child session waiting on CI/a run it started with no poll armed after it' };
}

module.exports = { childWaitDecision, isChildSession, CI_WAIT_RE, CHILD_PROMPT_RE };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      input.env = input.env || process.env;
      process.stdout.write(JSON.stringify(childWaitDecision(input)));
    } catch (e) {
      process.stderr.write('child-session-wait-guard: failing open: ' + e.message + '\n');
      process.stdout.write(JSON.stringify({ block: false, reason: 'fail-open: ' + e.message }));
    }
  });
}
