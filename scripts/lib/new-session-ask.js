'use strict';
/**
 * NEWSESSIONASK (BRO-7918): a closing message or push notification that tells the owner to
 * "start a new session" / "open a fresh session and tell it ..." is blocked. The owner is not
 * technical and never starts sessions: a worker hands the work to its card and @parent, or
 * starts the session itself (create_session), and ends SAFE TO ARCHIVE. Real case 2026-11-20:
 * the BRO-7741 session told the owner to "start a new session and tell it to finish and release
 * BRO-7741" although BRO-7741 was already Done.
 *
 * Pure: newSessionAsk(text) -> { block, match }. CLI: stdin {text} -> stdout JSON (fail-open).
 */
const SESSION_NOUN = '(?:claude\\s+)?(?:code\\s+)?(?:session|chat|worker|conversation|tab)';
const ASK_RE = new RegExp([
  // "start a new session", "open a fresh session", "spin up another worker"
  '\\b(?:start|open|begin|spin up|launch|kick off|create)\\s+(?:up\\s+)?(?:a\\s+|an\\s+|another\\s+|the\\s+)?(?:new|fresh|separate|second|clean)\\s+' + SESSION_NOUN + '\\b',
  // "you can start a session", "you need to start another session"
  '\\byou\\s+(?:can|could|should|need to|will need to|have to|must|may want to)\\s+(?:start|open|begin|launch)\\s+(?:a\\s+|an\\s+|another\\s+)?(?:new\\s+|fresh\\s+)?' + SESSION_NOUN + '\\b',
  // "tell a new session to ...", "ask a fresh session to ..."
  '\\b(?:tell|ask|have)\\s+(?:a\\s+|an\\s+)?(?:new|fresh)\\s+' + SESSION_NOUN + '\\s+to\\b',
].join('|'), 'i');
const NEGATION_RE = /\b(?:never|don'?t|do not|doesn'?t|did not|didn'?t|not|no need to|without|instead of|banned|blocked|refuse[sd]?|rather than)\b/i;

function inQuotes(text, idx) {
  const before = text.slice(0, idx);
  const dq = (before.match(/["“”]/g) || []).length;
  const bt = (before.match(/`/g) || []).length;
  return dq % 2 === 1 || bt % 2 === 1;
}

/** @returns {{block: boolean, match: string|null}} */
function newSessionAsk(text) {
  const t = String(text || '');
  const re = new RegExp(ASK_RE.source, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const clause = t.slice(Math.max(0, m.index - 60), m.index).split(/[.;:!?\n—–]/).pop();
    if (NEGATION_RE.test(clause) || inQuotes(t, m.index)) continue;
    return { block: true, match: m[0] };
  }
  return { block: false, match: null };
}

module.exports = { newSessionAsk, ASK_RE };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify(newSessionAsk(JSON.parse(raw || '{}').text))); }
    catch (e) { process.stderr.write('new-session-ask: failing open: ' + e.message + '\n'); process.stdout.write('{"block":false,"match":null}'); }
  });
}
