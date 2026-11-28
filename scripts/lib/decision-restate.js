'use strict';
/**
 * decision-restate.js (BRO-6539): before a session restates a DECISION NEEDED,
 * drop the items whose card already holds the owner's answer. The owner
 * answered BRO-5646 and approved BRO-4309 / BRO-4303 through the decisions
 * email, and the parent session kept restating all three for 3+ hours because
 * nothing made it re-read the cards.
 *
 * An item is answered when the card has an owner-decision or visual-approval
 * comment NEWER than the question. The question time is the latest comment that
 * asks (a DECISION NEEDED block or "Asked the owner to look at"). The automatic
 * "Waiting on your approval" notice is a reminder, not a new question, so it
 * never moves the question time forward (that was the BRO-4303 re-ask).
 * Every Claude session comments under the owner's identity, so author is no
 * signal: only the answer markers below count.
 *
 *   node scripts/lib/decision-restate.js BRO-5646 BRO-4303        # per-card verdict
 *   printf '%s' "$MESSAGE" | node scripts/lib/decision-restate.js --message-stdin
 *
 * --message-stdin reads a chat reply, finds the BRO ids inside its DECISION
 * NEEDED blocks (plus, with --transcript=<file>, the ids in transcript entries that
 * carry a DECISION NEEDED, since chat replies are written without ids) and prints one
 * line per answered card (nothing when none).
 * Exit 0 always, unless --strict and something is answered (exit 3).
 */

const { MARK } = require('./visual-approval.js');
const link = require('../../src/lib/owner-decision-link.js');

// What an owner answer looks like on the card. Approve ships through the
// lander, which leaves the VQA / VQL markers; the email answer page and
// record-owner-answer.js leave the "Owner decision" comment; decision-reply.js
// leaves "Owner answered / declined / picked / chose".
const ANSWER_RES = [
  /^\*{0,2}Owner decision\*{0,2}(?!\s+needed)(?![^\n]*closed without an owner tap)/i,
  /^owner (?:answered|declined|picked|chose)\b/i,
  new RegExp(MARK.approved.replace(/\s+/g, '\\s+')),
  new RegExp(MARK.landed.replace(/\s+/g, '\\s+')),
];
// A comment that really asks again. NOT the auto "Waiting on your approval".
const QUESTION_RES = [/DECISION NEEDED/, /^Asked the owner to look at/i];
// Approved/chosen answers close the question; a decline sends work back to the
// worker, who may legitimately ask again afterwards.
const DECLINE_RE = /^owner declined\b|\bChose:\s*(?:reject(?:ed)?|no)\b/i;
// Later states that undo an Approve (visual-approval.js classifyStatus: void, unverified, expired).
const UNDO_RES = [MARK.void, MARK.unverified, MARK.expired, MARK.stale].map((m) => new RegExp(m.replace(/\s+/g, '\\s+')));

const plain = (body) => link.unescapeMarkdown(String(body || '')).trim();
const ms = (c) => { const t = new Date(c && c.createdAt).getTime(); return Number.isFinite(t) ? t : null; };

function isAnswer(c) {
  const t = plain(c.body);
  return !/DECISION NEEDED/.test(t) && ANSWER_RES.some((re) => re.test(t));
}
function isQuestion(c) {
  const t = plain(c.body);
  return QUESTION_RES.some((re) => re.test(t));
}

/**
 * @param {Array<{body:string, createdAt?:string}>} comments one card's comments
 * @param {{askedAt?: number|string|Date|null}} [opts] override when the caller knows the question time
 * @returns {{answered:boolean, answer:?{text:string, at:?string}, askedAt:?string}}
 */
function answerState(comments, { askedAt = null } = {}) {
  const dated = (comments || []).filter((c) => c && c.body != null && ms(c) != null).sort((a, b) => ms(a) - ms(b));
  const given = askedAt == null ? null : new Date(askedAt).getTime();
  const lastQuestion = dated.filter(isQuestion).at(-1);
  const since = Number.isFinite(given) ? given : (lastQuestion ? ms(lastQuestion) : -Infinity);
  const hit = dated.filter((c) => ms(c) > since && isAnswer(c) && !DECLINE_RE.test(plain(c.body)))
    .filter((c, _i, _a) => !dated.some((u) => ms(u) > ms(c) && UNDO_RES.some((re) => re.test(plain(u.body))))).at(-1);
  return {
    answered: !!hit,
    answer: hit ? { text: plain(hit.body).replace(/\s+/g, ' ').slice(0, 160), at: hit.createdAt || null } : null,
    askedAt: Number.isFinite(since) ? new Date(since).toISOString() : null,
  };
}

/**
 * Split the items a session is about to restate.
 * @param {Array<{card:string}>} items
 * @param {Map<string,Array>|Object} commentsByCard
 * @returns {{keep:Array, dropped:Array<{card:string, answer:object}>}}
 */
function dropAnswered(items, commentsByCard) {
  const get = (id) => (commentsByCard instanceof Map ? commentsByCard.get(id) : (commentsByCard || {})[id]) || [];
  const keep = [];
  const dropped = [];
  for (const item of items || []) {
    const st = answerState(get(item.card), { askedAt: item.askedAt });
    if (st.answered) dropped.push({ ...item, answer: st.answer }); else keep.push(item);
  }
  return { keep, dropped };
}

/** True when a Linear issue (comments as {nodes:[...]} or an array) already holds the owner's answer. Fails open. */
function isIssueAnswered(issue) {
  const c = issue && issue.comments;
  const list = Array.isArray(c) ? c : (c && c.nodes) || [];
  return list.length ? answerState(list).answered : false;
}

/** BRO ids named inside DECISION NEEDED blocks (a block runs to its Default: line or a blank line pair). */
function decisionCards(message) {
  const lines = String(message || '').split('\n');
  const ids = new Set();
  let inBlock = false;
  let blanks = 0;
  for (const line of lines) {
    if (/^[\s>*_-]*DECISION NEEDED:/.test(line)) { inBlock = true; blanks = 0; }
    else if (inBlock && /^\s*$/.test(line) && ++blanks >= 2) inBlock = false;
    else if (inBlock && line.trim()) blanks = 0;
    if (!inBlock) continue;
    for (const m of line.matchAll(/\bBRO-(\d+)\b/g)) ids.add(`BRO-${m[1]}`);
    if (/^[\s>*_-]*Default:/.test(line)) inBlock = false;
  }
  return [...ids];
}

/** Card ids a session worked with when it wrote a DECISION NEEDED: the ids in each transcript entry that carries one. */
function decisionCardsFromTranscript(text) {
  const ids = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('DECISION NEEDED')) continue;
    // Only the assistant's own turns: tool results and file reads quote the phrase too.
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if ((entry.type || (entry.message && entry.message.role)) !== 'assistant') continue;
    for (const m of line.matchAll(/\bBRO-(\d+)\b/g)) ids.add(`BRO-${m[1]}`);
  }
  return [...ids];
}

async function checkCards(cards, { listComments } = {}) {
  const list = listComments || ((ids) => require('./linear-client.js').listIssueComments(ids));
  const map = await list(cards);
  return dropAnswered(cards.map((card) => ({ card })), map);
}

async function main(argv = process.argv.slice(2), { stdin = () => require('fs').readFileSync(0, 'utf8'), out = console.log, listComments } = {}) {
  const strict = argv.includes('--strict');
  let cards = argv.filter((a) => /^BRO-\d+$/i.test(a)).map((a) => a.toUpperCase());
  if (argv.includes('--message-stdin')) {
    cards = decisionCards(stdin());
    const t = argv.find((a) => a.startsWith('--transcript='));
    if (t) { try { cards = [...new Set([...cards, ...decisionCardsFromTranscript(require('fs').readFileSync(t.slice(13), 'utf8'))])]; } catch { /* no transcript */ } }
  }
  if (!cards.length) return 0;
  const { keep, dropped } = await checkCards(cards, { listComments });
  if (!argv.includes('--message-stdin')) keep.forEach((i) => out(`${i.card}: open (no owner answer after the question)`));
  dropped.forEach((d) => out(`${d.card}: ALREADY ANSWERED${d.answer.at ? ` on ${String(d.answer.at).slice(0, 10)}` : ''}: ${d.answer.text}. Do not restate it; act on the answer.`));
  return strict && dropped.length ? 3 : 0;
}

/**
 * Stop-hook entry (verify-edits.sh pipes its JSON input here). Advisory by default (CLAUDE.md section 19): logs to
 * stderr and .cache/decision-restate-advisory.log and exits 0. Exit 2 only with DECISION_RESTATE_ENFORCE=1 and no
 * NO-VERIFY: in the message. DECISION_RESTATE_DISABLE=1 turns it off. Any error fails open.
 */
async function stopHook(raw, { env = process.env, listComments, log = (l) => require('fs').appendFileSync(require('path').join(__dirname, '../../.cache/decision-restate-advisory.log'), l) } = {}) {
  if (env.DECISION_RESTATE_DISABLE === '1') return { code: 0 };
  let input; try { input = JSON.parse(raw); } catch { return { code: 0 }; }
  const msg = String(input.last_assistant_message || '');
  if (!msg.includes('DECISION NEEDED:')) return { code: 0 };
  const lines = [];
  const argv = ['--message-stdin', ...(input.transcript_path ? [`--transcript=${input.transcript_path}`] : [])];
  await main(argv, { stdin: () => msg, out: (l) => lines.push(l), listComments });
  if (!lines.length) return { code: 0 };
  const out = lines.join('\n');
  try { require('fs').mkdirSync(require('path').join(__dirname, '../../.cache'), { recursive: true }); log(`${new Date().toISOString()}\n${out}\n`); } catch { /* log is best effort */ }
  if (env.DECISION_RESTATE_ENFORCE === '1' && !msg.includes('NO-VERIFY:')) {
    return { code: 2, message: `BLOCKED: this message restates a decision the owner already answered on the card (BRO-6539):\n${out}\nAct on the answer and drop it from the message. Bypass: NO-VERIFY: <reason>.` };
  }
  return { code: 0, message: `[decision-restate advisory] ${out}` };
}

if (require.main === module && process.argv.includes('--stop-hook')) {
  let raw = ''; process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    stopHook(raw).then((r) => { if (r.message) console.error(r.message); process.exitCode = r.code; }, () => { process.exitCode = 0; });
  });
} else if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[decision-restate] ${e.message}`); process.exitCode = 0; });
}

module.exports = { isIssueAnswered, stopHook, answerState, dropAnswered, decisionCards, decisionCardsFromTranscript, checkCards, isAnswer, isQuestion, main };
