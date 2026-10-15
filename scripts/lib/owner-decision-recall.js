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

const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');

const STOPWORDS = new Set(('a an and are as at be by for from has have how in is it its of on or so that the this to was we when ' +
  'with not no new add fix card cards owner user users page show shows sign get gets got can will should must into out up decision decisions owner option paused waiting need needs tap press todo done close closed after first ready board triage plan').split(/\s+/));
const ANSWER_RE = /\b(owner (answer(ed)?|decision|decided|declined|chose|said|picked)|decision:|answered:|option [a-d]\b|keep (the )?current)/i;
const MIN_SHARED = 2;

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

// The text of the answer, and when it was given, or null when the closed card
// holds no owner answer (a card closed as obsolete is not an answer).
function answerOf(card) {
  if (!card || !isTerminal(card)) return null;
  const hit = commentBodies(card).find((c) => ANSWER_RE.test(c.body));
  const when = (hit && hit.createdAt) || card.canceledAt || card.completedAt || card.updatedAt || null;
  let text = hit ? hit.body : null;
  if (!text && card.state.type === 'canceled' && ANSWER_RE.test(String(card.description || ''))) text = card.description;
  if (!text) return null;
  return { text: text.replace(/\s+/g, ' ').trim().slice(0, 240), date: when ? String(when).slice(0, 10) : null };
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
    const answer = answerOf(card);
    if (!answer) continue;
    const have = cardTokens(card);
    const shared = [...want].filter((t) => have.has(t)).length;
    if (shared >= need) found.push({ identifier: card.identifier, title: card.title, url: card.url || null, ...answer, shared });
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
      comments(first: 20) { nodes { body createdAt } } }
  }
}`;

// Newest closed cards that carry an owner answer. maxPages bounds the read.
async function fetchAnsweredCards({ maxPages = 30, linear = require('./linear-client') } = {}) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await linear.graphql(CLOSED_QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes.filter((c) => answerOf(c)));
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return out;
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

module.exports = { tokens, answerOf, findPriorAnswers, splitAnswered, fetchAnsweredCards, CLOSED_QUERY };
