// Reads one owner reply and says whether it is a clear "ship it" (BRO-7848).
//
// Why this exists: the push gate used to reject a whole message if ANY negation
// word appeared anywhere in it. An emphatic repeated yes ("I don't know how many
// times I need to say yes, do it, go, ship it, but get it done") and a yes with a
// follow-up ask ("Yes\nBut fix the system after") were both refused, and a bare
// "go" was never in the word list. The owner had to retype a yes six times.
//
// Rule now: split the message into clauses, then
//   approve  = at least one clause says yes/ship/go AND no clause is a stop
//   stop     = any clause that holds, delays, conditions or negates the push
//   neutral  = nothing either way (not an approval)
// Fails toward asking, never toward shipping: every old stop word is still a stop,
// it just no longer poisons an unrelated clause. Only the owner's typed text is
// ever passed in (the caller filters synthetic records); the agent cannot forge it.

// Words that mean yes. "go" is handled separately, only as a whole clause.
const APPROVE_RE = /\b(?:approved?|ship|push|send|deploy|publish|merge|lgtm|looks good|looks great|great|perfect|awesome|beautiful|love it|nice|go ahead|go for it|good to go|all good|yep|yup|yeah|yes|do it)\b/i;
const BARE_GO_RE = /^(?:go|go go|go now|go please|please go)$/i;

// A clause that holds, delays or conditions the push, wherever it sits in the clause.
const STOP_RE = /\b(?:hold|wait|stop|cancel|pause|nah|nope|no|except|unless|first|before|until|once|later|although|though|rather|instead|revisit|hang on|not yet|not sure|never mind|one sec|tomorrow|tonight|if|when|assuming|provided|pending|as long as|soon|eventually|after|afterwards|next|week|weeks|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hours?|lunch|let me|need to see|want to see|look again|another look|check|kidding|show me|send me|also|broken|wrong|off|bug|bugs|issues?|problems?|bad|ugly|not working)\b/i;
// fix/change/redo is a stop ("looks good, fix the padding first") unless the clause
// defers it AFTER the verb ("fix the system so it's less annoying after").
const CHANGE_VERB_RE = /\b(?:fix|change|redo|rework|tweak)\b/i;
const DEFERRAL_AFTER_VERB_RE = /\b(?:fix|change|redo|rework|tweak)\b[^]*\b(?:after|afterwards|afterward|later|next|separately|follow-?up)\b/i;
// "later"/"once"/"until"/"first"/"before"/"instead" are stops, except inside a deferred change request.
const DEFERRABLE_STOP_RE = /\b(?:later|once|until|first|before|instead|rather|after|afterwards|afterward|next|soon)\b/i;

// A negation aimed at the push itself: "don't ship", "do not push it yet", "I said don't do it".
const NEGATOR_RE = /\b(?:don'?t|do not|didn'?t|did not|never|not|shouldn'?t|cant|can'?t|cannot|wouldn'?t|won'?t)\b/i;
// Any of these anywhere in a clause stops it: "don't.", "ship it, NOT", "yes but not the header", "cannot ship".
// "never" is not here: "I never have to fall into this trap again" is not a stop (negatesPush covers "never ship").
const HARD_NEGATOR_RE = /\b(?:don'?t|do not|dont|didn'?t|did not|not|shouldn'?t|cant|can'?t|cannot|wouldn'?t|won'?t|nor|neither)\b/i;
// The one idiom a frustrated owner types next to a yes: "I don't know how many times I need to say yes".
const FRUSTRATION_IDIOM_RE = /\b(?:don'?t|do not|dont)\s+know\s+how\s+(?:many|often|much|long)\b/gi;
const ACTION_RE = /^(?:ship|push|deploy|land|merge|send|publish|release|it|this|that|them|yet|do)$/i;

function splitClauses(text) {
  return String(text)
    .split(/[\n\r.!?;,]+|\b(?:but|however|then)\b/i)
    .map(c => c.replace(/^[\s"'“”()-]+|[\s"'“”()-]+$/g, ''))
    .filter(Boolean);
}

function negatesPush(clause) {
  const toks = clause.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    // "do not" is two tokens; test the pair as well as the single word.
    const here = toks[i] === 'do' && toks[i + 1] === 'not' ? 'do not' : toks[i];
    if (!NEGATOR_RE.test(here)) continue;
    const start = i + (here === 'do not' ? 2 : 1);
    const window = toks.slice(start, start + 3);
    // "not approved", "don't ship it": a negation right before the push or any yes-word.
    if (window.some(t => ACTION_RE.test(t)) || APPROVE_RE.test(window.join(' '))) return true;
  }
  return false;
}

export function isStopClause(clause) {
  const deferred = DEFERRAL_AFTER_VERB_RE.test(clause);
  if (CHANGE_VERB_RE.test(clause) && !deferred) return true;
  let probe = clause;
  if (deferred) probe = probe.replace(new RegExp(DEFERRABLE_STOP_RE.source, 'gi'), ' ');
  probe = probe.replace(FRUSTRATION_IDIOM_RE, ' ');
  return STOP_RE.test(probe) || HARD_NEGATOR_RE.test(probe) || negatesPush(probe);
}

export function isApproveClause(clause) {
  return APPROVE_RE.test(clause) || BARE_GO_RE.test(clause.trim());
}

/** @returns {'approve'|'stop'|'neutral'} */
export function classifyOwnerReply(text) {
  if (!text || typeof text !== 'string') return 'neutral';
  // iPhone keyboards type curly apostrophes: "don’t" must read as "don't".
  const clauses = splitClauses(text.replace(/[\u2018\u2019\u02BC]/g, "'"));
  if (clauses.some(isStopClause)) return 'stop';
  return clauses.some(isApproveClause) ? 'approve' : 'neutral';
}
