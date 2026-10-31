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

// ─── Jobs still running (CHILDJOBS, BRO-6717) ───────────────────────────────
// BRO-6518 (child of BRO-6498) ended two turns KEEP OPEN on its own ingest
// loop and crawl ("jobs still running ... I'll check back on them"). Those
// ran container-local, outside any background task, so nothing woke it: idle
// 17h, then 19h. A child's KEEP OPEN on jobs needs a live run_in_background
// Bash or Monitor (its exit wakes the turn); otherwise poll in-turn, or hand
// the queue to something durable (a workflow, the tic-daily pending queue).
const JOB_NOUN = '(?:jobs?|loops?|crawls?|crawlers?|ingests?|ingestion|batch(?:es)?|queues?|dispatch(?:es)?|scrapes?|scrapers?|backfills?|workers?|process(?:es)?|shards?|fetch(?:es)?)';
const JOBS_WAIT_RE = new RegExp(
  '\\b' + JOB_NOUN + '\\b[^.;\\n]{0,60}?\\b(?:in progress|in flight|is running|are running|still running|still going|running|pending|queued|to (?:finish|complete)|ha(?:s|ve)n.t finished|working through)\\b'
  + '|\\b(?:waiting|awaiting|wait)\\b[^.;\\n]{0,40}\\b' + JOB_NOUN + '\\b'
  + '|\\b(?:I(?:.ll| will)|will) (?:check back|check (?:on|in on) (?:them|it|the)|come back|look again|re-?check)\\b',
  'i'
);

function verdictKeepOpen(closing) {
  const last = String(closing || '').split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
  return /^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT)\b/m.test(last);
}

// A background Bash that only launches a detached process (nohup/setsid/
// disown/trailing &) exits at once; the real job is untracked. Its completion
// notice is sometimes never recorded, so without this it would read as live
// forever (the _live_work "errs live" case in verify-edits.sh).
const DETACHED_RE = /\b(?:nohup|setsid|disown)\b|&\s*(?:$|;|\becho\b)|spawn-detached/m;

/** A background Bash or Monitor still running: no completion notice, no TaskStop, not a detached launcher. */
function liveBackground(tools = [], done = [], cmdRe = null) {
  return tools.some((t) => {
    if (!t || !t.ok) return false;
    const inp = t.input || {};
    const cmd = String(inp.command || '');
    const bg = t.name === 'Monitor' || (t.name === 'Bash' && inp.run_in_background);
    if (!bg || (t.taskId && done.includes(t.taskId))) return false;
    if (t.name === 'Bash' && DETACHED_RE.test(cmd.replace(/&&|\|\||>&|&>|2>&1/g, ' '))) return false;
    return !cmdRe || cmdRe.test(cmd);
  });
}

/** @returns {{block: boolean, reason: string}} */
function childJobsDecision(input) {
  const { firstPrompt, env, closing = '', tools = [], done = [] } = input || {};
  const no = (reason) => ({ block: false, reason });
  if (!isChildSession({ firstPrompt, env })) return no('not a child session');
  if (!verdictKeepOpen(closing)) return no('closing verdict is not KEEP OPEN');
  const waitLines = closing.split('\n').filter((l) => /^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT|Still running)\b/i.test(l));
  const strip = (l) => l.replace(/^[\s*_•-]{0,4}(?:KEEP OPEN|NOT SAFE TO EXIT|Still running:?)\s*[—–:,-]?\s*/i, '');
  if (!waitLines.some((l) => JOBS_WAIT_RE.test(l) && !NOT_WAITING_RE.test(strip(l)))) {
    return no('KEEP OPEN does not wait on jobs this session runs');
  }
  if (liveBackground(tools, done)) return no('a background task or Monitor is live');
  return { block: true, reason: 'child session ends KEEP OPEN on running jobs with no live background task or Monitor' };
}

// ─── Parent waiting on a child (CHILDWATCH, BRO-6717) ───────────────────────
// The BRO-6518 parent ended KEEP OPEN on its child's report-back; an idle
// child sends neither a report nor a failure event, so the parent never woke.
// A parent ending KEEP OPEN with a live child needs a live
// `child-idle-watch.js watch` background task (it wakes the parent within 30
// min to check get_session).
const WATCH_CMD_RE = /child-idle-watch(?:\.js)?\s+watch\b/;

/** @returns {{block: boolean, reason: string}} */
function parentWatchDecision(input) {
  const { closing = '', tools = [], done = [], liveChildren = [] } = input || {};
  const no = (reason) => ({ block: false, reason });
  if (!liveChildren.length) return no('no live child session');
  if (!verdictKeepOpen(closing)) return no('closing verdict is not KEEP OPEN');
  if (liveBackground(tools, done, WATCH_CMD_RE)) return no('a child-idle-watch task is live');
  return { block: true, reason: 'parent ends KEEP OPEN on a child session with no child-idle-watch running' };
}

/**
 * All three gates, first block wins. `skip` lists codes already blocked in
 * this Stop chain (or switched off); they are not re-evaluated.
 * @returns {{block: boolean, code: string|null, reason: string}}
 */
function decideAll(input) {
  const skip = new Set((input && input.skip) || []);
  const reasons = [];
  for (const [code, fn] of [['CHILDWAIT', childWaitDecision], ['CHILDJOBS', childJobsDecision], ['CHILDWATCH', parentWatchDecision]]) {
    if (skip.has(code)) continue;
    const r = fn(input);
    if (r.block) return { block: true, code, reason: r.reason };
    reasons.push(code + ': ' + r.reason);
  }
  return { block: false, code: null, reason: reasons.join('; ') };
}

module.exports = {
  childWaitDecision, childJobsDecision, parentWatchDecision, decideAll,
  isChildSession, liveBackground, CI_WAIT_RE, JOBS_WAIT_RE, CHILD_PROMPT_RE, WATCH_CMD_RE, DETACHED_RE,
};

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      input.env = input.env || process.env;
      process.stdout.write(JSON.stringify(input.all ? decideAll(input) : childWaitDecision(input)));
    } catch (e) {
      process.stderr.write('child-session-wait-guard: failing open: ' + e.message + '\n');
      process.stdout.write(JSON.stringify({ block: false, code: null, reason: 'fail-open: ' + e.message }));
    }
  });
}
