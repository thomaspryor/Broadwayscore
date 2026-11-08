'use strict';
/**
 * llm-triage-facts.js — the FACTS block for the llm-triage prompt (BRO-7139 Step 3).
 *
 * Step 0 scored prompt v1 on 15 real cards: every wrong verdict came from the
 * model trusting a fact quoted in the card (a test that no longer exists, a
 * card that was already Done, a page "once it is live" that was live). v2
 * (scripts/lib/llm-triage-prompt.md) is given facts gathered by machine and
 * told they override the card. This module turns plain inputs into those
 * facts and renders the prompt. No I/O: scripts/llm-triage.js fetches Linear,
 * runs the VERIFY command, searches commits and reads the alert ledger, then
 * hands the results in (CLAUDE.md rule 15).
 *
 * Report-only: nothing here, or in the CLI, writes Linear.
 */
const fs = require('fs');
const path = require('path');
const { extractVerifyCmd } = require('./autonomous-verify-cmd.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./check-paths.js');
const { conditionKeyOf, conditionKeyFromLedger } = require('./board-closer.js');
const { VERDICTS: RUN } = require('./close-time-verify.js');
const { sortedComments } = require('./board-categories.js');

const PROMPT_PATH = path.join(__dirname, 'llm-triage-prompt.md');
const VERDICTS = ['close-candidate', 'blocked', 'release', 'ask-owner', 'recheck', 'keep'];
const ID_RE = /\bBRO-\d+\b/g;
const OVERLAP_MIN = 0.6;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'its', 'with', 'by', 'at', 'from', 'not', 'no', 'be', 'fix', 'p0', 'p1', 'p2', 'p3', 'bsc', 'daily']);

/**
 * All comment bodies plus the description, oldest comment first. Linear returns
 * comments NEWEST first (linear-client.js), so every reader here goes through
 * sortedComments (board-categories.js), which sorts by createdAt.
 */
function cardText(issue) {
  const comments = sortedComments(issue);
  return [String((issue && issue.description) || ''), ...comments.map((c) => String(c.body || ''))].join('\n\n');
}

/** BRO-N ids the card names, excluding itself, in first-seen order. */
function referencedIds(text, selfId) {
  const seen = new Set();
  for (const m of String(text || '').matchAll(ID_RE)) if (m[0] !== selfId) seen.add(m[0]);
  return [...seen];
}

/**
 * The card's own runnable check. The latest comment wins over the description
 * (a later comment often replaces a broken VERIFY), so search newest first.
 * @returns {{cmd: string|null, status: 'found'|'none'|'unsafe', reason: string|null}}
 */
function verifyCommandOf(issue) {
  const comments = sortedComments(issue).slice().reverse();
  const sources = [...comments.map((c) => c.body), issue && issue.description];
  let unsafe = null;
  for (const s of sources) {
    const r = extractVerifyCmd(s, isSafeCheckCommand, explainUnsafeCheckCommand);
    if (r.cmd) return { cmd: r.cmd, status: 'found', reason: null };
    if (!unsafe && r.kind !== 'no-section' && r.kind !== 'no-command') unsafe = r.reason;
  }
  return unsafe ? { cmd: null, status: 'unsafe', reason: unsafe } : { cmd: null, status: 'none', reason: null };
}

/**
 * linear-cmd-execution result -> the words the prompt knows. Only the runner's
 * own FAIL verdict is a failure; unverifiable, timeouts and errors stay
 * 'not-run' so a broken runner can never read as "the fix failed".
 */
function verifyResultWord(result) {
  if (!result) return 'not-run';
  if (result.allowed && result.verdict === RUN.PASS) return 'pass';
  if (result.verdict === RUN.FAIL) return 'fail';
  return 'not-run';
}

/**
 * One plain clause saying WHY a VERIFY result is what it is. A bare 'fail'
 * hid the commonest case: the command names a test or script that never
 * reached main, so it fails without saying anything about the work (BRO-7139).
 */
function verifyDetail(result) {
  const word = verifyResultWord(result);
  if (word === 'fail') {
    return result.notOnMain
      ? 'the file this command names is NOT ON MAIN (never landed or was removed); the failure says nothing about the work itself'
      : 'the command ran on main and failed';
  }
  if (word === 'pass') return 'the command ran on main and passed';
  if (result) return 'the command could not be run to a verdict (timeout, unsafe or runner error)';
  return 'not run';
}

function titleTokens(title) {
  return new Set(String(title || '').toLowerCase()
    .replace(/\bbro-\d+\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Jaccard similarity of two titles' content words (0..1). */
function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Other OPEN cards that look like the same work: same alert conditionKey, or a
 * title at least OVERLAP_MIN similar. Capped at 5, most similar first.
 */
function findOverlaps(issue, openIssues, { ledger = null } = {}) {
  const myKey = conditionKeyOf(issue.description) || (ledger ? conditionKeyFromLedger(ledger, issue.identifier) : null);
  const out = [];
  for (const o of openIssues || []) {
    if (!o || o.identifier === issue.identifier) continue;
    const t = o.state && o.state.type;
    if (t === 'completed' || t === 'canceled') continue;
    const key = conditionKeyOf(o.description);
    if (myKey && key && key === myKey) { out.push({ id: o.identifier, title: o.title, why: 'same alert condition', score: 1 }); continue; }
    const s = titleSimilarity(issue.title, o.title);
    if (s >= OVERLAP_MIN) out.push({ id: o.identifier, title: o.title, why: `title ${Math.round(s * 100)}% alike`, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Alert condition and what the ledger says about it now.
 * @returns {{key: string|null, state: 'firing'|'recovered'|'unknown'|null}}
 */
function conditionFacts(issue, ledger) {
  const key = conditionKeyOf(issue.description) || (ledger ? conditionKeyFromLedger(ledger, issue.identifier) : null);
  const closeWhen = (String(issue.description || '').match(/^CLOSE-WHEN:\s*(.+)$/m) || [])[1] || null;
  if (!key) return { key: closeWhen ? `CLOSE-WHEN: ${closeWhen.trim()}` : null, state: closeWhen ? 'unknown' : null };
  const c = ledger && ledger.conditions && ledger.conditions[key];
  if (!c) return { key, state: 'unknown' };
  return { key, state: c.status === 'resolved' ? 'recovered' : (c.status === 'open' ? 'firing' : 'unknown') };
}

/** Commits on main naming the card, dated at or after it was filed. commits: [{sha, date, subject}]. */
function landingsAfter(commits, createdAt) {
  const since = Date.parse(createdAt || '') || 0;
  return (commits || [])
    .filter((c) => (Date.parse(c.date) || 0) >= since)
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, 5);
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const h = ms / 3600e3;
  return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Newest comment that is not one of the board's machine stamps. */
function lastWorkerComment(issue, nowMs) {
  const BOT = /^(\*\*)?(Board dispatch|Recheck|Autonomous recheck|Stuck-card closer|Auto-closed|Recovered|DISPATCHED|board-closer)\b|Generated by the nightly/i;
  const comments = sortedComments(issue).slice().reverse();
  const c = comments.find((x) => !BOT.test(String(x.body || '').trim()));
  if (!c) return 'none';
  const snippet = String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${ageText(nowMs - Date.parse(c.createdAt))}: "${snippet}"`;
}

/**
 * Everything the prompt's FACTS block needs, as display strings.
 * refStates: Map id -> {state, title} for referencedIds (missing = unknown).
 */
function buildFacts({ issue, category, verify, verifyResult, commits, refStates, overlaps, condition, nowMs }) {
  const refs = referencedIds(cardText(issue), issue.identifier).slice(0, 8);
  const refLine = refs.length
    ? refs.map((id) => { const r = refStates && refStates.get(id); return r ? `${id} (${r.state}: ${String(r.title || '').slice(0, 60)})` : `${id} (state unknown)`; }).join('; ')
    : 'none';
  const lands = landingsAfter(commits, issue.createdAt);
  return {
    TODAY: new Date(nowMs).toISOString().slice(0, 10),
    CATEGORY: category || 'unknown',
    VERIFY_CMD: verify.cmd ? `\`${verify.cmd}\`` : (verify.status === 'unsafe' ? `(unsafe: ${String(verify.reason).slice(0, 120)})` : '(none)'),
    VERIFY_RESULT: verify.cmd ? verifyResultWord(verifyResult) : (verify.status === 'unsafe' ? 'unsafe' : 'none'),
    VERIFY_DETAIL: verify.cmd ? verifyDetail(verifyResult) : 'no command',
    CONDITION: condition.key || '(none)',
    CONDITION_STATE: condition.state || 'unknown',
    LANDINGS: lands.length ? lands.map((c) => `${String(c.sha).slice(0, 9)} ${String(c.date).slice(0, 10)} "${String(c.subject).slice(0, 90)}"`).join('; ') : 'none',
    REFERENCED_CARDS: refLine,
    OVERLAPS: (overlaps && overlaps.length) ? overlaps.map((o) => `${o.id} "${String(o.title).slice(0, 70)}" (${o.why})`).join('; ') : 'none',
    LAST_WORKER_COMMENT_AGE: lastWorkerComment(issue, nowMs),
  };
}

/** The card as the model sees it: title, state, description, every comment with its date. */
function renderCard(issue) {
  const comments = sortedComments(issue);
  return [
    `# ${issue.identifier}: ${issue.title}`,
    `state: ${(issue.state && issue.state.name) || '?'}  priority: ${issue.priority ?? '?'}  created: ${String(issue.createdAt || '').slice(0, 10)}`,
    '',
    String(issue.description || ''),
    ...comments.map((c) => `\n--- comment ${String(c.createdAt || '').slice(0, 16)} ---\n${String(c.body || '')}`),
  ].join('\n').slice(0, 30000);
}

/** The prompt body (after the file's `---` header), placeholders filled. */
function renderPrompt(facts, issue, template = fs.readFileSync(PROMPT_PATH, 'utf8')) {
  const body = template.slice(template.indexOf('\n---\n') + 5);
  const all = { ...facts, CARD: renderCard(issue) };
  const out = body.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in all ? String(all[k]) : m));
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left && !String(all.CARD).includes(left[0])) throw new Error(`prompt placeholder not filled: ${left[0]}`);
  return out;
}

/**
 * The first parseable {...} in a reply. Tries the widest span first, then each
 * closing brace in turn, so prose after the object that contains a "}" does
 * not break parsing. null = no brace at all; an Error = braces, none parse.
 */
function firstJsonObject(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  const ends = [];
  for (let i = t.length - 1; i > start; i--) if (t[i] === '}') ends.push(i);
  if (!ends.length) return null;
  let err = null;
  for (const e of [ends[0], ...ends.slice(1).reverse()]) {
    try { return JSON.parse(t.slice(start, e + 1)); } catch (x) { err = err || x; }
  }
  return err;
}

/**
 * Parse and check a model reply. Returns {ok, verdict} or {ok:false, error}.
 * A close-candidate without close_evidence, or naming an id the FACTS never
 * showed, is downgraded to an error so it can never reach a closer.
 */
function parseVerdict(text, { id, facts } = {}) {
  const v = firstJsonObject(text);
  if (v === null) return { ok: false, error: 'no JSON object in reply' };
  if (v instanceof Error) return { ok: false, error: `bad JSON: ${v.message}` };
  if (!VERDICTS.includes(v.verdict)) return { ok: false, error: `unknown verdict ${v.verdict}` };
  if (id && v.id !== id) return { ok: false, error: `reply is for ${v.id}, expected ${id}` };
  if (v.verdict === 'close-candidate' && !v.close_evidence) return { ok: false, error: 'close-candidate without close_evidence' };
  if (facts) {
    // Any card id the reply leans on must be one the FACTS showed: a made-up
    // duplicate_of / blocked_on target is as unsafe as made-up close evidence.
    const known = new Set([...JSON.stringify(facts).matchAll(ID_RE)].map((x) => x[0]));
    for (const field of ['close_evidence', 'duplicate_of', 'blocked_on']) {
      if (!v[field]) continue;
      const cited = [...String(v[field]).matchAll(ID_RE)].map((x) => x[0]).filter((x) => x !== id);
      const bad = cited.filter((x) => !known.has(x));
      if (bad.length) return { ok: false, error: `${field} cites ${bad.join(', ')} which FACTS never showed` };
    }
  }
  if (v.verdict === 'ask-owner' && !/^DECISION NEEDED:/.test(String(v.question || ''))) return { ok: false, error: 'ask-owner without a DECISION NEEDED question' };
  return { ok: true, verdict: v };
}

module.exports = {
  VERDICTS, OVERLAP_MIN, PROMPT_PATH,
  cardText, referencedIds, verifyCommandOf, verifyResultWord, verifyDetail, titleSimilarity, findOverlaps,
  conditionFacts, landingsAfter, lastWorkerComment, buildFacts, renderCard, renderPrompt, parseVerdict,
};
