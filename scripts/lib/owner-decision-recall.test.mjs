import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { findPriorAnswers, splitAnswered, answerOf, fetchAnsweredCards, readAnsweredCards, warnPriorAnswers, startCacheWarmer,
  ANSWER_RE, MARKER_PHRASES, CLOSED_QUERY } = require('./owner-decision-recall.js');

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

// Excerpts of the real BRO-4616 thread (read live 2026-10-19). Linear returns
// comments newest first. The answer comment never says "sign-in sheet"; the
// Outcome posted after it does. The proposal comments before the answer list
// every option, so they must not count.
const REAL_4616 = { identifier: 'BRO-4616', title: 'Proposal: promote account creation, especially on mobile', state: { type: 'completed' },
  description: '## Problem\n\nAccounts went live on broadwayscorecard.com on 2026-10-04 (BRO-4525). On phones the account entry point is hard to find: the header "Sign in" button is `hidden sm:flex`.',
  comments: { nodes: [
    { createdAt: '2026-10-05T04:23:10.165Z', body: 'Post-ship /second-opinion follow-up landed as 5931283e and is live. local-watchlist: when localStorage throws, list + prompt cooldown fall back to memory, so a second tap removes instead of re-adding and re-opening the sheet.' },
    { createdAt: '2026-10-05T02:41:39.655Z', body: '## Outcome\nLanded on main as 193732a0 via land/bro-4616-save-first-signup (Land run 37247607946; checks green).\n**What:** Signed-out users can save a show before having an account (Option A). The save happens immediately into localStorage and the sign-in sheet opens right after the first save ("Saved. Keep your list with a free account"); closing it keeps the save.' },
    { createdAt: '2026-10-04T21:35:39.116Z', body: "Owner picked Option A (verified verbatim in parent session event de2fa5c5, iOS, 21:30Z: 'Option A; yes let them bookmark before asking them to sign in'). Building ideas 1-3: local-first bookmark, inline 'Seen it?' stars in show hero, My Shows card in phone menu." },
    { createdAt: '2026-10-04T21:17:27.717Z', body: 'Scope addition: proposal v2 adds #4, a first-run welcome sheet after sign_in_completed is_new_user (poster grid to mark seen + Show-Score/Mezzanine import). Still waiting on the owner\'s pick.' },
    { createdAt: '2026-10-04T21:15:45.423Z', body: 'Session report (paused). Proposal published, waiting on owner pick. Bookmark tap opens the centered SignInModal before anything is saved. Ranked ideas: 1 local-first bookmark + toast + 2nd-save sheet; 2 inline stars; 3 welcome email.' },
  ] } };

test('real BRO-4616 thread: the sign-in sheet topic resolves through the comment after the answer', () => {
  const [hit, ...rest] = findPriorAnswers('sign-in sheet after first save', [REAL_4616]);
  assert.equal(hit?.identifier, 'BRO-4616');
  assert.equal(rest.length, 0);
  assert.match(hit.text, /^Owner picked Option A/, 'the warning quotes the answer, not the follow-up');
  assert.equal(hit.date, '2026-10-04');
});

test('options discussed before the answer do not establish a topic', () => {
  // "welcome sheet" / "Mezzanine import" only appear in the pre-answer proposal comments.
  assert.deepEqual(findPriorAnswers('Mezzanine import welcome sheet', [REAL_4616]), []);
});

test('only the one comment right after an answer counts, and only its opening', () => {
  const late = { ...REAL_4616, comments: { nodes: [
    REAL_4616.comments.nodes[2],
    { createdAt: '2026-10-05T00:00:00Z', body: `${'x '.repeat(400)} sign-in sheet after the first save` },
    { createdAt: '2026-10-06T00:00:00Z', body: 'Later note: the sign-in sheet opens after the first save.' },
  ] } };
  assert.deepEqual(findPriorAnswers('sign-in sheet after first save', [late]), []);
});

test('a card about the recall feature itself is not an owner answer (live BRO-5385 false positive)', () => {
  const meta = { identifier: 'BRO-5385', title: 'Owner gets re-asked questions already answered (email pop-up, sign-in prompt)', state: { type: 'completed' },
    description: 'The email pop-up question had been answered on 2026-10-11 (BRO-3624) and the after-first-save sign-in sheet on 2026-10-04 (BRO-4616, Option A).',
    comments: { nodes: [{ createdAt: '2026-10-15T09:00:21Z', body: "Outcome: owner answers are now recalled. New scripts/lib/owner-decision-recall.js finds answer markers like 'Owner answered/declined/picked'." }] } };
  assert.deepEqual(findPriorAnswers('sign-in sheet after first save', [meta]), []);
  assert.deepEqual(findPriorAnswers('Email pop-up friction: dismiss signup popup', [meta]), []);
});

test('every answer marker is covered by the server-side phrase filter', () => {
  const samples = ['Owner answered: keep', 'owner declined it', 'Owner picked Option A', 'The owner chose B',
    'Owner decision on the decisions page (2026-10-11)', 'Owner decision (2026-10-11): keep', 'owner decision 2026-10-11 keep', 'owner decision 1999-01-01'];
  for (const s of samples) {
    assert.ok(ANSWER_RE.test(s), s);
    assert.ok(MARKER_PHRASES.some((p) => s.toLowerCase().includes(p)), `no server filter phrase for: ${s}`);
  }
  assert.ok(MARKER_PHRASES.every((p) => CLOSED_QUERY.includes(JSON.stringify(p))));
});

test('a stalled first page under a budget yields an empty partial read, not a throw', async () => {
  const linear = { TEAM_KEY: 'BRO', graphql: (_q, _v, o) => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), o.timeoutMs)) };
  const res = await readAnsweredCards({ linear, cacheFile: null, timeoutMs: 20 });
  assert.deepEqual(res.cards, []);
  assert.equal(res.complete, false);
  assert.match(res.error.message, /aborted/);
});

test('a budget that runs out after page 1 returns page 1 answers and caches nothing', async (t) => {
  const cacheFile = tempCache(t);
  let clock = 0;
  const linear = { TEAM_KEY: 'BRO', graphql: async () => { clock = 9000; return { issues: page(cards, true, 'next') }; } };
  const res = await readAnsweredCards({ linear, cacheFile, now: () => clock, timeoutMs: 8000 });
  assert.equal(res.complete, false);
  assert.deepEqual(res.cards.map((c) => c.identifier), ['BRO-3624', 'BRO-4616']);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('built-in path: a partial read still warns and says it was partial; a cold cache starts one warmer', async (t) => {
  const cacheFile = tempCache(t);
  const spawned = [];
  const lines = [];
  const linear = { TEAM_KEY: 'BRO', graphql: async (_q, vars) => {
    if (!vars.after) return { issues: page(cards, true, 'next') };
    throw new Error('aborted');
  } };
  const opts = { linear, cacheFile, env: {}, warn: (l) => lines.push(l),
    spawnFn: (...args) => { spawned.push(args); return { pid: 42, unref() {} }; } };
  await warnPriorAnswers('Email pop-up friction: dismiss signup popup', opts);
  await warnPriorAnswers('Email pop-up friction: dismiss signup popup', opts);
  assert.match(lines.join('\n'), /BRO-3624/);
  assert.match(lines.join('\n'), /recall was partial \(2 answered cards read; aborted/);
  assert.equal(spawned.length, 1, 'the warming lock stops a second spawn');
  assert.deepEqual(spawned[0][1].slice(1), ['--warm', cacheFile]);
  assert.equal(spawned[0][2].stdio, 'ignore');
  assert.equal(spawned[0][2].detached, true);
});

test('built-in path: a warm cache answers with no Linear read and no warmer', async (t) => {
  const cacheFile = tempCache(t);
  const linear = { TEAM_KEY: 'BRO', graphql: async () => ({ issues: page(cards) }) };
  await fetchAnsweredCards({ linear, cacheFile });
  linear.graphql = async () => { throw new Error('must not read Linear'); };
  const lines = [];
  await warnPriorAnswers('sign-in sheet after first save', { linear, cacheFile, env: {}, warn: (l) => lines.push(l),
    spawnFn: () => { throw new Error('must not spawn'); } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /BRO-4616/);
});

test('warmer: never in CI, and a stale lock is taken over', (t) => {
  const cacheFile = tempCache(t);
  const spawns = [];
  const spawnFn = () => { spawns.push(1); return { pid: 7, unref() {} }; };
  assert.equal(startCacheWarmer({ cacheFile, spawnFn, env: { CI: 'true' } }), null);
  assert.equal(startCacheWarmer({ cacheFile, spawnFn, env: {} }), 7);
  assert.equal(startCacheWarmer({ cacheFile, spawnFn, env: {} }), null);
  assert.equal(startCacheWarmer({ cacheFile, spawnFn, env: {}, now: () => Date.now() + 11 * 60 * 1000 }), 7);
  assert.equal(spawns.length, 2);
});

test('LINEAR_BRAIN_SKIP_RECALL=1 and node --test (without an injected fetcher) skip the lookup silently', async () => {
  const lines = [];
  const fail = { TEAM_KEY: 'BRO', graphql: async () => { throw new Error('must not read Linear'); } };
  await warnPriorAnswers('email popup', { env: { LINEAR_BRAIN_SKIP_RECALL: '1' }, fetchCards: async () => cards, warn: (l) => lines.push(l) });
  await warnPriorAnswers('email popup', { env: { NODE_TEST_CONTEXT: 'child' }, linear: fail, warn: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});

test('a card where the owner changed their mind quotes the latest answer', () => {
  const card = { identifier: 'BRO-9', title: 'Email pop-up timing', state: { type: 'canceled' }, comments: { nodes: [
    { createdAt: '2026-10-12T00:00:00Z', body: 'Owner answered: remove the email pop-up.' },
    { createdAt: '2026-10-01T00:00:00Z', body: 'Owner answered: keep the email pop-up.' },
  ] } };
  assert.equal(answerOf(card).date, '2026-10-12');
  assert.match(findPriorAnswers('email pop-up timing', [card])[0].text, /remove/);
});

test('an Outcome comment that only lists the recall file under Key Files does not hide a real answer', () => {
  const card = { ...REAL_4616, comments: { nodes: [...REAL_4616.comments.nodes,
    { createdAt: '2026-10-06T00:00:00Z', body: 'Key Files: scripts/lib/owner-decision-recall.js' }] } };
  assert.equal(findPriorAnswers('sign-in sheet after first save', [card])[0]?.identifier, 'BRO-4616');
});

test('warmer: a spawn error event releases the lock and does not throw', async (t) => {
  const { EventEmitter } = await import('node:events');
  const cacheFile = tempCache(t);
  const child = Object.assign(new EventEmitter(), { pid: 9, unref() {} });
  assert.equal(startCacheWarmer({ cacheFile, spawnFn: () => child, env: {} }), 9);
  assert.ok(fs.existsSync(`${cacheFile}.warming`));
  child.emit('error', new Error('spawn EAGAIN'));
  assert.equal(fs.existsSync(`${cacheFile}.warming`), false);
  assert.equal(startCacheWarmer({ cacheFile, spawnFn: () => { throw new Error('EMFILE'); }, env: {} }), null);
  assert.equal(fs.existsSync(`${cacheFile}.warming`), false);
});

test('a follow-up comment with only two generic shared words does not match a longer topic (BRO-5390 review)', () => {
  const card = { identifier: 'BRO-2393', title: 'All ticket clicks routing through TodayTix only', state: { type: 'canceled' }, description: '', comments: { nodes: [
    { createdAt: '2026-09-01T00:00:00Z', body: 'Owner picked Option B.' },
    { createdAt: '2026-09-01T01:00:00Z', body: '## Outcome\nRouted every ticket link to the closed shows page.' } ] } };
  assert.deepEqual(findPriorAnswers('Ticket link broken on closed shows', [card]), []);
});
