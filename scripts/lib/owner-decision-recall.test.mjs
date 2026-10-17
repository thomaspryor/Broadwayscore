import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { findPriorAnswers, splitAnswered, answerOf, fetchAnsweredCards } = require('./owner-decision-recall.js');

const cards = [
  { identifier: 'BRO-3624', title: 'Email pop-up: keep, change or remove?', state: { type: 'canceled' }, canceledAt: '2026-10-11T09:00:00Z',
    description: 'Owner question about the email signup pop-up.',
    comments: { nodes: [{ body: 'Owner answered: keep the current pop-up.', createdAt: '2026-10-11T09:00:00Z' }] } },
  { identifier: 'BRO-4616', title: 'Account experience follow-up', state: { type: 'canceled' },
    comments: { nodes: [
      { body: 'Investigate broken outlet logos and the sticky header.' },
      { body: 'Owner picked Option A: show the sign-in sheet after the first save.', createdAt: '2026-10-04T10:00:00Z' },
    ] } },
  { identifier: 'BRO-100', title: 'Email pop-up copy typo', state: { type: 'completed' }, comments: { nodes: [{ body: 'fixed', createdAt: '2026-09-01T00:00:00Z' }] } },
  { identifier: 'BRO-200', title: 'Email pop-up still open', state: { type: 'started' }, comments: { nodes: [{ body: 'Owner answered: yes', createdAt: '2026-10-01T00:00:00Z' }] } },
];

test('email pop-up topic resolves to the BRO-3624 answer of 2026-10-11', () => {
  const found = findPriorAnswers('Email pop-up friction: users dismiss the signup popup', cards);
  assert.equal(found.length, 1);
  assert.equal(found[0].identifier, 'BRO-3624');
  assert.equal(found[0].date, '2026-10-11');
  assert.match(found[0].text, /keep the current pop-up/);
});

test('sign-in sheet topic resolves to BRO-4616', () => {
  assert.equal(findPriorAnswers('sign-in sheet after first save', cards)[0].identifier, 'BRO-4616');
});

test('closed cards without an owner answer, and open cards, are not answers', () => {
  assert.equal(answerOf(cards[2]), null);
  assert.equal(answerOf(cards[3]), null);
});

test('unrelated topic finds nothing', () => {
  assert.deepEqual(findPriorAnswers('Search returns no results for tony awards', cards), []);
});

test('friction analyzer filter files nothing new for an answered topic', () => {
  const issues = [{ title: 'Email popup dismissed quickly on mobile' }, { title: 'Ticket link broken on closed shows' }];
  const { fresh, answered } = splitAnswered(issues, cards);
  assert.deepEqual(fresh.map((i) => i.title), ['Ticket link broken on closed shows']);
  assert.equal(answered[0].prior[0].identifier, 'BRO-3624');
});

test('a question or a rule citation is not an answer', () => {
  const q = { identifier: 'BRO-1', title: 'Rage clicks on homepage badge', state: { type: 'canceled' }, comments: { nodes: [{ body: 'DECISION NEEDED: x\nOption A: keep' }] } };
  const r = { identifier: 'BRO-2', title: 'Rage clicks on homepage badge', state: { type: 'canceled' }, comments: { nodes: [{ body: 'superseded, owner decision rule applies' }] } };
  assert.equal(answerOf(q), null);
  assert.equal(answerOf(r), null);
});


test('only answer-bearing comments supply topic words, each independently', () => {
  const card = { ...cards[1], comments: { nodes: [
    { body: 'Search returns no results for tony awards.' },
    { body: 'Owner picked Option A: search controls.' },
    { body: 'Owner answered: awards badges stay.' },
    { body: 'DECISION NEEDED: Owner picked which ticket link?' },
  ] } };
  assert.deepEqual(findPriorAnswers('Search returns no results for tony awards', [card]), []);
  assert.deepEqual(findPriorAnswers('ticket link', [card]), []);
});

test('the matching answer comment supplies the warning text and date', () => {
  const card = { ...cards[1], comments: { nodes: [
    { body: 'Owner answered: keep outlet logos.', createdAt: '2026-10-01T00:00:00Z' },
    ...cards[1].comments.nodes,
  ] } };
  const [hit] = findPriorAnswers('sign-in sheet after first save', [card]);
  assert.equal(hit.identifier, 'BRO-4616');
  assert.match(hit.text, /sign-in sheet/);
  assert.equal(hit.date, '2026-10-04');
});

function tempCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-recall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'answers.json');
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

test('complete answered-card reads are cached for a day and scoped to a team', async (t) => {
  const cacheFile = tempCache(t);
  let calls = 0;
  const linear = { TEAM_KEY: 'BRO', graphql: async () => { calls++; return { issues: page(cards) }; } };
  const opts = { linear, cacheFile, now: () => 1_000_000 };
  assert.equal((await fetchAnsweredCards(opts)).length, 2);
  await fetchAnsweredCards(opts);
  assert.equal(calls, 1);
  await fetchAnsweredCards({ ...opts, now: () => 1_000_000 + 24 * 60 * 60 * 1000 });
  assert.equal(calls, 2);
  await fetchAnsweredCards({ ...opts, linear: { ...linear, TEAM_KEY: 'OTHER' } });
  assert.equal(calls, 3);
});

test('corrupt caches and unwritable cache paths do not prevent a live read', async (t) => {
  const cacheFile = tempCache(t);
  fs.writeFileSync(cacheFile, 'not json');
  let calls = 0;
  const linear = { TEAM_KEY: 'BRO', graphql: async () => { calls++; return { issues: page(cards) }; } };
  assert.equal((await fetchAnsweredCards({ linear, cacheFile })).length, 2);
  assert.equal((await fetchAnsweredCards({ linear, cacheFile: path.join(cacheFile, 'blocked.json') })).length, 2);
  assert.equal(calls, 2);
});

test('older comment pages are loaded before filtering for an owner answer', async (t) => {
  const cacheFile = tempCache(t);
  const calls = [];
  const linear = { TEAM_KEY: 'BRO', graphql: async (query, vars) => {
    calls.push(vars);
    if (query.includes('issues(')) return { issues: page([
      { ...cards[1], id: 'issue-id', comments: page([{ body: 'Earlier investigation' }], true, 'comment-cursor') },
    ]) };
    return { issue: { comments: page(cards[1].comments.nodes) } };
  } };
  const result = await fetchAnsweredCards({ linear, cacheFile });
  assert.equal(findPriorAnswers('sign-in sheet after first save', result)[0]?.identifier, 'BRO-4616');
  assert.deepEqual(calls[1], { id: 'issue-id', after: 'comment-cursor' });
  await fetchAnsweredCards({ linear, cacheFile });
  assert.equal(calls.length, 2);
});

test('truncated issue reads are never cached as a complete answer list', async (t) => {
  const cacheFile = tempCache(t);
  let calls = 0;
  const linear = { TEAM_KEY: 'BRO', graphql: async () => { calls++; return { issues: page([cards[0]], true, 'next-issues') }; } };
  await fetchAnsweredCards({ linear, cacheFile, maxPages: 1 });
  await fetchAnsweredCards({ linear, cacheFile, maxPages: 1 });
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('issue pagination is completed before caching, including an empty answer list', async (t) => {
  const cacheFile = tempCache(t);
  const cursors = [];
  const linear = { TEAM_KEY: 'BRO', graphql: async (_q, vars) => {
    cursors.push(vars.after);
    return { issues: vars.after ? page([cards[0]]) : page([], true, 'next-issues') };
  } };
  assert.equal((await fetchAnsweredCards({ linear, cacheFile })).length, 1);
  assert.deepEqual(cursors, [null, 'next-issues']);
  await fetchAnsweredCards({ linear, cacheFile });
  assert.equal(cursors.length, 2);
  fs.unlinkSync(cacheFile);
  linear.graphql = async () => { cursors.push(null); return { issues: page([]) }; };
  assert.deepEqual(await fetchAnsweredCards({ linear, cacheFile }), []);
  assert.deepEqual(await fetchAnsweredCards({ linear, cacheFile }), []);
  assert.equal(cursors.length, 3);
});

test('failed comment pagination is not cached as a complete answer list', async (t) => {
  const cacheFile = tempCache(t);
  const linear = { TEAM_KEY: 'BRO', graphql: async (query) => {
    if (query.includes('issues(')) return { issues: page([
      { ...cards[1], id: 'issue-id', comments: page(cards[1].comments.nodes, true, 'next') },
    ]) };
    throw new Error('comment read failed');
  } };
  await assert.rejects(fetchAnsweredCards({ linear, cacheFile }), /comment read failed/);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('an exhausted time budget starts no further page reads or cache writes', async (t) => {
  const cacheFile = tempCache(t);
  let clock = 0, calls = 0;
  const linear = { TEAM_KEY: 'BRO', graphql: async () => {
    calls++;
    clock = 8001;
    return { issues: page([cards[0]], true, 'next') };
  } };
  await assert.rejects(fetchAnsweredCards({ linear, cacheFile, now: () => clock, timeoutMs: 8000 }), /timed out/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('failed reads do not poison the cache', async (t) => {
  const cacheFile = tempCache(t);
  const linear = { TEAM_KEY: 'BRO', graphql: async () => { throw new Error('offline'); } };
  await assert.rejects(fetchAnsweredCards({ linear, cacheFile }), /offline/);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('bounded reads pass the remaining time to the transport without retries', async () => {
  let opts;
  const linear = { TEAM_KEY: 'BRO', graphql: async (_q, _v, o) => { opts = o; return { issues: page([]) }; } };
  await fetchAnsweredCards({ linear, cacheFile: null, timeoutMs: 8000 });
  assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 8000);
  assert.equal(opts.maxAttempts, 1);
});

async function createWithRecall(t, fetchCards, timeoutMs = 8000) {
  const { main } = require('../linear-brain.js');
  const errors = [], logs = [], creates = [];
  t.mock.method(console, 'error', (line) => errors.push(line));
  t.mock.method(console, 'log', (line) => logs.push(line));
  await main(['create', 'Email pop-up friction: dismiss signup popup', '--park', 'waiting on owner decision', '--model', 'sonnet'], {
    createLinearIssue: async (args) => {
      creates.push(args);
      return { issue: { identifier: 'BRO-TEST', title: args.title }, mode: 'park', stateName: 'Backlog' };
    },
    fetchAnsweredCards: fetchCards,
    ownerRecallTimeoutMs: timeoutMs,
  });
  assert.equal(creates.length, 1);
  assert.equal(JSON.parse(logs[0]).identifier, 'BRO-TEST');
  assert.ok(errors.some((line) => line.includes('__BOARD_CARD_ID__=BRO-TEST')));
  return errors.join('\n');
}

test('linear-brain create warns on the answered email pop-up title and still files', async (t) => {
  const warning = await createWithRecall(t, async () => cards);
  assert.match(warning, /owner.*answer/i);
  assert.match(warning, /BRO-3624/);
  assert.match(warning, /keep the current pop-up/);
});

test('linear-brain create tolerates recall failure after successful filing', async (t) => {
  assert.match(await createWithRecall(t, async () => { throw new Error('offline'); }), /recall skipped.*offline/);
});

test('linear-brain create caps a stalled recall and still reports success', async (t) => {
  const started = Date.now();
  const warning = await createWithRecall(t, () => new Promise(() => {}), 15);
  assert.match(warning, /recall skipped.*timed out/i);
  assert.ok(Date.now() - started < 1000);
});
