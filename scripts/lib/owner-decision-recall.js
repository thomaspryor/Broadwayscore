'use strict';
/**
 * owner-decision-recall.js (BRO-5385): find earlier owner answers before the
 * owner is asked anything. The owner was re-asked the email pop-up question
 * (answered 2026-10-11, BRO-3624) and the sign-in sheet question (2026-10-04,
 * BRO-4616) because filers and question lists never looked at closed cards.
 *
 * A prior answer is a closed card (canceled, completed, duplicate) whose
 * description or comments carry an owner answer, matched to a topic by shared
 * keywords. Matching is pure; fetchAnsweredCards() is the only Linear read.
 *
 *   node scripts/lib/owner-decision-recall.js "email pop-up"
 */

const fs = require('fs');
const path = require('path');
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');

const STOPWORDS = new Set(('a an and are as at be by for from has have how in is it its of on or so that the this to was we when ' +
  'with not no new add fix card cards owner user users page show shows sign get gets got can will should must into out up decision decisions owner option paused waiting need needs tap press todo done close closed rage click clicks funnel drop conversion low after first ready board triage plan').split(/\s+/));
const ANSWER_RE = /\bowner (answered|declined|picked|chose)\b|\bowner decision (on the decisions page|\(?\d{4}-)/i;
const QUESTION_RE = /DECISION NEEDED/;
const MIN_SHARED = 2;
const CACHE_FILE = path.resolve(__dirname, '../../.cache/owner-decision-recall.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().replace(/pop-?up/g, 'popup').replace(/e-mail/g, 'email').split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}

function isTerminal(card) {
  const t = card && card.state && card.state.type;
  return TERMINAL_STATE_TYPES.includes(t);
}

function commentBodies(card) {
  const c = card.comments;
  const nodes = Array.isArray(c) ? c : (c && c.nodes) || [];
  return nodes.map((n) => ({ body: String(n.body || ''), createdAt: n.createdAt || null }));
}

function isAnswerComment(comment) {
  return ANSWER_RE.test(comment.body) && !QUESTION_RE.test(comment.body);
}

function summarizeAnswer(card, comment) {
  const when = comment.createdAt || card.canceledAt || card.completedAt || card.updatedAt || null;
  return { text: comment.body.replace(/\s+/g, ' ').trim().slice(0, 240), date: when ? String(when).slice(0, 10) : null };
}

// The text of the answer, and when it was given, or null when the closed card
// holds no owner answer (a card closed as obsolete is not an answer).
function answerOf(card) {
  if (!card || !isTerminal(card)) return null;
  const hit = commentBodies(card).find(isAnswerComment);
  if (hit) return summarizeAnswer(card, hit);
  const description = { body: String(card.description || '') };
  if (card.state.type === 'canceled' && isAnswerComment(description)) return summarizeAnswer(card, description);
  return null;
}

function cardTokens(card) {
  return tokens(`${card.title || ''} ${String(card.description || '').slice(0, 400)}`);
}

// topic: a string (title, keywords) or an array of keywords.
function findPriorAnswers(topic, cards, { minShared = MIN_SHARED } = {}) {
  const want = tokens(Array.isArray(topic) ? topic.join(' ') : topic);
  if (want.size === 0) return [];
  const need = Math.min(Math.max(minShared, Math.ceil(want.size * 0.34)), 4, want.size);
  const found = [];
  for (const card of cards || []) {
    let answer = answerOf(card);
    if (!answer) continue;
    const sharedWith = (have) => [...want].filter((t) => have.has(t)).length;
    let shared = sharedWith(cardTokens(card));
    // Never pool a long thread's words: only a single comment carrying the
    // strict owner-answer marker can independently establish another topic.
    for (const comment of commentBodies(card).filter(isAnswerComment)) {
      const commentShared = sharedWith(tokens(comment.body));
      if (commentShared > shared) {
        shared = commentShared;
        answer = summarizeAnswer(card, comment);
      }
    }
    if (shared >= need) found.push({ stateType: card.state.type, identifier: card.identifier, title: card.title, url: card.url || null, ...answer, shared });
  }
  return found.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.shared - a.shared);
}

// Items to file (objects with a title) minus those already answered.
function splitAnswered(items, cards, titleOf = (i) => i.title) {
  const fresh = [];
  const answered = [];
  for (const item of items || []) {
    const prior = findPriorAnswers(titleOf(item), cards);
    if (prior.length) answered.push({ item, prior }); else fresh.push(item);
  }
  return { fresh, answered };
}

const CLOSED_QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, includeArchived: true, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { in: ${JSON.stringify(TERMINAL_STATE_TYPES)} } },
    updatedAt: { gt: "-P45D" },
    comments: { some: { body: { containsIgnoreCase: "owner" } } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title description url updatedAt canceledAt completedAt state { type }
      comments(first: 30, orderBy: createdAt) { pageInfo { hasNextPage endCursor } nodes { body createdAt } } }
  }
}`;

const COMMENTS_QUERY = `query($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 50, after: $after, orderBy: createdAt) {
      pageInfo { hasNextPage endCursor }
      nodes { body createdAt }
    }
  }
}`;

// Cache only complete reads. A page cap, timeout or API failure must not hide
// answers for a whole day. The cache is local, ignored, and best effort.
async function fetchAnsweredCards({ maxPages = 30, linear = require('./linear-client'), cacheFile = CACHE_FILE,
  now = Date.now, timeoutMs = Infinity } = {}) {
  const startedAt = now();
  if (cacheFile) {
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const age = startedAt - cache.fetchedAt;
      if (cache.version === CACHE_VERSION && cache.teamKey === linear.TEAM_KEY && age >= 0 && age < CACHE_TTL_MS && Array.isArray(cache.cards)) {
        return cache.cards.filter((card) => answerOf(card));
      }
    } catch { /* Missing or corrupt cache: read Linear. */ }
  }
  const read = (query, variables) => {
    if (!Number.isFinite(timeoutMs)) return linear.graphql(query, variables);
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) throw new Error('owner-answer lookup timed out');
    // Bound the request itself too: a Promise.race alone leaves network I/O
    // and retries alive after the advisory has returned to its caller.
    return linear.graphql(query, variables, { timeoutMs: remaining, maxAttempts: 1 });
  };
  const out = [];
  let after = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const data = await read(CLOSED_QUERY, { teamKey: linear.TEAM_KEY, after });
    for (const card of data.issues.nodes) {
      let comments = card.comments;
      const nodes = [...(comments?.nodes || [])];
      const seen = new Set();
      while (comments?.pageInfo?.hasNextPage) {
        const cursor = comments.pageInfo.endCursor;
        if (!cursor || seen.has(cursor)) throw new Error('Incomplete owner-answer comment pagination');
        seen.add(cursor);
        const next = await read(COMMENTS_QUERY, { id: card.id, after: cursor });
        comments = next.issue?.comments;
        if (!comments) throw new Error('Owner-answer issue disappeared while reading comments');
        nodes.push(...comments.nodes);
      }
      const fullCard = { ...card, comments: { nodes } };
      if (answerOf(fullCard)) out.push(fullCard);
    }
    if (!data.issues.pageInfo.hasNextPage) { complete = true; break; }
    after = data.issues.pageInfo.endCursor;
    if (!after) throw new Error('Incomplete owner-answer issue pagination');
  }
  if (complete && cacheFile) {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, teamKey: linear.TEAM_KEY, fetchedAt: startedAt, cards: out }), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch { /* A read-only checkout must still be able to file cards. */ }
    finally { try { fs.unlinkSync(tmp); } catch { /* Already renamed or not written. */ } }
  }
  return out;
}

// Advisory only. Creation has already succeeded; a cold cache or broken Linear
// read cannot invalidate that result or outlive automated filers' 60s budget.
async function warnPriorAnswers(topic, { fetchCards = fetchAnsweredCards, timeoutMs = 8000, warn = console.error } = {}) {
  let timer;
  try {
    const cards = await Promise.race([
      Promise.resolve().then(() => fetchCards({ timeoutMs })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`lookup timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    for (const prior of findPriorAnswers(topic, cards).slice(0, 3)) {
      warn(`[linear-brain] prior owner answer: ${prior.identifier} (${prior.date || 'undated'}) ${prior.url || ''}\n  ${prior.text}`);
    }
  } catch (err) {
    warn(`[linear-brain] owner-answer recall skipped (issue was still created): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv = process.argv.slice(2)) {
  const topic = argv.join(' ').trim();
  if (!topic) { console.error('Usage: node scripts/lib/owner-decision-recall.js "<topic keywords>"'); return 2; }
  const found = findPriorAnswers(topic, await fetchAnsweredCards());
  if (!found.length) console.log('No earlier owner answer found.');
  for (const f of found) console.log(`${f.identifier} (${f.date || 'undated'}) ${f.title}\n  ${f.text}`);
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 3; });
}

module.exports = { tokens, answerOf, findPriorAnswers, splitAnswered, fetchAnsweredCards, warnPriorAnswers, CLOSED_QUERY };
