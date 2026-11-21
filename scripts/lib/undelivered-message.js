// BRO-7924: a session whose send_message / SendMessage call was refused or errored (no later successful
// send to the same target) must not end KEEP OPEN waiting on a reply, report or session. Nothing will
// wake it. Pure decision, wired into deadWaitDecision (DEADWAIT) in child-session-wait-guard.js.
'use strict';

const SEND_RE = /(?:^|__)send_?message$/i;
// A send tool_result that is not a delivery: refusal, inactive session, error status.
const FAIL_RESULT_RE = /\b(?:permission denied|denied|refused|not allowed|needs approval|session_inactive|session not found|unreachable)\b|"status"\s*:\s*"(?:error|failed|refused|denied|inactive)"/i;
const DELIVERED_RE = /"(?:status"\s*:\s*"(?:delivered|queued|sent)"|delivered"\s*:\s*true)/i;
const WAIT_ON_RE = /\b(?:repl(?:y|ies)|report(?:-?backs?)?|response|answer|ack(?:nowledg\w+)?|parent|sessions?|workers?|peer)\b/i;

const targetOf = (t) => String((t.input && (t.input.session_id || t.input.to)) || '');
// A delivery receipt wins over words like "failed" elsewhere in the result (e.g. "0 failed checks").
const failed = (t) => t.ok === false || (t.result ? !DELIVERED_RE.test(String(t.result)) && FAIL_RESULT_RE.test(String(t.result)) : false);

/** Targets whose LAST send (in tool order) failed. tools: [{idx, name, input, ok, result?}] */
function undeliveredTargets(tools = []) {
  const last = new Map();
  for (const t of tools) {
    if (!t || !SEND_RE.test(String(t.name || ''))) continue;
    last.set(targetOf(t), failed(t));
  }
  return [...last].filter(([, bad]) => bad).map(([target]) => target);
}

/**
 * @param {{closing?: string, tools?: object[], liveWake?: boolean}} input
 * @returns {{block: boolean, reason: string, target?: string}}
 */
function undeliveredDecision({ closing = '', tools = [], liveWake = false } = {}) {
  const no = (reason) => ({ block: false, reason });
  const lines = String(closing).split('\n').filter((l) => l.trim());
  const verdict = lines[lines.length - 1] || '';
  if (!/^[\s*_•-]{0,4}KEEP OPEN\b/i.test(verdict)) return no('closing verdict is not KEEP OPEN');
  const bad = undeliveredTargets(tools);
  if (!bad.length) return no('no undelivered send_message');
  if (liveWake) return no('a background wait or live agent will wake it');
  const wait = verdict.replace(/^[\s*_•-]{0,4}KEEP OPEN\s*[—–:,-]?\s*/i, '');
  if (!WAIT_ON_RE.test(wait)) return no('KEEP OPEN does not wait on a reply, report or session');
  return { block: true, target: bad[0],
    reason: 'a send_message/SendMessage to ' + (bad[0] || 'a session') + ' was refused or errored and KEEP OPEN still waits on that session; say plainly "could not reach that session" and end SAFE TO ARCHIVE or ACTION NEEDED FROM YOU' };
}

module.exports = { undeliveredTargets, undeliveredDecision, SEND_RE };
