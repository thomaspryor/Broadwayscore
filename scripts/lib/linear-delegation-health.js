'use strict';
/**
 * Which delegated Linear issues are silently doing nothing?
 *
 * On 2026-08-16 ten issues were delegated to the hosted agent. Linear created a
 * session for every one, the board showed them assigned and `active`, and all
 * ten produced ZERO activities. Nothing surfaced it. The owner found out by
 * asking a question hours later.
 *
 * The board cannot tell you this: a delegated-but-dead issue and one being
 * worked look identical. The distinguishing signal is RECENT SUBSTANTIVE
 * activity.
 *
 * The question this must answer is "has this session emitted work RECENTLY?",
 * not "has it ever emitted a recognized string?". The first version asked the
 * second question and a code review found three false-negative paths in it —
 * a crashed agent, a long-dead agent, and an agent that scrolled off the query
 * page all reported as healthy. Keep the distinction in mind when editing.
 *
 * Pure so it can be tested against fixtures; the caller does the API call.
 */

// Every agent opens with the same lines. They prove a session spawned, not that
// anything is happening.
const BOILERPLATE = [
  /^I've received your request/i,
  /^\*\*Routing\*\*/,
  /^Using model:/i,
];

// A session that has only said "I'm blocked" is not working, however active it
// looks. This is exactly what BRO-374 did for 20 minutes while reported as fine.
const BLOCKED_NOTICE = /^Blocked by\b/i;

// Below this, an agent that has genuinely started should have said something
// real. Above it, silence means stalled.
const STALL_AFTER_MS = 5 * 60 * 1000;

// Work counts as evidence of life only while it is fresh. A single thought
// posted six hours ago before the agent died is not "working".
const WORK_IS_STALE_AFTER_MS = 30 * 60 * 1000;

// Linear spawns duplicate sessions for the same issue within the same second
// (observed: BRO-379 at 14:16:38.811 and .178). Judging strictly the newest
// makes the verdict depend on a ~400ms coin flip, so treat near-simultaneous
// sessions as one attempt and take the most favourable evidence among them.
const TWIN_WINDOW_MS = 60 * 1000;

// Linear marks a session `stale` itself. Believe it.
const DEAD_SESSION_STATUSES = new Set(['stale', 'error', 'cancelled', 'canceled']);

// An agent that FINISHED is not stalled. Missing this produced false positives
// within minutes of shipping: BRO-374 completed its task and opened PR #596,
// and the alarm still said "started work then stopped". A false alarm on
// successful work is worse than no alarm — it teaches the owner to ignore the
// real ones, which is the entire failure this file exists to prevent.
const FINISHED_SESSION_STATUSES = new Set(['complete', 'completed']);

function isSubstantive(activity) {
  const body = String(activity?.body ?? '').trim();
  // Empty bodies come from activity types the query does not spread (error,
  // elicitation, prompt). They are NOT work — treating them as work meant a
  // crashed agent reported healthy, which is the exact bug this file exists to
  // prevent.
  if (!body) return false;
  return !BOILERPLATE.some((re) => re.test(body));
}

function parseMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {Array} issues [{identifier, delegateName, sessions:[{createdAt, status,
 *   activities:[{createdAt, typename, body}]}]}]
 * @param {number} nowMs
 * @returns {{verdicts: Array, alarm: string|null}}
 */
function assessDelegations(issues, nowMs = Date.now()) {
  const verdicts = [];

  for (const issue of issues || []) {
    if (!issue.delegateName) continue; // not delegated — not this loop's business

    const sessions = issue.sessions || [];
    if (!sessions.length) {
      verdicts.push({ identifier: issue.identifier, verdict: 'never-started',
        detail: 'delegated but Linear never created an agent session' });
      continue;
    }

    const dated = sessions.map((s) => ({ ...s, _ms: parseMs(s.createdAt) }));
    const newestMs = Math.max(...dated.map((s) => s._ms ?? -Infinity));
    // Undateable sessions are suspicious, not safe — keep them in scope rather
    // than letting a malformed createdAt buy permanent "starting" status.
    const attempt = Number.isFinite(newestMs)
      ? dated.filter((s) => s._ms === null || newestMs - s._ms <= TWIN_WINDOW_MS)
      : dated;

    const acts = attempt.flatMap((s) => s.activities || []);
    const real = acts.filter(isSubstantive);
    const blockedOnly = real.length > 0 && real.every((a) => BLOCKED_NOTICE.test(String(a.body).trim()));

    // Freshest substantive activity, falling back to the session start when an
    // activity carries no usable timestamp.
    const lastWorkMs = real.reduce((acc, a) => {
      const ms = parseMs(a.createdAt) ?? (Number.isFinite(newestMs) ? newestMs : null);
      return ms !== null && (acc === null || ms > acc) ? ms : acc;
    }, null);

    const sessionAgeMs = Number.isFinite(newestMs) ? nowMs - newestMs : null;
    const workAgeMs = lastWorkMs === null ? null : nowMs - lastWorkMs;
    const declaredDead = attempt.some((s) => DEAD_SESSION_STATUSES.has(String(s.status || '').toLowerCase()))
      && !attempt.some((s) => String(s.status || '').toLowerCase() === 'active');

    // `finished` is the one FAVOURABLE status here, so it needs the strictest
    // guards — every loophole in it is an agent that silently never alarms.
    //   - a live sibling outranks a completed twin (mirrors declaredDead)
    //   - an undateable session may make things look WORSE, never better, or a
    //     stale session with a malformed createdAt grants permanent immunity
    //   - completing without producing work is not success; that is precisely
    //     the 2026-08-16 failure wearing a green hat
    const finished = attempt.some((s) => s._ms !== null
        && FINISHED_SESSION_STATUSES.has(String(s.status || '').toLowerCase()))
      && !attempt.some((s) => String(s.status || '').toLowerCase() === 'active')
      && real.length > 0;

    // blockedOnly is checked FIRST: an agent posts "Blocked by X", ends its
    // turn, and Linear marks the session complete. Treating that as finished
    // makes a permanently parked delegation read as done — it will never
    // resume on its own, which is the whole reason the blocked verdict exists.
    if (blockedOnly) {
      verdicts.push({ identifier: issue.identifier, verdict: 'blocked',
        detail: String(real[0].body).split('\n')[0].slice(0, 120) });
    } else if (finished) {
      // Handing the result to a human is Loop 5's job, not this alarm's.
      verdicts.push({ identifier: issue.identifier, verdict: 'finished',
        detail: `agent completed after ${real.length} substantive activity/activities` });
    } else if (attempt.some((s) => FINISHED_SESSION_STATUSES.has(String(s.status || '').toLowerCase())) && real.length === 0) {
      verdicts.push({ identifier: issue.identifier, verdict: 'stalled',
        detail: 'session completed without producing any work' });
    } else if (real.length > 0 && workAgeMs !== null && workAgeMs <= WORK_IS_STALE_AFTER_MS && !declaredDead) {
      verdicts.push({ identifier: issue.identifier, verdict: 'working',
        detail: `${real.length} substantive activity/activities, last ${Math.round(workAgeMs / 60000)} min ago` });
    } else if (real.length > 0) {
      // Did real work, then went quiet or was marked dead by Linear.
      const why = declaredDead ? 'Linear marked the session dead' : `no activity for ${Math.round((workAgeMs ?? 0) / 60000)} min`;
      verdicts.push({ identifier: issue.identifier, verdict: 'stalled',
        detail: `started work then stopped — ${why}` });
    } else if (sessionAgeMs === null || sessionAgeMs > STALL_AFTER_MS) {
      const age = sessionAgeMs === null ? 'unknown-age' : `${Math.round(sessionAgeMs / 60000)} min old`;
      verdicts.push({ identifier: issue.identifier, verdict: 'stalled',
        detail: `session ${age} with only boilerplate — agent accepted the work and is doing nothing` });
    } else {
      verdicts.push({ identifier: issue.identifier, verdict: 'starting',
        detail: `${Math.round(sessionAgeMs / 1000)}s old` });
    }
  }

  const bad = verdicts.filter((v) => v.verdict === 'stalled' || v.verdict === 'never-started');
  const blocked = verdicts.filter((v) => v.verdict === 'blocked');

  // Report BOTH. Choosing one meant every blocked delegation became invisible
  // on any morning that also had a stalled one.
  const clauses = [];
  if (bad.length) {
    clauses.push(`${bad.length} delegated issue${bad.length === 1 ? '' : 's'} accepted work and ${bad.length === 1 ? 'is' : 'are'} not running (` +
      bad.map((v) => v.identifier).join(', ') + ')');
  }
  if (blocked.length) {
    clauses.push(`${blocked.length} waiting on a blocker and will not start ${blocked.length === 1 ? 'itself' : 'themselves'} (` +
      blocked.map((v) => v.identifier).join(', ') + ')');
  }
  const alarm = clauses.length
    ? `Linear agents: ${clauses.join('; ')}. The board shows these as assigned. Reply in the issue thread to restart one.`
    : null;

  return { verdicts, alarm };
}

module.exports = { assessDelegations, STALL_AFTER_MS, WORK_IS_STALE_AFTER_MS, TWIN_WINDOW_MS };
