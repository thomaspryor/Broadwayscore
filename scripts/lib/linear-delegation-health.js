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
 * worked look identical. The distinguishing signal is ACTIVITIES — and
 * specifically, activities that represent work rather than boilerplate.
 *
 * Pure so it can be tested against fixtures; the caller does the API call.
 */

// Every agent opens with the same two lines. They prove a session spawned, not
// that anything is happening.
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

function isBoilerplate(body) {
  const text = String(body || '').trim();
  return BOILERPLATE.some((re) => re.test(text));
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

    // Judge the newest session; older ones are superseded.
    const newest = [...sessions].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const acts = newest.activities || [];
    const ageMs = nowMs - Date.parse(newest.createdAt);
    const real = acts.filter((a) => !isBoilerplate(a.body));
    const blockedOnly = real.length > 0 && real.every((a) => BLOCKED_NOTICE.test(String(a.body || '').trim()));

    if (blockedOnly) {
      verdicts.push({ identifier: issue.identifier, verdict: 'blocked',
        detail: String(real[0].body).split('\n')[0].slice(0, 120) });
    } else if (real.length > 0) {
      verdicts.push({ identifier: issue.identifier, verdict: 'working',
        detail: `${real.length} substantive activity/activities` });
    } else if (ageMs > STALL_AFTER_MS) {
      verdicts.push({ identifier: issue.identifier, verdict: 'stalled',
        detail: `session ${Math.round(ageMs / 60000)} min old with only boilerplate — agent accepted the work and is doing nothing` });
    } else {
      verdicts.push({ identifier: issue.identifier, verdict: 'starting',
        detail: `${Math.round(ageMs / 1000)}s old` });
    }
  }

  const bad = verdicts.filter((v) => v.verdict === 'stalled' || v.verdict === 'never-started');
  const blocked = verdicts.filter((v) => v.verdict === 'blocked');

  let alarm = null;
  if (bad.length) {
    alarm = `Linear agents: ${bad.length} delegated issue${bad.length === 1 ? '' : 's'} accepted work and produced nothing — ` +
      bad.map((v) => v.identifier).join(', ') +
      '. The board shows these as assigned and active; they are not running.';
  } else if (blocked.length) {
    alarm = `Linear agents: ${blocked.length} delegated issue${blocked.length === 1 ? '' : 's'} waiting on a blocker and will not start by themselves — ` +
      blocked.map((v) => v.identifier).join(', ') + '.';
  }

  return { verdicts, alarm };
}

module.exports = { assessDelegations, STALL_AFTER_MS };
