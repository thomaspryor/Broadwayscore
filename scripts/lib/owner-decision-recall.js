'use strict';
/**
 * owner-decision-recall.js (BRO-5385): find earlier owner answers before the
 * owner is asked anything. The owner was re-asked the email pop-up question
 * (answered 2026-10-11, BRO-3624) and the sign-in sheet question (2026-10-04,
 * BRO-4616) because filers and question lists never looked at closed cards.
 *
 * A prior answer is a closed card (canceled, completed, duplicate) whose
 * description or comments carry an owner answer, matched to a topic by shared
 * keywords. Matching is pure; readAnsweredCards() is the only Linear read.
 *
 *   node scripts/lib/owner-decision-recall.js "email pop-up"
 *   node scripts/lib/owner-decision-recall.js --warm   # refresh the day cache
 */

const fs = require('fs');
const path = require('path');
const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');
const { withTimeout } = require('./with-timeout.js');

const STOPWORDS = new Set(('a an and are as at be by for from has have how in is it its of on or so that the this to was we when ' +
  'with not no new add fix card cards owner user users page show shows sign get gets got can will should must into out up decision decisions owner option paused waiting need needs tap press todo done close closed rage click clicks funnel drop conversion low after first ready board triage plan').split(/\s+/));
// Strict on purpose (BRO-5390 review: loose markers were rejected). Every
// string ANSWER_RE accepts contains one of MARKER_PHRASES (case-insensitive),
// which is what lets the Linear query filter on them server side; the test
// file holds that invariant.
const ANSWER_RE = /\bowner (answered|declined|picked|chose)\b|\bowner decision (on the decisions page|\(?\d{4}-)/i;
const MARKER_PHRASES = ['owner answered', 'owner declined', 'owner picked', 'owner chose',
  'owner decision on the decisions page', 'owner decision (', 'owner decision 1', 'owner decision 2'];
const QUESTION_RE = /DECISION NEEDED/;
// A card about this recall feature quotes the markers and both topics; it is
// never itself the owner's answer to them (live false positive: BRO-5385).
const SELF_REFERENCE_RE = /owner-decision-recall/;
const FOLLOW_UP_CHARS = 600;
const MIN_SHARED = 2;
const CACHE_FILE = path.resolve(__dirname, '../../.cache/owner-decision-recall.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;
const WARM_LOCK_STALE_MS = 10 * 60 * 1000;

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

// Oldest first. Linear returns `orderBy: createdAt` newest first; fixtures may
// omit dates, in which case the given order is kept.
function commentBodies(card) {
  const c = card.comments;
  const nodes = (Array.isArray(c) ? c : (c && c.nodes) || [])
    .map((n) => ({ body: String(n.body || ''), createdAt: n.createdAt || null }));
  if (nodes.every((n) => n.createdAt)) nodes.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return nodes;
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
  // The latest answer: an owner who changed their mind is quoted as of now.
  const hit = commentBodies(card).filter(isAnswerComment).at(-1);
  if (hit) return summarizeAnswer(card, hit);
  const description = { body: String(card.description || '') };
  if (card.state.type === 'canceled' && isAnswerComment(description)) return summarizeAnswer(card, description);
  return null;
}

function cardTokens(card) {
  return tokens(`${card.title || ''} ${String(card.description || '').slice(0, 400)}`);
}

// Title, description and the answer comments only: a session Outcome that
// lists this file under Key Files does not disqualify a real answer.
function isSelfReference(card) {
  return SELF_REFERENCE_RE.test(`${card.title || ''} ${card.description || ''}`)
    || commentBodies(card).some((c) => isAnswerComment(c) && SELF_REFERENCE_RE.test(c.body));
}

// Each owner answer, with the text that may establish its topic: the answer
// comment itself, plus the ONE comment right after it, cut short. An answer
// often names only the option ("Owner picked Option A"), and the session's
// next comment says what that option was (BRO-4616: "the sign-in sheet opens
// right after the first save"). Comments before the answer are the options
// discussion, rejected options included, so they never count. Comments are
// never pooled: each piece is matched on its own. Known residue: a follow-up
// that re-lists the rejected options can still match them; the 600-character
// cut limits that, and the result is only ever a warning.
function answerEvidence(card) {
  const comments = commentBodies(card);
  const out = [];
  comments.forEach((comment, i) => {
    if (!isAnswerComment(comment)) return;
    const pieces = [{ text: comment.body, followUp: false }];
    const next = comments[i + 1];
    if (next && !isAnswerComment(next) && !QUESTION_RE.test(next.body)) pieces.push({ text: next.body.slice(0, FOLLOW_UP_CHARS), followUp: true });
    out.push({ comment, pieces });
  });
  return out;
}

// topic: a string (title, keywords) or an array of keywords.
function findPriorAnswers(topic, cards, { minShared = MIN_SHARED } = {}) {
  const want = tokens(Array.isArray(topic) ? topic.join(' ') : topic);
  if (want.size === 0) return [];
  const need = Math.min(Math.max(minShared, Math.ceil(want.size * 0.34)), 4, want.size);
  const sharedWith = (text) => { const have = tokens(text); return [...want].filter((t) => have.has(t)).length; };
  const found = [];
  for (const card of cards || []) {
    let answer = answerOf(card);
    if (!answer || isSelfReference(card)) continue;
    let shared = [...want].filter((t) => cardTokens(card).has(t)).length;
    for (const { comment, pieces } of answerEvidence(card)) {
      // A follow-up is weaker evidence (an Outcome comment shares generic words
      // with many topics): it needs 3 shared tokens (or all of a shorter topic).
      const pieceShared = Math.max(...pieces.map((pc) => {
        const n = sharedWith(pc.text);
        return pc.followUp && n < Math.max(need, Math.min(want.size, 3)) ? 0 : n;
      }));
      if (pieceShared > shared) {
        shared = pieceShared;
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

// Only cards whose comments (or, canceled, description) contain a marker
// phrase: about 110 cards in 3 pages instead of every closed card that mentions
// "owner" (~1,800 cards, 36 pages, 89s measured 2026-10-19).
const anyPhrase = (field) => MARKER_PHRASES.map((p) => `{ ${field}: { containsIgnoreCase: ${JSON.stringify(p)} } }`).join(', ');
const CLOSED_QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, includeArchived: true, filter: { and: [
    { team: { key: { eq: $teamKey } } },
    { state: { type: { in: ${JSON.stringify(TERMINAL_STATE_TYPES)} } } },
    { updatedAt: { gt: "-P45D" } },
    { or: [
      { comments: { some: { or: [${anyPhrase('body')}] } } },
      { and: [{ state: { type: { eq: "canceled" } } }, { or: [${anyPhrase('description')}] }] }
    ] }
  ] }) {
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

// The cached answer list, or null when there is no fresh cache for this team.
function readCache({ cacheFile = CACHE_FILE, teamKey, now = Date.now } = {}) {
  if (!cacheFile) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age = now() - cache.fetchedAt;
    if (cache.version === CACHE_VERSION && cache.teamKey === teamKey && age >= 0 && age < CACHE_TTL_MS && Array.isArray(cache.cards)) {
      return cache.cards.filter((card) => answerOf(card));
    }
  } catch { /* Missing or corrupt cache: read Linear. */ }
  return null;
}

function writeCache(cacheFile, teamKey, fetchedAt, cards) {
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, teamKey, fetchedAt, cards }), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch { /* A read-only checkout must still be able to file cards. */ }
  finally { try { fs.unlinkSync(tmp); } catch { /* Already renamed or not written. */ } }
}

// { cards, complete, fromCache, error }. Never throws: a failure, an
// exhausted budget or the maxPages cap returns the answers read so far
// (newest-updated first) with complete=false. Only complete reads are cached, so a page cap, timeout
// or API failure cannot hide answers for a whole day.
async function readAnsweredCards({ maxPages = 30, linear = require('./linear-client'), cacheFile = CACHE_FILE,
  now = Date.now, timeoutMs = Infinity } = {}) {
  const startedAt = now();
  const cached = readCache({ cacheFile, teamKey: linear.TEAM_KEY, now: () => startedAt });
  if (cached) return { cards: cached, complete: true, fromCache: true, error: null };
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
  try {
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
  } catch (error) {
    return { cards: out, complete: false, fromCache: false, error };
  }
  if (complete && cacheFile) writeCache(cacheFile, linear.TEAM_KEY, startedAt, out);
  return { cards: out, complete, fromCache: false, error: null };
}

// Throwing form for the friction analyzer and the decisions email: any read
// failure throws; a maxPages cap returns the pages read (never cached).
async function fetchAnsweredCards(opts = {}) {
  const { cards, error } = await readAnsweredCards(opts);
  if (error) throw error;
  return cards;
}

// Start a detached full read that fills the day cache, so the next create on
// this checkout gets every answer. One warmer at a time (lock file, stale
// after 10 min). Never in CI: the cache dies with the runner. Returns the pid
// or null; any failure is silent.
function startCacheWarmer({ cacheFile = CACHE_FILE, spawnFn = null, now = Date.now, env = process.env } = {}) {
  if (env.CI) return null;
  const lock = `${cacheFile}.warming`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    try {
      fs.writeFileSync(lock, String(now()), { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST' || now() - fs.statSync(lock).mtimeMs < WARM_LOCK_STALE_MS) return null;
      // Stale: remove and race for it again with wx, so only one taker wins.
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(now()), { flag: 'wx' });
    }
    const release = () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } };
    const { spawn } = require('child_process');
    let child;
    try {
      child = (spawnFn || spawn)(process.execPath, [__filename, '--warm', cacheFile], { detached: true, stdio: 'ignore' });
    } catch { release(); return null; }
    // A spawn failure (EAGAIN, ENOENT) arrives as an 'error' event; unhandled,
    // it would crash linear-brain create after the card was already filed.
    if (child.on) child.on('error', release);
    if (child.unref) child.unref();
    return child.pid || null;
  } catch { return null; }
}

async function runWarm(cacheFile = CACHE_FILE) {
  try { await readAnsweredCards({ cacheFile }); }
  finally { try { fs.unlinkSync(`${cacheFile}.warming`); } catch { /* already gone */ } }
}

// Advisory only. Creation has already succeeded; a cold cache or broken Linear
// read cannot invalidate that result or outlive automated filers' 60s budget.
// fetchCards is a test seam; the built-in path reads the day cache, and on a
// cold cache starts the warmer and warns from a time-capped partial read.
async function warnPriorAnswers(topic, { fetchCards, timeoutMs = 8000, warn = console.error, env = process.env,
  spawnFn = null, cacheFile = CACHE_FILE, linear } = {}) {
  if (env.LINEAR_BRAIN_SKIP_RECALL === '1') return;
  // Tests never read live Linear (linear-brain.js main()'s deps contract);
  // under `node --test` only an injected fetcher runs.
  if (!fetchCards && env.NODE_TEST_CONTEXT) return;
  try {
    const lookup = fetchCards
      ? Promise.resolve().then(() => fetchCards({ timeoutMs })).then((cards) => ({ cards, complete: true }))
      : Promise.resolve().then(() => {
        const client = linear || require('./linear-client');
        if (!readCache({ cacheFile, teamKey: client.TEAM_KEY })) startCacheWarmer({ cacheFile, spawnFn, env });
        return readAnsweredCards({ linear: client, cacheFile, timeoutMs: Math.max(timeoutMs - 500, 1) });
      });
    const { cards, complete, error } = await withTimeout(lookup, timeoutMs, { message: `timed out after ${timeoutMs}ms` });
    for (const prior of findPriorAnswers(topic, cards).slice(0, 3)) {
      warn(`[linear-brain] prior owner answer: ${prior.identifier} (${prior.date || 'undated'}) ${prior.url || ''}\n  ${prior.text}`);
    }
    if (!complete) {
      warn(`[linear-brain] owner-answer recall was partial (${cards.length} answered cards read; ${error ? error.message : 'page cap reached'}; issue was still created)`);
    }
  } catch (err) {
    warn(`[linear-brain] owner-answer recall skipped (issue was still created): ${err.message}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--warm') { await runWarm(argv[1] || CACHE_FILE); return 0; }
  const topic = argv.join(' ').trim();
  if (!topic) { console.error('Usage: node scripts/lib/owner-decision-recall.js "<topic keywords>" | --warm'); return 2; }
  const found = findPriorAnswers(topic, await fetchAnsweredCards());
  if (!found.length) console.log('No earlier owner answer found.');
  for (const f of found) console.log(`${f.identifier} (${f.date || 'undated'}) ${f.title}\n  ${f.text}`);
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 3; });
}

module.exports = {
  tokens, answerOf, findPriorAnswers, splitAnswered, readAnsweredCards, fetchAnsweredCards, warnPriorAnswers,
  startCacheWarmer, readCache, CLOSED_QUERY, ANSWER_RE, MARKER_PHRASES,
};
