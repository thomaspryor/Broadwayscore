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
  });
  assert.equal(cards[1].name, '(untitled)');
});

test('fetchBrainCards throws on HTTP error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(() => fetchBrainCards('key', fetchImpl), /HTTP 401/);
});
