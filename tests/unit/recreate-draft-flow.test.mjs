/**
 * BRO-7580: pin the 2026-04-21 bug. `send-opening-night-broadcast.js --dry-run
 * --recreate-draft` once DELETED a live Resend draft. These tests run the real
 * decision logic (scripts/lib/recreate-draft-flow.js, which main() calls) with
 * every write injected, per CLAUDE.md §15 (require() the real module).
 *
 * What a green run means: a rehearsal or refused recreate cannot delete a
 * draft or clear a tracker record. It does NOT mean opening night works; it
 * says nothing about scraping, scoring, timing, the real Resend API or deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runRecreateDraft } = require('../../scripts/lib/recreate-draft-flow.js');

const SHOW = 'into-the-woods-noel-coward-west-end-2026';
const KEY = `west-end:${SHOW}`;
const draftRec = { draftId: 'd1', completed: true, draftStatus: 'draft', sentAt: null, broadcastKey: KEY };
const sentShows = () => ({ [KEY]: { ...draftRec }, [SHOW]: { ...draftRec } });

/** Records every call so a test can assert on writes. */
function harness({ live = { ok: true, data: { status: 'draft' } }, deleteRes = { statusCode: 200, body: '' } } = {}) {
  const calls = { get: [], del: [], clear: [], log: [] };
  return {
    calls,
    deps: {
      getBroadcast: async (id) => { calls.get.push(id); return live; },
      deleteBroadcast: async (id) => { calls.del.push(id); return deleteRes; },
      clearEntries: (keys) => { calls.clear.push(keys); },
      log: (m) => calls.log.push(m),
    },
  };
}
const base = { broadcastKey: KEY, showIds: [SHOW], sendTo: null, hasApiKey: true };

test('dry run + unsent live draft: reads Resend, makes ZERO writes (the 2026-04-21 bug)', async () => {
  const h = harness();
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: true, ...h.deps });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(h.calls.get, ['d1'], 'must have reached the live-status GET (not vacuous)');
  assert.deepEqual(h.calls.del, [], 'dry run must not DELETE a Resend draft');
  assert.deepEqual(h.calls.clear, [], 'dry run must not clear tracker records');
  assert.ok(h.calls.log.some(m => m.includes('[DRY RUN] Would delete old draft(s) d1')));
});

test('dry run without an API key: no GET, no writes, says it could not check', async () => {
  const h = harness();
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: true, hasApiKey: false, ...h.deps });
  assert.equal(r.ok, true);
  assert.deepEqual([h.calls.get, h.calls.del, h.calls.clear], [[], [], []]);
  assert.ok(h.calls.log.some(m => m.includes('cannot check live status of d1')));
});

test('control: the same input WITHOUT dry run does delete and clear (proves the test can go red)', async () => {
  const h = harness();
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: false, ...h.deps });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.del, ['d1']);
  assert.equal(h.calls.clear.length, 1);
  assert.deepEqual(h.calls.clear[0].sort(), [KEY, SHOW].sort());
});

test('live Resend says the draft was already sent: refused with zero writes, dry run or not', async () => {
  for (const dryRun of [true, false]) {
    const h = harness({ live: { ok: true, data: { status: 'sent' } } });
    const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun, ...h.deps });
    assert.equal(r.ok, false);
    assert.match(r.reason, /draft d1: .*not draft/);
    assert.deepEqual([h.calls.del, h.calls.clear], [[], []]);
  }
});

test('Resend 404 (status deleted) is refused: a sent broadcast also 404s', async () => {
  const h = harness({ live: { ok: true, data: { status: 'deleted' } } });
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: false, ...h.deps });
  assert.equal(r.ok, false);
  assert.deepEqual([h.calls.del, h.calls.clear], [[], []]);
});

test('tracker already says sent: refused before any Resend call', async () => {
  const h = harness();
  const sent = { ...draftRec, draftStatus: 'sent', sentAt: '2026-11-01T00:00:00Z' };
  const r = await runRecreateDraft({ ...base, sentShows: { [KEY]: sent, [SHOW]: sent }, dryRun: false, ...h.deps });
  assert.equal(r.ok, false);
  assert.deepEqual([h.calls.get, h.calls.del, h.calls.clear], [[], [], []]);
});

test('--send-to combined with --recreate-draft is refused with zero calls', async () => {
  const h = harness();
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: false, sendTo: 'a@example.com', ...h.deps });
  assert.equal(r.ok, false);
  assert.match(r.reason, /--send-to/);
  assert.deepEqual([h.calls.get, h.calls.del, h.calls.clear], [[], [], []]);
});

test('failed DELETE: refused, tracker not cleared when nothing was deleted', async () => {
  const h = harness({ deleteRes: { statusCode: 500, body: 'boom' } });
  const r = await runRecreateDraft({ ...base, sentShows: sentShows(), dryRun: false, ...h.deps });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not delete old draft d1 \(500/);
  assert.deepEqual(h.calls.clear, []);
});

test('failed DELETE after an earlier one succeeded: only the deleted draft\'s records are cleared', async () => {
  const keyB = 'west-end:other-show';
  const recA = { ...draftRec, draftId: 'dA' };
  const recB = { ...draftRec, draftId: 'dB', broadcastKey: keyB };
  const shows = { [KEY]: recA, [keyB]: recB };
  const calls = { del: [], clear: [] };
  const r = await runRecreateDraft({
    ...base, sentShows: shows, dryRun: false, showIds: [SHOW, 'other-show'], log: () => {},
    getBroadcast: async () => ({ ok: true, data: { status: 'draft' } }),
    deleteBroadcast: async (id) => { calls.del.push(id); return id === 'dA' ? { statusCode: 200, body: '' } : { statusCode: 500, body: 'x' }; },
    clearEntries: (keys) => calls.clear.push(keys),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.del, ['dA', 'dB']);
  assert.deepEqual(calls.clear, [[KEY]]);
});

test('wiring: main() hands its --dry-run flag to the flow and has no other draft DELETE', () => {
  const src = readFileSync(new URL('../../scripts/send-opening-night-broadcast.js', import.meta.url), 'utf8');
  assert.match(src, /runRecreateDraft\(\{[^}]*?dryRun: DRY_RUN,/, 'main() must pass dryRun: DRY_RUN');
  assert.equal((src.match(/runRecreateDraft\(/g) || []).length, 1, 'exactly one recreate path');
  assert.doesNotMatch(src, /method:\s*['"]DELETE['"]/, 'no raw DELETE request in the script');
  assert.match(src, /const DRY_RUN = process\.argv\.includes\('--dry-run'\)/, 'DRY_RUN must come from --dry-run');
  const deletes = src.match(/\bdeleteBroadcast\(/g) || [];
  assert.equal(deletes.length, 1, 'only the injected wrapper in the recreate block may call deleteBroadcast()');
});
