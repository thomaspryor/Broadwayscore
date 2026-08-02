import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyStuckCards, fetchBrainCards } = require('./stuck-work.js');

const NOW = Date.parse('2026-07-22T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('paused P0/P1 flags regardless of age', () => {
  const r = classifyStuckCards(
    [{ name: 'A', status: 'Paused', priority: 'P1 Next', lastEditedAt: hoursAgo(1) }],
    NOW,
  );
  assert.equal(r.pausedCritical.length, 1);
  assert.equal(r.pausedStale.length, 0);
});

test('paused P2 flags only after 7 days', () => {
  const fresh = { name: 'B', status: 'Paused', priority: 'P2 Later', lastEditedAt: hoursAgo(24) };
  const old = { name: 'C', status: 'Paused', priority: 'P2 Later', lastEditedAt: hoursAgo(24 * 8) };
  const r = classifyStuckCards([fresh, old], NOW);
  assert.equal(r.pausedCritical.length, 0);
  assert.deepEqual(r.pausedStale.map((c) => c.name), ['C']);
});

test('paused card with no priority treated as non-critical', () => {
  const r = classifyStuckCards(
    [{ name: 'D', status: 'Paused', priority: null, lastEditedAt: hoursAgo(24 * 30) }],
    NOW,
  );
  assert.equal(r.pausedCritical.length, 0);
  assert.equal(r.pausedStale.length, 1);
});

test('in-progress flags only past the 48h orphan threshold', () => {
  const active = { name: 'E', status: 'In progress', priority: 'P0 Now', lastEditedAt: hoursAgo(47) };
  const orphan = { name: 'F', status: 'In progress', priority: null, lastEditedAt: hoursAgo(49) };
  const r = classifyStuckCards([active, orphan], NOW);
  assert.deepEqual(r.orphaned.map((c) => c.name), ['F']);
});

test('sorted oldest-first, other statuses ignored, bad dates counted', () => {
  const r = classifyStuckCards(
    [
      { name: 'newer', status: 'In progress', priority: null, lastEditedAt: hoursAgo(72) },
      { name: 'older', status: 'In progress', priority: null, lastEditedAt: hoursAgo(200) },
      { name: 'done', status: 'Done', priority: 'P0 Now', lastEditedAt: hoursAgo(999) },
      { name: 'bad-date', status: 'Paused', priority: 'P0 Now', lastEditedAt: 'not-a-date' },
    ],
    NOW,
  );
  assert.deepEqual(r.orphaned.map((c) => c.name), ['older', 'newer']);
  assert.equal(r.pausedCritical.length, 0);
  assert.equal(r.invalidDates, 1);
});

test('fetchBrainCards aborts past the page cap instead of truncating silently', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ has_more: true, next_cursor: 'again', results: [] }),
  });
  await assert.rejects(() => fetchBrainCards('key', fetchImpl), /pagination exceeded/);
});

test('fetchBrainCards paginates and maps properties', async () => {
  const pages = [
    {
      has_more: true,
      next_cursor: 'c2',
      results: [{
        url: 'https://notion.so/x',
        last_edited_time: '2026-07-01T00:00:00Z',
        properties: {
          Name: { title: [{ plain_text: 'Card ' }, { plain_text: 'One' }] },
          Status: { status: { name: 'Paused' } },
          Priority: { select: { name: 'P1 Next' } },
          Notes: { rich_text: [{ plain_text: 'acceptance: run the thing' }] },
          Outcome: { rich_text: [{ plain_text: 'RECHECK-AFTER: 2026-08-05 ' }, { plain_text: 'shipped' }] },
        },
      }],
    },
    { has_more: false, results: [{ url: 'u2', last_edited_time: '2026-07-02T00:00:00Z', properties: {} }] },
  ];
  let call = 0;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (call === 1) assert.equal(body.start_cursor, 'c2');
    return { ok: true, json: async () => pages[call++] };
  };
  const cards = await fetchBrainCards('key', fetchImpl);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    name: 'Card One', status: 'Paused', priority: 'P1 Next',
    lastEditedAt: '2026-07-01T00:00:00Z', url: 'https://notion.so/x',
    notes: 'acceptance: run the thing',
    outcome: 'RECHECK-AFTER: 2026-08-05 shipped',
  });
  assert.equal(cards[1].name, '(untitled)');
  // Pages with no Notes/Outcome properties map to empty strings, not crashes.
  assert.equal(cards[1].notes, '');
  assert.equal(cards[1].outcome, '');
});

// ── RECHECK-AFTER awareness (NOW = 2026-07-22) ─────────────────────────────

test('paused P1 with a future stamp in notes goes to pausedAwaitingRecheck', () => {
  const r = classifyStuckCards(
    [{ name: 'G', status: 'Paused', priority: 'P1 Next', lastEditedAt: hoursAgo(1), notes: 'RECHECK-AFTER: 2026-07-30' }],
    NOW,
  );
  assert.equal(r.pausedCritical.length, 0);
  assert.equal(r.pausedAwaitingRecheck.length, 1);
  assert.equal(r.pausedAwaitingRecheck[0].recheckAfterMs, Date.parse('2026-07-30T00:00:00Z'));
});

test('paused P0 with the stamp in OUTCOME only is still awaiting (the 3-of-5-cards gap)', () => {
  const r = classifyStuckCards(
    [{ name: 'H', status: 'Paused', priority: 'P0 Now', lastEditedAt: hoursAgo(48), notes: 'no stamp here', outcome: 'RECHECK-AFTER: 2026-08-01 verified later' }],
    NOW,
  );
  assert.equal(r.pausedCritical.length, 0);
  assert.deepEqual(r.pausedAwaitingRecheck.map((c) => c.name), ['H']);
});

test('stamp overdue past the 3d grace counts as stuck, with stampOverdueDays attached', () => {
  const r = classifyStuckCards(
    [{ name: 'I', status: 'Paused', priority: 'P1 Next', lastEditedAt: hoursAgo(24), notes: 'RECHECK-AFTER: 2026-07-17' }],
    NOW,
  );
  assert.equal(r.pausedAwaitingRecheck.length, 0);
  assert.equal(r.pausedCritical.length, 1);
  assert.equal(r.pausedCritical[0].stampOverdueDays, 5);
});

test('stamp overdue 1d stays in the grace window (due today, recheck runs tonight)', () => {
  const r = classifyStuckCards(
    [{ name: 'J', status: 'Paused', priority: 'P0 Now', lastEditedAt: hoursAgo(24), notes: 'RECHECK-AFTER: 2026-07-21' }],
    NOW,
  );
  assert.equal(r.pausedCritical.length, 0);
  assert.equal(r.pausedAwaitingRecheck.length, 1);
});

test('stampless paused P0 still fires exactly as before (regression guard)', () => {
  const r = classifyStuckCards(
    [{ name: 'K', status: 'Paused', priority: 'P0 Now', lastEditedAt: hoursAgo(1), notes: 'nothing dated', outcome: '' }],
    NOW,
  );
  assert.deepEqual(r.pausedCritical.map((c) => c.name), ['K']);
  assert.equal(r.pausedAwaitingRecheck.length, 0);
});

test('paused P2 older than 7d with a future stamp is excluded from pausedStale', () => {
  const stamped = { name: 'L', status: 'Paused', priority: 'P2 Later', lastEditedAt: hoursAgo(24 * 10), outcome: 'RECHECK-AFTER: 2026-08-09' };
  const plain = { name: 'M', status: 'Paused', priority: 'P2 Later', lastEditedAt: hoursAgo(24 * 10) };
  const r = classifyStuckCards([stamped, plain], NOW);
  assert.deepEqual(r.pausedStale.map((c) => c.name), ['M']);
});

test('pausedAwaitingRecheck sorts by soonest stamp first', () => {
  const r = classifyStuckCards(
    [
      { name: 'later', status: 'Paused', priority: 'P1 Next', lastEditedAt: hoursAgo(1), notes: 'RECHECK-AFTER: 2026-08-09' },
      { name: 'sooner', status: 'Paused', priority: 'P1 Next', lastEditedAt: hoursAgo(1), notes: 'RECHECK-AFTER: 2026-07-25' },
    ],
    NOW,
  );
  assert.deepEqual(r.pausedAwaitingRecheck.map((c) => c.name), ['sooner', 'later']);
});

test('fetchBrainCards throws on HTTP error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => fetchBrainCards('key', fetchImpl), /HTTP 401/);
});
