import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bc = require('./board-categories.js');
const { AUTO_FILED_MARKER } = require('./linear-drain-parked.js');

const NOW = new Date('2026-10-27T12:00:00Z');
const VERIFY = '## Acceptance criteria\nVERIFY: node --test scripts/lib/foo.test.mjs';

let seq = 0;
function card(over = {}) {
  seq++;
  return {
    identifier: `BRO-${seq}`,
    title: `Card ${seq}`,
    priority: 3,
    url: `https://linear.app/x/BRO-${seq}`,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    description: VERIFY,
    ...over,
  };
}
const withDesc = (extra, over = {}) => card({ description: `${VERIFY}\n${extra}`, ...over });
const categoryOf = (issue) => bc.categorizeBoard([issue], { now: NOW }).cards[0].category;

// One fixture per category, in table order.
const FIXTURES = {
  'waiting-owner': () => withDesc('DECISION NEEDED: Ship the new homepage or keep the old one?'),
  'being-worked': () => card({ state: { name: 'In Progress', type: 'started' } }),
  'dated-future': () => withDesc('RECHECK-AFTER: 2026-11-05', { state: { name: 'Paused', type: 'backlog' } }),
  'dated-past': () => withDesc('RECHECK-AFTER: 2026-10-20', { state: { name: 'Paused', type: 'backlog' } }),
  'parked-real-block': () => withDesc('PARKED: needs an API key from the vendor'),
  'parked-automatic': () => card({ title: 'BSC Daily estimate check failed', description: `${VERIFY}\nPARKED: estimate drift` }),
  'parked-owner-wording': () => withDesc('PARKED: needs owner decision'),
  'parked-no-reason': () => card({ state: { name: 'Backlog', type: 'backlog' } }),
  'parked-other': () => withDesc('PARKED: waiting for upstream fix'),
  paused: () => card({ state: { name: 'Paused', type: 'backlog' } }),
  ready: () => card(),
  'cooling-off': () => card({ updatedAt: '2026-10-27T11:00:00Z' }),
  'codex-bounced': () => card({ comments: { nodes: [{ body: '<!-- codex-runner-bounced -->\nCodex could not finish this.', createdAt: '2026-10-26T00:00:00Z' }] } }),
  'owner-gated-no-question': () => withDesc('Owner must decide whether to keep this.'),
  other: () => card({ priority: 0 }),
};

test('the fixtures cover every category exactly once', () => {
  assert.deepEqual(Object.keys(FIXTURES), bc.CATEGORIES.map((c) => c.key));
});

for (const [key, make] of Object.entries(FIXTURES)) {
  test(`fixture lands in ${key}`, () => {
    assert.equal(categoryOf(make()), key);
  });
}

test('automatic park: the alert router marker counts as automatic', () => {
  const issue = card({ description: `PARKED: auto-filed ${AUTO_FILED_MARKER}\n${VERIFY}` });
  assert.equal(categoryOf(issue), 'parked-automatic');
});

test('overlap: a Paused card with a future date is dated exclusively and Paused in overlap', () => {
  const issue = withDesc('RECHECK-AFTER: 2026-11-05', { state: { name: 'Paused', type: 'backlog' } });
  const r = bc.categorizeBoard([issue], { now: NOW });
  const row = (k) => r.categories.find((c) => c.key === k);
  assert.equal(r.cards[0].category, 'dated-future');
  assert.equal(row('dated-future').exclusive, 1);
  assert.equal(row('paused').exclusive, 0);
  assert.equal(row('paused').overlap, 1);
  assert.deepEqual(r.cards[0].traits, ['dated-future', 'paused']);
});

test('a date stamp on today counts as future (stamp on or after today)', () => {
  assert.equal(categoryOf(withDesc('RECHECK-AFTER: 2026-10-27', { state: { name: 'Paused', type: 'backlog' } })), 'dated-future');
});

test('an answered question does not count as waiting on the owner', () => {
  const issue = withDesc('ANSWERED by the owner: Ship the new homepage or keep the old one? -> ship it');
  assert.notEqual(categoryOf(issue), 'waiting-owner');
});

test('an OWNER-CLEARED comment lifts the wait', () => {
  const issue = withDesc('DECISION NEEDED: Ship the new homepage or keep the old one?', {
    comments: { nodes: [{ body: 'OWNER-CLEARED: go with the new one', createdAt: '2026-10-26T00:00:00Z' }] },
  });
  assert.notEqual(categoryOf(issue), 'waiting-owner');
});

test('invariant: exclusive counts add up to the open count across a mixed board', () => {
  const board = [...Object.values(FIXTURES).map((f) => f()), ...Object.values(FIXTURES).map((f) => f())];
  const r = bc.categorizeBoard(board, { now: NOW });
  assert.equal(r.open, board.length);
  assert.equal(r.categories.reduce((a, c) => a + c.exclusive, 0), board.length);
  assert.equal(r.totals.exclusive, board.length);
  for (const c of r.categories) {
    assert.equal(c.exclusive, 2, c.key);
    assert.ok(c.overlap >= c.exclusive, c.key);
    assert.equal(Object.values(c.byPriority).reduce((a, b) => a + b, 0), c.exclusive, c.key);
  }
});

test('invariant: a card that throws lands in Other instead of breaking the sum', () => {
  const bad = card();
  Object.defineProperty(bad, 'description', { get() { throw new Error('boom'); } });
  const r = bc.categorizeBoard([bad, card()], { now: NOW });
  assert.equal(r.cards[0].category, 'other');
  assert.match(r.cards[0].reason, /categorize-error: boom/);
  assert.equal(r.totals.exclusive, 2);
});

test('answeredCheck says whether the answer-link secret was available', () => {
  assert.equal(bc.categorizeBoard([], { now: NOW }).answeredCheck, 'answered-line-only');
  assert.equal(bc.categorizeBoard([], { now: NOW, secret: 's' }).answeredCheck, 'full');
});

test('important and stuck: Urgent or High that nobody is on', () => {
  const stuck = card({ priority: 1, title: 'Prod is down' });
  const worked = card({ priority: 1, state: { name: 'In Progress', type: 'started' } });
  const dated = withDesc('RECHECK-AFTER: 2026-11-05', { priority: 2, state: { name: 'Paused', type: 'backlog' } });
  const low = card({ priority: 4 });
  const r = bc.categorizeBoard([low, dated, worked, stuck], { now: NOW });
  assert.deepEqual(r.importantStuck.map((c) => c.title), ['Prod is down']);
});

test('flowFromInflow reads board-numbers counts and the self-tracking split', () => {
  const f = bc.flowFromInflow({ created: 10, completed: 7, canceled: 2, excluded: { created: { sessionTracking: 3 }, completed: { sessionTracking: 4 } } });
  assert.deepEqual(f, { created: 10, createdSelf: 3, done: 7, doneSelf: 4, canceled: 2, truncated: false });
  assert.equal(bc.flowFromInflow(null), null);
  assert.match(bc.flowLine(f), /10 cards added \(plus 3 that sessions filed/);
  assert.equal(bc.flowLine(null), 'Last 24 hours: not available.');
});

test('compareReports gives per-category deltas and handles a missing previous', () => {
  const a = bc.categorizeBoard([FIXTURES.ready()], { now: NOW });
  const b = bc.categorizeBoard([FIXTURES.ready(), FIXTURES.paused()], { now: NOW });
  const cmp = bc.compareReports(bc.snapshotOf(a), b);
  assert.equal(cmp.open.before, 1);
  assert.equal(cmp.open.after, 2);
  assert.equal(cmp.rows.find((r) => r.key === 'paused').delta, 1);
  assert.equal(cmp.rows.find((r) => r.key === 'ready').delta, 0);
  const none = bc.compareReports(null, b);
  assert.equal(none.rows[0].delta, null);
  assert.match(bc.formatCompareMarkdown(cmp), /\| Paused \| 0 \| 1 \| \+1 \|/);
});

test('snapshotOf carries counts only, never titles or ids', () => {
  const snap = bc.snapshotOf(bc.categorizeBoard([card({ title: 'Secret title' })], { now: NOW }));
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /Secret title|BRO-\d/);
});

test('formatMarkdown: plain table with every row, totals, no card ids', () => {
  const board = Object.values(FIXTURES).map((f) => f());
  board.push(card({ priority: 1, title: 'Prod is down' }));
  const md = bc.formatMarkdown(bc.categorizeBoard(board, { now: NOW }), { flow: null });
  for (const c of bc.CATEGORIES) assert.ok(md.includes(`| ${c.label} |`), c.label);
  assert.match(md, /\| \*\*Total\*\* \| \*\*16\*\* \|/);
  assert.match(md, /- Urgent: Prod is down \(Ready for a worker or Codex\)/);
  assert.doesNotMatch(md, /BRO-\d/);
  assert.match(md, /recognised from the card text only/);
});

test('fetchOpenBoard pages through and refuses a partial board', async () => {
  let calls = 0;
  const two = async () => ({ issues: { nodes: [card()], pageInfo: { hasNextPage: ++calls < 2, endCursor: 'c' } } });
  assert.equal((await bc.fetchOpenBoard({ graphql: two })).length, 2);
  const endless = async () => ({ issues: { nodes: [card()], pageInfo: { hasNextPage: true, endCursor: 'c' } } });
  await assert.rejects(bc.fetchOpenBoard({ graphql: endless, maxPages: 3 }), /refusing to report a partial board/);
});

test('Other overlap counts only the cards that land in Other', () => {
  const r = bc.categorizeBoard([card(), card({ priority: 0 })], { now: NOW });
  const other = r.categories.find((c) => c.key === 'other');
  assert.equal(other.exclusive, 1);
  assert.equal(other.overlap, 1);
});

test('important and stuck: an Urgent In Review card still counts as stuck; In Progress does not', () => {
  const review = card({ priority: 1, title: 'Idle review', state: { name: 'In Review', type: 'started' } });
  const working = card({ priority: 1, title: 'Being fixed', state: { name: 'In Progress', type: 'started' } });
  const r = bc.categorizeBoard([review, working], { now: NOW });
  assert.equal(r.cards[0].category, 'being-worked');
  assert.deepEqual(r.importantStuck.map((c) => c.title), ['Idle review']);
});

test('real block: "key" means a credential, not a "key decision"', () => {
  assert.equal(categoryOf(withDesc('PARKED: key decision pending from owner')), 'parked-owner-wording');
  assert.equal(categoryOf(withDesc('PARKED: needs the vendor key')), 'parked-real-block');
});

test('the Other fixture lands there for its own reason, not a categorize error', () => {
  const r = bc.categorizeBoard([FIXTURES.other()], { now: NOW });
  assert.equal(r.cards[0].reason, 'no-priority');
});

test('a card that could not be read is named in the markdown', () => {
  const bad = card();
  Object.defineProperty(bad, 'description', { get() { throw new Error('boom'); } });
  assert.match(bc.formatMarkdown(bc.categorizeBoard([bad], { now: NOW })), /1 card could not be read/);
});

test('an open question becomes not-waiting once the answer path rewrites it', () => {
  const q = 'Ship the new homepage or keep the old one?';
  assert.equal(categoryOf(withDesc(`DECISION NEEDED: ${q}`)), 'waiting-owner');
  assert.notEqual(categoryOf(withDesc(`ANSWERED by the owner: ${q} -> ship it`)), 'waiting-owner');
});

test('a card the dispatcher holds for the owner with no question gets its own row, not Other', () => {
  const c = withDesc('Owner must decide whether to keep this.\n\nVERIFY: node --test tests/unit/x.test.mjs');
  assert.equal(categoryOf(c), 'owner-gated-no-question');
  const r = bc.categorizeBoard([c], { now: NOW });
  assert.equal(bc.ownerGatedNoQuestion(r), 1);
  assert.match(bc.formatMarkdown(r), /Held for you, but no question written/);
  // Writing the real question moves it to Waiting on your answer.
  assert.equal(categoryOf(withDesc('DECISION NEEDED: Keep this or drop it?\n\nOwner must decide.')), 'waiting-owner');
});

test('owner-gated cards without a question are named under the table', () => {
  const r = { cards: [{ category: 'other', reason: 'awaiting-owner' }, { category: 'other', reason: 'ios-app-repo' }, { category: 'ready', reason: 'awaiting-owner' }] };
  assert.equal(bc.ownerGatedNoQuestion(r), 1);
  assert.equal(bc.ownerGatedNoQuestion({}), 0);
});

test('board-report parseArgs', () => {
  assert.deepEqual(bc.parseReportArgs([]), { mode: 'markdown', compare: null, save: null });
  assert.equal(bc.parseReportArgs(['--json']).mode, 'json');
  assert.deepEqual(bc.parseReportArgs(['--compare=a.json']), { mode: 'compare', compare: 'a.json', save: null });
  assert.equal(bc.parseReportArgs(['--save=x.json']).save, 'x.json');
  assert.ok(bc.parseReportArgs(['--bogus']).error);
  assert.ok(bc.parseReportArgs(['--compare=']).error);
  assert.ok(bc.parseReportArgs(['--save=']).error, 'empty --save is refused');
  assert.ok(bc.parseReportArgs(['--compare=a.json', '--json']).error, 'two modes are refused');
});

test('an old RECHECK stamp on a Todo card is history: an Urgent one still shows as stuck', () => {
  const issue = withDesc('RECHECK-AFTER: 2026-10-01', { priority: 1 });
  const r = bc.categorizeBoard([issue], { now: NOW });
  assert.ok(!r.cards[0].traits.includes('dated-past'));
  assert.equal(r.importantStuck.length, 1);
});
