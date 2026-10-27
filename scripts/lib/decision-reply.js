'use strict';

/**
 * decision-reply.js (BRO-6168): turns the owner's reply on a DECISION NEEDED
 * card ("A") into the writes that make something happen.
 *
 * Why: the owner answered "A" on BRO-6110 from the morning digest and nothing
 * read it. The system emailed the question and stopped workers taking the card,
 * but the last step (answer -> action) was missing.
 *
 * Every Linear comment, the owner's and the sessions', is written with the same
 * API user, so "a person replied" can only be read from the TEXT. That is why the
 * grammar below is strict: the whole comment must be a pick ("A", "option b",
 * "go with A") and nothing a session usually writes. A reply that is short but
 * not a pick gets one plain follow-up question, never a guess.
 *
 * BRO-6180: also handles yes/no replies to awaiting-owner approval cards.
 * Pure, no I/O (CLAUDE.md rule 15); scripts/linear-decision-reply-drain.js does
 * the reads and writes.
 */

const { HEADING_RE, MARKER_RE, SETTLED_RE, headingQuestionLine, cleanOwnerText, isPlaceholder, parseDecisionDescription, recommendedKey } = require('./decision-card-parse.js');
const { isEmptyDecisionContent } = require('./needs-you-snapshot.js');
const { AWAITING_OWNER_LABEL, isAwaitingOwner } = require('./owner-approval-channel.js');
const { parseVisualApproval } = require('../../src/lib/owner-decision-link.js');

const TAG_HANDLED = '[owner-reply-handled]';
const TAG_UNCLEAR = '[owner-reply-unclear]';
const MAX_PICK_CHARS = 60;
const MAX_UNCLEAR_CHARS = 200;

// Comments a session or the machinery writes. A match is never the owner's reply.
const SESSION_TEXT_RE = /^(?:owner (?:answered|declined|picked|chose)\b|answered\b|claimed by\b|dispatched\b|outcome\b|pr-evidence\b|verify\b|session report\b|key files\b|unparked\b|auto-|reclaimed|\*\*re-arm|##\s|<!--)/i;
const URL_RE = /https?:\/\/|`|\n/;

function plainBody(body) {
  return String(body == null ? '' : body).replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, '$1').replace(/[*_]+/g, '').trim();
}

/** True when the comment could be a person's words (not a session note or machine line). */
function looksHuman(body) {
  const { isMachineComment } = require('./cloud-worker-pick.js');
  const raw = String(body == null ? '' : body).trim();
  if (!raw) return false;
  if (isMachineComment(raw)) return false;
  if (raw.startsWith(TAG_HANDLED) || raw.startsWith(TAG_UNCLEAR)) return false;
  return !SESSION_TEXT_RE.test(plainBody(raw));
}

const PICK_RE = /^(?:option\s+|(?:i(?:'ll|\s+will)?\s+)?(?:pick|choose|chose|go\s+with|take)\s+(?:option\s+)?)?([A-Za-z0-9])(?:\s*(?:please|thanks|thank you))?\s*[.!]*$/i;
const YES_RE = /^(?:yes|yep|yeah|approved?|go\s+ahead|do\s+it)\s*[.!]*$/i;
// A short reply that is clearly an attempt to answer but not a pick. Anything else short
// ("Working on it", "Done.") is a session note and is ignored, never questioned.
const ANSWER_ATTEMPT_RE = /^(?:no|nope|nah|neither|both|maybe|not sure|idk|first|second|third|last|the (?:first|second|third|last|other)(?: one)?|option\b.*|[A-HJ-Z0-9]\b\s*(?:and|or|then|&|\/|,)\s*\S.*)$/i;
const MAX_ATTEMPT_CHARS = 40;
// An older reply is not acted on: the drain runs twice a day, so a pick this old was either
// answered by hand or belongs to an earlier question.
const MAX_REPLY_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * What a reply means for this card.
 * @returns {{kind: 'pick', key: string, via: 'letter'|'yes'} | {kind: 'unclear', why: string} | {kind: 'ignore'}}
 */
function parseReply(body, card) {
  if (!looksHuman(body)) return { kind: 'ignore' };
  const text = plainBody(body);
  if (!text || text.length > MAX_UNCLEAR_CHARS || URL_RE.test(String(body).trim())) return { kind: 'ignore' };
  const options = (card && card.options) || [];
  if (text.length <= MAX_PICK_CHARS) {
    const m = PICK_RE.exec(text);
    if (m) {
      const key = m[1].toUpperCase();
      if (options.some((o) => o.key === key)) return { kind: 'pick', key, via: 'letter' };
      return { kind: 'unclear', why: options.length ? 'no-such-option' : 'no-options' };
    }
    if (YES_RE.test(text)) {
      const key = recommendedKey(card && card.recommendation, options);
      return key ? { kind: 'pick', key, via: 'yes' } : { kind: 'unclear', why: 'yes-without-recommendation' };
    }
  }
  if (text.length <= MAX_ATTEMPT_CHARS && ANSWER_ATTEMPT_RE.test(text)) return { kind: 'unclear', why: 'not-a-pick' };
  return { kind: 'ignore' };
}

function parseApprovalReply(body) {
  if (!looksHuman(body)) return { kind: 'ignore' };
  const text = plainBody(body);
  const no = /^(?:no|nope|nah|declined?|reject(?:ed)?|not (?:approved|yet)|(?:i )?(?:do not|don['’]t) (?:approve|proceed|ship|go ahead)|hold off|wait|stop)\b/i.exec(text);
  const unclear = { kind: no || /^(?:yes|yep|yeah|approve[ds]?|go ahead|do it|not sure|maybe)\b/i.test(text) ? 'unclear' : 'ignore' };
  if (!text || text.length > MAX_UNCLEAR_CHARS || URL_RE.test(String(body).trim())) return unclear;
  if (YES_RE.test(text)) return { kind: 'approve' };
  // A reason after an explicit no is safe to record. Conditional yes replies
  // and session notes such as "No issues found" never grant approval.
  if (no && /^(?:\s*[.!]*|\s*[:,]\s*\S.*)$/.test(text.slice(no[0].length))) return { kind: 'decline' };
  return unclear;
}

function approvalComment({ action, comment, date }) {
  const words = JSON.stringify(plainBody(comment.body));
  if (action === 'decline') {
    return `Owner declined: by replying ${words} on ${date}.\n\nThe card remains awaiting-owner; nothing was started.`;
  }
  return `Owner answered: approved, by replying ${words} on ${date}.\n\nThe awaiting-owner label was removed. The blocked session or worker can continue.`;
}

function byCreatedAt(a, b) {
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/**
 * The newest comment after the last settled marker that reads as an answer attempt, with what
 * it means, or null. Notes in between (longer session notes) are skipped, not treated as the
 * reply, so a later note cannot hide the owner's "A".
 * Settled markers: an "Owner answered" note, our handled/unclear tags.
 * @returns {{comment: object, reply: object} | null}
 */
function findReplyComment(comments, card, { approval = false } = {}) {
  const sorted = (comments || []).filter((c) => c && c.body != null).slice().sort(byCreatedAt);
  let lastStop = -1;
  sorted.forEach((c, i) => {
    const t = plainBody(c.body);
    if (approval && /^(?:Waiting on your approval\b|Owner decision\b)/i.test(t)) lastStop = i;
    if (/^owner (?:answered|declined|picked|chose)\b/i.test(t) || t.startsWith(TAG_HANDLED) || String(c.body).trim().startsWith(TAG_UNCLEAR)) lastStop = i;
  });
  for (let i = sorted.length - 1; i > lastStop; i--) {
    const reply = approval ? parseApprovalReply(sorted[i].body) : parseReply(sorted[i].body, card);
    if (reply.kind !== 'ignore') return { comment: sorted[i], reply };
  }
  return null;
}

// Why the chosen option cannot run by itself. Checked on the question and the CHOSEN option
// only (the "why" and context lines talk about the machinery, e.g. "spend breaker") (the other options name costs the owner declined). Errs toward
// "needs the owner": a false hit only means a person finishes it.
const OWNER_ONLY_RES = [
  [/\b(?:secrets?|api[- ]?keys?|[a-z0-9]+ (?:key|token)s?|tokens?|passwords?|credentials?|\.env\b|env(?:ironment)? (?:vars?|variables?|settings?)|resend|bright ?data|scrapingbee|scraping bee|browserbase|anthropic)\b|\bpaste\b/i, 'it needs a key or password that only you can add'],
  [/\b(?:spend|billing|purchase|buy|subscription|upgrade|credits?|budget|pricing|invoice|paid|opus|rescor\w*|llm|reviews? with)\b|\bpay(?:s|ing|ment)?\b|\$\s?\d/i, 'it costs money'],
  [/\b(?:broadcast|newsletter|subscribers?|audience|press|customers)\b|\b(?:send|sends|sent|notify|announce)\b[^.\n]{0,60}\b(?:e-?mails?|users|everyone)\b|\be-?mails?\b[^.\n]{0,60}\b(?:to|for)\b[^.\n]{0,30}\b(?:users|everyone|people)\b/i, 'it sends email to real people'],
  [/\b(?:delete|drop(?:ping)?\s+(?:the\s+)?(?:table|data|database)|wipe|purge|force[- ]push|rewrite history|revoke|rotate)\b/i, 'it cannot be undone'],
  [/\b(?:dns|domain registrar|app store|testflight|2fa|claude\.ai|log ?in to|sign ?in to|dashboard settings)\b/i, 'it needs you signed in to an account only you can use'],
];

function ownerOnlyReason(card, key) {
  const chosen = ((card && card.options) || []).find((o) => o.key === key);
  const text = [card && card.question,
    chosen && `${chosen.name} ${chosen.upside} ${chosen.downside}`].filter(Boolean).join(' ');
  const spaced = text.replace(/_/g, ' ');
  for (const [re, reason] of OWNER_ONLY_RES) if (re.test(spaced)) return reason;
  return null;
}

function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '(link)');
}

function shorten(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function dropMarkerFromTitle(title) {
  return String(title || '').replace(/^\s*DECISION NEEDED\s*(?:\([^)]*\))?\s*:?\s*/i, '').trim() || String(title || '');
}

const OWNER_PARK_REASON_RE = /owner[- ](?:decision|call|judg(?:e)?ment)|decision needed|needs? (?:the )?owner/i;

/**
 * The description with the live DECISION NEEDED line turned into an ANSWERED line, the
 * owner-decision PARKED lines turned into UNPARKED (or, when the owner must act, a new
 * PARKED line), and a "To do" line. Works on RAW lines (code fences stay intact).
 * @returns {string|null} null when no live marker line exists
 */
function rewriteDescription(description, { key, name, upside, date, tag, ownerOnly }) {
  const raw = String(description || '').split('\n');
  let inFence = false;
  let at = -1;
  let question = '';
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*(```|~~~)/.test(raw[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const plain = raw[i].replace(/`[^`]*`/g, '');
    let m = MARKER_RE.exec(plain);
    let qLine = i;
    if (HEADING_RE.test(plain)) { // BRO-6443: "## DECISION NEEDED" heading, question on the next line
      const h = headingQuestionLine(raw, i);
      if (h < 0) continue;
      qLine = h;
      m = MARKER_RE.exec(raw[h]) || [null, raw[h].replace(/^\s*(?:(?:[-*>]|\d+[.)])\s+)*(?:\[[ xX]\]\s+)?(?:\*\*|__)?/, '')];
    }
    if (!m) continue;
    const q = cleanOwnerText(m[1]).replace(/\*+$/, '').trim();
    if (!q || isPlaceholder(q) || isEmptyDecisionContent(q) || SETTLED_RE.test(q)) continue;
    at = qLine; question = q;
    break;
  }
  if (at < 0) return null;
  const who = `owner chose Option ${key}${name ? ` (${name})` : ''}`;
  const out = raw.slice();
  const todo = ownerOnly
    ? `To do: Option ${key} needs you, not a worker: ${ownerOnly}.`
    : `To do: carry out Option ${key}${name ? ` (${name})` : ''}${upside ? `: ${upside}` : ''}.`;
  out.splice(at, 1, `ANSWERED ${date}: ${who}. Question was: ${shorten(stripUrls(question), 300)}`, todo);
  const joined = out.join('\n');
  return joined.replace(/^(\s*)PARKED\s*:(.*)$/gim, (line, lead, reason) => {
    if (!OWNER_PARK_REASON_RE.test(reason)) return line;
    return ownerOnly
      ? `${lead}PARKED: owner action needed (${ownerOnly}); answered ${date}`
      : `${lead}UNPARKED (${tag} ${date}):${reason}`;
  });
}

function optionLabel(key, name) {
  return `Option ${key}${name ? ` (${name})` : ''}`;
}

// Comment formats. "Owner answered" is the literal owner-decision-recall reads (ANSWER_RE),
// so the question text is never quoted here (it would trip isAnswerComment on DECISION NEEDED).
function answeredComment({ key, name, replyText, date }) {
  return `Owner answered: ${optionLabel(key, name)}, by replying "${shorten(plainBody(replyText), 40)}" on ${date}.`;
}

function dispatchedNote(verifyCmd) {
  return `\n\nThis is now ordinary work for the cloud workers (check: ${verifyCmd}). Picked up by the daily decision-reply drain (scripts/linear-decision-reply-drain.js, BRO-6168).`;
}

function needsSessionNote(why) {
  return `\n\nThe answer is recorded, but no worker can start it yet (${why}). It stays on the board for a session to write the check and carry it out.`;
}

function ownerOnlyComment({ key, name, reason }) {
  return `Nothing was started, because ${reason}. That step has to be done by you; once it is done, say so on this card and a session will carry out the rest.`;
}

function clarifyComment({ options }) {
  const keys = (options || []).map((o) => o.key).join(', ');
  return `${TAG_UNCLEAR} Your note is on the card, but I could not tell which option it picks, so nothing has been started. ${keys ? `To choose, reply with just one letter (${keys}).` : 'To choose, reply with a single word: the option you want.'} If you were adding a point instead, no action is needed: it stays here for whoever works on this next.`;
}

/**
 * One decision, one verdict. `issue` is a full read (description, title, comments.nodes,
 * labels, state, priority). Returns {action, ...} where action is one of
 * 'skip' | 'clarify' | 'dispatch' | 'needs-session' | 'owner-only' | 'approve' | 'decline'.
 */
function planReply(issue, { date, verifyCommand, unfitReason, nowMs } = {}) {
  if (['completed', 'canceled'].includes(issue.state && issue.state.type)) return { action: 'skip', why: 'closed' };
  const card = parseDecisionDescription(issue.description);
  const approval = !card && isAwaitingOwner(issue);
  if (!card && !approval) return { action: 'skip', why: 'no-live-decision' };
  // Signed visual approvals bind a particular diff and verdict. A plain yes
  // must not stand in for their VQA authorization.
  if (approval && parseVisualApproval(issue.description)) return { action: 'skip', why: 'signed-visual-approval' };
  const comments = (issue.comments && issue.comments.nodes) || [];
  const found = findReplyComment(comments, card, { approval });
  if (!found) return { action: 'skip', why: 'no-reply' };
  const { comment, reply } = found;
  const at = Date.parse(comment.createdAt);
  if (Number.isFinite(nowMs) && Number.isFinite(at) && nowMs - at > MAX_REPLY_AGE_MS) return { action: 'skip', why: 'reply-too-old' };
  if (approval && reply.kind === 'unclear') return { action: 'skip', why: 'unclear-approval-reply' };
  if (approval) return { action: reply.kind, comment, date };
  if (reply.kind === 'unclear') return { action: 'clarify', why: reply.why, comment, card };
  const opt = card.options.find((o) => o.key === reply.key) || {};
  const base = { key: reply.key, name: opt.name || '', upside: opt.upside || '', comment, card, date };
  const ownerOnly = ownerOnlyReason(card, reply.key);
  if (ownerOnly) return { action: 'owner-only', ownerOnly, ...base };
  const next = { ...issue, title: dropMarkerFromTitle(issue.title) };
  const description = rewriteDescription(issue.description, { ...base, tag: 'BRO-6168 owner reply' });
  if (!description) return { action: 'skip', why: 'no-live-decision' };
  next.description = description;
  const cmd = typeof verifyCommand === 'function' ? verifyCommand(next) : null;
  const unfit = typeof unfitReason === 'function' ? unfitReason(next) : null;
  if (cmd && !unfit) return { action: 'dispatch', verify: cmd, description, title: next.title, ...base };
  return { action: 'needs-session', why: !cmd ? 'there is no safe check command on the card yet' : `the card is not worker-ready (${unfit})`, description, title: next.title, ...base };
}

module.exports = {
  AWAITING_OWNER_LABEL, TAG_HANDLED, TAG_UNCLEAR,
  answeredComment, approvalComment, clarifyComment, dispatchedNote, dropMarkerFromTitle, findReplyComment, looksHuman,
  needsSessionNote, ownerOnlyComment, ownerOnlyReason, parseReply, planReply, rewriteDescription,
};
