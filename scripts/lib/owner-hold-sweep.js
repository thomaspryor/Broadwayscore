'use strict';
/**
 * owner-hold-sweep.js — cards that say they need the owner but carry no real
 * question must not sit forever (BRO-6852, owner decision 2026-11-02, option A).
 *
 * Pure planning only; scripts/owner-hold-sweep.js does the I/O. Nothing here
 * re-derives a rule: selection is board-categories.cardTraits (the two board
 * rows "Parked: says it needs you but has no real question" and "Held for you,
 * but no question written"), the owner-only / real-block / risky word lists are
 * the ones headless-dispatchability.js already owns, and "can a worker take it"
 * is asked of the real picker by simulating the release and re-running
 * cardTraits (a released card must come out `ready`, else it is left alone).
 *
 * Outcomes per held card:
 *   release         Claude decides it is worker work: PARKED lines -> UNPARKED,
 *                   an OWNER-CLEARED: comment (the marker commentClearsOwnerGate
 *                   already reads), Backlog/Paused -> Todo.
 *   owner-question  only the owner can supply it (money, login/account, taste,
 *                   irreversible bulk, the Mac) or it was released before and is
 *                   held again. Written only from a question a person or session
 *                   wrote (never a template built from a regex hit); without one
 *                   it is reported as needsQuestion.
 *   leave           a real block (key, date, risky action) or the simulated
 *                   release would still be held (e.g. no safe VERIFY): reported.
 */

const { cardTraits, CATEGORIES } = require('./board-categories.js');
const hd = require('./headless-dispatchability.js');
const { findOwnerDecisions } = require('./owner-decision-notify.js');
const { unparkDescription } = require('./linear-drain-parked.js');

const SWEEP_TAG = 'BRO-6852 owner-hold sweep';
const DEFAULT_RELEASE_CAP = 25;
const DEFAULT_QUESTION_CAP = 5;
// The comment a release writes. It must not quote the hold wording: commentClearsOwnerGate
// re-gates a card whose newest comment re-asserts an owner pattern.
const SWEPT_COMMENT_RE = /OWNER-CLEARED\s*:[^\n]*BRO-6852 owner-hold sweep/i;
const PARK_LINES_RE = /^\s*PARKED\s*:(.*)$/gim;
const ANSWERED_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:ANSWERED by the owner|owner decision(?:\*\*)?\s*\(answered by the owner)/im;
const OWNER_WORDS_RE = /\b(?:owner'?s?|human|manual\w*|by hand)\b/gi;
// A wait on an event or date the park line names ("blocked until the first import has run"): not the owner's, not a worker's yet.
const EVENT_WAIT_RE = /\b(?:blocked|waits?|waiting|held|hold)\b[^.;]{0,40}\b(?:until|on|for)\b|\buntil\b/i;
const HOLD_TRAITS = ['parked-owner-wording', 'owner-gated-no-question'];

const commentBodies = (issue) => ((issue && issue.comments && issue.comments.nodes) || []).filter(Boolean)
  .slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));

function parkReasons(description) {
  return [...String(description || '').matchAll(PARK_LINES_RE)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * PURE. Cards whose board row (first match, as board-report counts them) is one of the
 * two hold rows. Selecting by row, not by trait, keeps machine alerts, real blocks, paused
 * cards and cards someone is working out of the sweep: they belong to other rows.
 */
function selectHolds(issues, { now = new Date(), secret = null } = {}) {
  const nowMs = now.getTime();
  const out = [];
  for (const issue of issues || []) {
    if (!issue || !issue.identifier) continue;
    let res;
    try { res = cardTraits(issue, { nowMs, secret }); } catch { continue; }
    const row = CATEGORIES.find((c) => res.traits.has(c.key));
    if (row && HOLD_TRAITS.includes(row.key)) out.push({ issue, reason: res.reason, row: row.key });
  }
  return out;
}

/** The issue as it would look after a release (what the picker will see). */
function releasedView(issue, now = new Date()) {
  const comment = releaseComment(now);
  return {
    ...issue,
    description: unparkDescription(issue.description, `${SWEEP_TAG} ${now.toISOString().slice(0, 10)}`),
    state: issue.state && issue.state.type === 'backlog' ? { name: 'Todo', type: 'unstarted' } : issue.state,
    comments: { nodes: [...commentBodies(issue), { body: comment, createdAt: now.toISOString() }] },
  };
}

function releaseComment(now = new Date()) {
  return `OWNER-CLEARED: Claude decided this is work a worker can do (${SWEEP_TAG} ${now.toISOString().slice(0, 10)}, scripts/owner-hold-sweep.js). `
    + 'Nothing here needs a login, money or a taste call, so it moves to Todo; if a real choice turns up while working it, write a plain DECISION NEEDED question on the card.';
}

/**
 * PURE. What to do with one held card -> { action: 'release'|'owner-question'|'leave', why }.
 */
function classifyHold(issue, { now = new Date(), secret = null } = {}) {
  const reasons = parkReasons(issue.description).map((r) => hd.neutralizeParkReason ? hd.neutralizeParkReason(r, now) : r);
  const text = reasons.join(' ; ');
  // Released before and held again: a person or session put the hold back on purpose.
  if (commentBodies(issue).some((c) => SWEPT_COMMENT_RE.test(String(c.body || '')))) {
    return { action: 'owner-question', why: 're-held-after-release' };
  }
  // An owner answer on the card ends the wait the park line names (the answer path writes these lines).
  const answered = ANSWERED_RE.test(String(issue.description || '')) || commentBodies(issue).some((c) => ANSWERED_RE.test(String(c.body || '')));
  if (text && !answered) {
    if (hd.isAutomationParked(`PARKED: ${text}`)) return { action: 'leave', why: 'machine-park' };
    const owner = text.match(hd.OWNER_ONLY_PARK_RE);
    if (owner) return { action: 'owner-question', why: `owner-only: "${owner[0]}"` };
    // RISKY_ACTION_PARK_RE also lists the owner-wording words this sweep exists to clear; take those out first.
    const real = text.match(hd.REAL_BLOCK_PARK_RE) || text.match(EVENT_WAIT_RE) || text.replace(OWNER_WORDS_RE, ' ').match(hd.RISKY_ACTION_PARK_RE);
    if (real) return { action: 'leave', why: `real-block: "${real[0]}"` };
  }
  // The real picker decides whether a worker could take it once released.
  const view = releasedView(issue, now);
  const after = cardTraits(view, { nowMs: now.getTime(), secret });
  if (after.traits.has('ready')) return { action: 'release', why: text ? 'park reason names no owner-only need' : 'gate came from stale wording' };
  return { action: 'leave', why: `still-held-after-release: ${after.reason}` };
}

const PRIORITY_RANK = (p) => (Number.isInteger(p) && p > 0 ? p : 5);
const num = (id) => Number(String(id).replace(/\D+/g, '')) || 0;

/** A question text is acceptable only if the owner emailer would read it as one. */
function validQuestion(identifier, text) {
  const t = String(text || '').trim();
  return /^DECISION NEEDED:/m.test(t) && findOwnerDecisions([{ identifier, description: t }]).length === 1;
}

/**
 * PURE. The whole plan. `questions` maps BRO-N -> a full "DECISION NEEDED: ..." block
 * someone wrote for that card. Releases are capped (highest priority first, then oldest);
 * owner questions are capped per run (the run is daily).
 */
function planSweep(issues, { now = new Date(), secret = null, releaseCap = DEFAULT_RELEASE_CAP, questionCap = DEFAULT_QUESTION_CAP, questions = {} } = {}) {
  const held = selectHolds(issues, { now, secret })
    .map(({ issue, reason }) => ({ issue, reason, ...classifyHold(issue, { now, secret }) }))
    .sort((a, b) => PRIORITY_RANK(a.issue.priority) - PRIORITY_RANK(b.issue.priority) || num(a.issue.identifier) - num(b.issue.identifier));
  const plan = { releases: [], questions: [], needsQuestion: [], leave: [], deferred: [], held: held.length };
  for (const h of held) {
    const id = h.issue.identifier;
    const row = { identifier: id, title: h.issue.title, priority: h.issue.priority, state: h.issue.state && h.issue.state.name, why: h.why };
    const q = questions[id];
    // A question someone wrote by hand for this card wins over the classifier: the writer read the card.
    if (q && h.action !== 'owner-question') {
      if (!validQuestion(id, q)) plan.needsQuestion.push({ ...row, why: `${row.why}; supplied question is not a valid DECISION NEEDED block` });
      else if (plan.questions.length >= questionCap) plan.deferred.push({ ...row, why: 'question-cap' });
      else plan.questions.push({ ...row, why: 'question supplied', question: String(q).trim() });
    } else if (h.action === 'release') {
      if (plan.releases.length >= releaseCap) plan.deferred.push({ ...row, why: 'release-cap' });
      else plan.releases.push(row);
    } else if (h.action === 'owner-question') {
      if (!q) plan.needsQuestion.push(row);
      else if (!validQuestion(id, q)) plan.needsQuestion.push({ ...row, why: `${row.why}; supplied question is not a valid DECISION NEEDED block` });
      else if (plan.questions.length >= questionCap) plan.deferred.push({ ...row, why: 'question-cap' });
      else plan.questions.push({ ...row, question: String(q).trim() });
    } else plan.leave.push(row);
  }
  return plan;
}

/** Description with the question appended (and the old gate wording left as is). */
function withQuestion(description, question) {
  return `${String(description || '').trimEnd()}\n\n${String(question).trim()}\n`;
}

module.exports = {
  SWEEP_TAG, DEFAULT_RELEASE_CAP, DEFAULT_QUESTION_CAP, SWEPT_COMMENT_RE,
  selectHolds, classifyHold, planSweep, releasedView, releaseComment, validQuestion, withQuestion,
};
