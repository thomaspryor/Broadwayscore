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
const { OWNER_ANSWERED_COMMENT_RE } = require('./headless-dispatchability.js');

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

const BOT_COMMENT_RE = /^(\*\*)?(Board dispatch|Recheck|Autonomous recheck|Stuck-card closer|Auto-closed|Recovered|DISPATCHED|board-closer)\b|Generated by the nightly/i;

/** True when a comment is a board machine stamp, not a worker or a person. */
function isBotComment(body) { return BOT_COMMENT_RE.test(String(body || '').trim()) || AUTO_MOVE_RE.test(String(body || '').trim()); }

/** Newest comment that is not one of the board's machine stamps (the audit shares isBotComment). */
function lastWorkerComment(issue, nowMs) {
  const comments = sortedComments(issue).slice().reverse();
  const c = comments.find((x) => !isBotComment(x.body));
  if (!c) return 'none';
  const snippet = String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${ageText(nowMs - Date.parse(c.createdAt))}: "${snippet}"`;
}

// Comment wording the board's automatic sweepers leave when they move a card. A reopen whose
// nearby comment matches is a machine's move, not a person or a failing check (BRO-7139: a
// worker closed BRO-5957 Done with a full close-out; reconcile-dead-completions reopened it
// and the triage model read the reopen as "not finished").
// Anchored at the comment's start only: a person writing "the hourly sweep still flags it" in a
// reopen is a person, not a sweeper. reconcile-dead-completions posts "Auto-corrected ... by
// reconcile-dead-completions", so the prefix list covers it.
const AUTO_MOVE_RE = /^(\*\*)?(Auto-corrected|RECLAIMED-ABANDONED|Auto-reopened|Board dispatch|Stuck-card closer|Autonomous recheck)\b/i;
const CLOSED_TYPES = new Set(['completed', 'canceled']);

/**
 * PURE. Closes and reopens from Linear's issue history, each with the comment written within
 * 5 minutes of the move, so the model can tell a worker's close-out from a sweeper's reopen.
 * Every session writes through the same Linear key, so the actor field cannot tell them apart.
 */
function stateHistoryFacts(issue) {
  const moves = ((issue && issue.history && issue.history.nodes) || [])
    .filter((h) => h && h.toState && h.fromState)
    .filter((h) => CLOSED_TYPES.has(h.toState.type) !== CLOSED_TYPES.has(h.fromState.type))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!moves.length) return 'never closed';
  const comments = sortedComments(issue);
  const near = (at) => {
    const t = Date.parse(at);
    const c = comments.filter((x) => Math.abs(Date.parse(x.createdAt) - t) <= 5 * 60e3)
      .sort((a, b) => Math.abs(Date.parse(a.createdAt) - t) - Math.abs(Date.parse(b.createdAt) - t))[0];
    return c ? String(c.body || '').replace(/\s+/g, ' ').trim() : '';
  };
  return moves.slice(-4).map((h) => {
    const when = String(h.createdAt).slice(0, 16).replace('T', ' ');
    const body = near(h.createdAt);
    if (CLOSED_TYPES.has(h.toState.type)) return `${when} closed ${h.toState.name}${body ? ` (comment: "${body.slice(0, 120)}")` : ' (no comment)'}`;
    const who = !body ? 'by an unknown mover (no comment)' : (AUTO_MOVE_RE.test(body) ? 'by an AUTOMATIC SWEEPER' : 'by a person or worker');
    return `${when} reopened to ${h.toState.name} ${who}${body ? ` (comment: "${body.slice(0, 120)}")` : ''}`;
  }).join('; ');
}

const WORKFLOW_FILE_RE = /\b([a-z0-9][a-z0-9._-]*\.ya?ml)\b/gi;

/** PURE. Workflow files the card's VERIFY or text names (max 3), VERIFY's --workflow first. */
function workflowFilesOf(issue, verify) {
  const out = [];
  const add = (f) => { if (f && !out.includes(f) && out.length < 3) out.push(f); };
  const m = String((verify && verify.cmd) || '').match(/--workflow[= ]([\w.-]+\.ya?ml)/);
  if (m) add(m[1]);
  for (const x of `${issue.title || ''}\n${cardText(issue)}`.matchAll(WORKFLOW_FILE_RE)) {
    if (!/^(docker-compose|action|config|codecov|dependabot|pnpm-lock)\b/i.test(x[1])) add(x[1]);
  }
  return out;
}

/**
 * PURE. runsByFile: Map file -> [{conclusion, created_at}] newest first (completed runs only),
 * or null when the lookup failed. sinceIso: newest landing naming the card (or null).
 * One newest run is a coin flip on a busy workflow; the model gets the whole recent record.
 */
function workflowRunFacts(runsByFile, sinceIso) {
  if (!runsByFile || !runsByFile.size) return 'none named';
  const since = Date.parse(sinceIso || '') || null;
  const parts = [];
  for (const [file, runs] of runsByFile) {
    if (!runs) { parts.push(`${file}: unknown (run lookup failed)`); continue; }
    if (!runs.length) { parts.push(`${file}: no completed runs found`); continue; }
    const tally = (rs) => {
      const t = {};
      for (const r of rs) t[r.conclusion || 'unknown'] = (t[r.conclusion || 'unknown'] || 0) + 1;
      return Object.entries(t).map(([k, v]) => `${v} ${k}`).join(', ');
    };
    let s = `${file}: last ${runs.length} completed runs ${tally(runs)} (newest ${String(runs[0].created_at).slice(0, 10)}, oldest ${String(runs[runs.length - 1].created_at).slice(0, 10)})`;
    if (since) {
      const after = runs.filter((r) => Date.parse(r.created_at) >= since);
      s += after.length ? `; since the newest landing naming this card: ${tally(after)}` : '; no completed runs since the newest landing naming this card';
    }
    parts.push(s);
  }
  return parts.join('; ');
}

/**
 * The owner's newest recorded answer on this card (the answer path's "**Owner decision**
 * (answered by the owner ...)" comment), so the model never asks the same question again.
 * BRO-7139 round 2: BRO-6810 was answered "Approved" and the model re-asked it.
 */
// Trust note: the owner-decision comment is matched by its text, not verified by its answer-link
// HMAC, so anyone with write access to the Linear workspace could forge one. Accepted because
// the workspace is private and a forged answer can only change a report-only nomination, which
// the weekly audit re-checks against reality; nothing closes or releases a card from this fact.
function ownerAnswerFacts(issue) {
  const answers = sortedComments(issue).filter((c) => OWNER_ANSWERED_COMMENT_RE.test(String(c.body || '')));
  if (!answers.length) return 'none';
  const last = answers[answers.length - 1];
  const chose = (String(last.body).match(/^[ \t]*Chose:[ \t]*(.+)$/im) || [])[1];
  const stillAsking = /^[ \t]*(?:[-*>][ \t]+)?\**DECISION NEEDED\**[ \t]*:/im.test(String(issue.description || ''));
  return `the owner answered on ${String(last.createdAt).slice(0, 10)}: "${String(chose || 'answer not recorded').trim().slice(0, 120)}"`
    + (stillAsking ? '; another DECISION NEEDED is still open in the description' : '; no question is left open');
}

/**
 * Everything the prompt's FACTS block needs, as display strings.
 * refStates: Map id -> {state, title} for referencedIds (missing = unknown).
 */
function buildFacts({ issue, category, verify, verifyResult, commits, refStates, overlaps, condition, nowMs, workflowRuns = null }) {
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
    STATE_HISTORY: stateHistoryFacts(issue),
    OWNER_ANSWER: ownerAnswerFacts(issue),
    WORKFLOW_RUNS: workflowRunFacts(workflowRuns, lands.length ? lands[0].date : null),
  };
}

const CARD_BUDGET = 30000;
const DESCRIPTION_BUDGET = 8000;

/**
 * The card as the model sees it: title, state, description, every comment with its date.
 * Over CARD_BUDGET it keeps the description head and the NEWEST comments and drops the
 * oldest ones with a marker. Cutting the tail instead lost the latest comments, which the
 * prompt says override everything older (BRO-7139: BRO-5500 ended mid-comment).
 */
function renderCard(issue, budget = CARD_BUDGET) {
  const comments = sortedComments(issue);
  const head = [
    `# ${issue.identifier}: ${issue.title}`,
    `state: ${(issue.state && issue.state.name) || '?'}  priority: ${issue.priority ?? '?'}  created: ${String(issue.createdAt || '').slice(0, 10)}`,
    '',
  ].join('\n');
  const parts = comments.map((c) => `\n--- comment ${String(c.createdAt || '').slice(0, 16)} ---\n${String(c.body || '')}`);
  let desc = String(issue.description || '');
  const full = [head, desc, ...parts].join('\n');
  if (full.length <= budget) return full;
  if (desc.length > DESCRIPTION_BUDGET) desc = `${desc.slice(0, DESCRIPTION_BUDGET)}\n[description cut]`;
  let room = budget - head.length - desc.length - 100;
  const kept = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    let p = parts[i];
    if (p.length > room) {
      if (kept.length) break;
      p = `${p.slice(0, Math.max(0, room - 20))}\n[comment cut]`; // the newest comment alone is over budget
    }
    kept.unshift(p);
    room -= p.length + 1;
  }
  const dropped = parts.length - kept.length;
  return [head, desc, ...(dropped ? [`\n[${dropped} older comment(s) omitted for length]`] : []), ...kept].join('\n');
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
  conditionFacts, landingsAfter, lastWorkerComment, isBotComment, buildFacts, renderCard, renderPrompt, parseVerdict,
  stateHistoryFacts,
  ownerAnswerFacts, workflowFilesOf, workflowRunFacts, CARD_BUDGET, AUTO_MOVE_RE,
};
