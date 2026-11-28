// BRO-3493: opening-night broadcast durability (gap 1) and TOCTOU (gap 2).
// Every assertion runs the real functions send-opening-night-broadcast.js
// calls: upsertBroadcastDraft (Resend as dedup record), buildBroadcastName,
// draftLockRecheckBlockReason and refreshTrackerUnderLock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { upsertBroadcastDraft, makeResendRequest, RESEND_BROADCASTS_URL, RESEND_BROADCASTS_LIST_URL } = require('../../scripts/lib/resend-draft-upsert.js');
const { draftLockRecheckBlockReason } = require('../../scripts/lib/broadcast-lock-recheck.js');
const mod = require('../../scripts/send-opening-night-broadcast.js');
const { buildBroadcastName, refreshTrackerUnderLock, SENT_PATH } = mod;

function fakeResend(store) {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ method: opt.method, url });
    const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (opt.method === 'GET' && url === RESEND_BROADCASTS_LIST_URL) return ok({ data: store });
    if (opt.method === 'POST' && url === RESEND_BROADCASTS_URL) {
      const b = { id: `bc_${store.length + 1}`, status: 'draft', ...body };
      store.push(b);
      return ok({ id: b.id });
    }
    if (opt.method === 'PATCH') {
      const id = url.split('/').pop();
      Object.assign(store.find((b) => b.id === id), body);
      return ok({ id });
    }
    throw new Error(`unexpected ${opt.method} ${url}`);
  };
  return { calls, request: makeResendRequest('re_test', fetchImpl) };
}

const shows = [{ showId: 'giant-2026', showTitle: 'Giant' }];
const { OPENING_NIGHT_IGNORE_STATUSES: OPENING_NIGHT_IGNORE } = require('../../scripts/send-opening-night-broadcast.js');

// ── Gap 1: a run that dies after creating the draft but before its tracker
// write is committed (GHA: the commit step comes later) ──────────────────────

test('gap 1: run B finds the draft run A created but never tracked, and updates it instead of duplicating', async () => {
  const store = [];
  const name = buildBroadcastName('Broadway Scorecard', shows);
  const a = fakeResend(store);
  const first = await upsertBroadcastDraft({ payload: { name, html: 'v1' }, request: a.request, ignoreStatuses: OPENING_NIGHT_IGNORE });
  assert.equal(first.action, 'created');
  // Runner A is cancelled here: tracker never committed, so run B sees the
  // show as pending and reaches draft creation again.
  const b = fakeResend(store);
  const second = await upsertBroadcastDraft({ payload: { name, html: 'v2' }, request: b.request, ignoreStatuses: OPENING_NIGHT_IGNORE });
  assert.equal(second.action, 'updated');
  assert.equal(second.id, first.id);
  assert.equal(store.length, 1, 'exactly one draft in Resend');
  assert.equal(b.calls.filter((c) => c.method === 'POST').length, 0);
});

test('gap 1: a broadcast already sent under this name is adopted, never re-drafted', async () => {
  const name = buildBroadcastName('Broadway Scorecard', shows);
  const store = [{ id: 'bc_sent', name, status: 'sent' }];
  const r = fakeResend(store);
  const out = await upsertBroadcastDraft({ payload: { name }, request: r.request, ignoreStatuses: OPENING_NIGHT_IGNORE });
  assert.equal(out.action, 'skipped-sent');
  assert.equal(out.sentStatus, 'sent');
  assert.equal(store.length, 1);
});

test('gap 1: a cancelled broadcast does not block the re-queued show from a fresh draft', async () => {
  const name = buildBroadcastName('Broadway Scorecard', shows);
  const store = [{ id: 'bc_old', name, status: 'cancelled' }];
  const r = fakeResend(store);
  const out = await upsertBroadcastDraft({ payload: { name }, request: r.request, ignoreStatuses: OPENING_NIGHT_IGNORE });
  assert.equal(out.action, 'created');
  assert.notEqual(out.id, 'bc_old');
});

// ── Gap 2: eligibility read before the lock, re-checked after it ─────────────

test('gap 2: a show another run drafted while we waited for the lock is blocked', () => {
  const fresh = { 'giant-2026': { completed: true, draftStatus: 'draft', draftId: 'bc_9', draftCreatedAt: new Date().toISOString() } };
  assert.match(draftLockRecheckBlockReason(fresh, ['giant-2026']), /drafted by another run \(draft bc_9\)/);
});

test('gap 2: no record, or a cancelled record old enough to re-queue, proceeds', () => {
  assert.equal(draftLockRecheckBlockReason({}, ['giant-2026']), null);
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const fresh = { 'giant-2026': { completed: true, draftStatus: 'cancelled', draftCreatedAt: old } };
  assert.equal(draftLockRecheckBlockReason(fresh, ['giant-2026']), null);
});

test('gap 2: a discarded show is blocked', () => {
  const fresh = { 'giant-2026': { completed: false, discardedAt: '2026-10-01T00:00:00Z' } };
  assert.match(draftLockRecheckBlockReason(fresh, ['giant-2026']), /discarded/);
});

test('gap 2: --recreate-draft skips the drafted check but a send stays final', () => {
  const drafted = { 'giant-2026': { completed: true, draftStatus: 'draft', draftId: 'bc_9', draftCreatedAt: new Date().toISOString() } };
  assert.equal(draftLockRecheckBlockReason(drafted, ['giant-2026'], { recreate: true }), null);
  const sent = {
    'giant-2026': { completed: true, draftStatus: 'sent', draftId: 'bc_9' },
    'broadway:giant-2026': { completed: true, draftStatus: 'sent', draftId: 'bc_9' },
  };
  assert.match(draftLockRecheckBlockReason(sent, ['giant-2026'], { recreate: true }), /sent by another run/);
});

test('gap 2: refreshTrackerUnderLock folds in what another run wrote while we waited', () => {
  const now = new Date().toISOString();
  const onDisk = { shows: {
    'giant-2026': { completed: true, draftStatus: 'draft', draftId: 'bc_9', draftCreatedAt: now },
    'other-show': { completed: true, draftStatus: 'sent' },
  } };
  const stale = { shows: { 'unrelated': { completed: false } } };
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (p === SENT_PATH ? JSON.stringify(onDisk) : realRead.call(fs, p, ...rest));
  try {
    refreshTrackerUnderLock(stale);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(stale.shows['giant-2026'].draftId, 'bc_9', 'the other run\'s record is now visible');
  assert.ok(stale.shows['unrelated'], 'our own records survive');
  assert.match(draftLockRecheckBlockReason(stale.shows, ['giant-2026']), /drafted by another run/);
});

test('recordDraftCompletion accepts a draftStatus override for an adopted sent broadcast', () => {
  const realWrite = fs.writeFileSync;
  const savedGA = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true'; // sync to origin is a no-op under GHA
  fs.writeFileSync = (p, ...rest) => (p === SENT_PATH ? undefined : realWrite.call(fs, p, ...rest));
  try {
    const sentData = { shows: {} };
    const rec = mod.recordDraftCompletion(sentData, 'broadway:giant-2026', [{ showId: 'giant-2026' }], { draftId: 'bc_sent', draftStatus: 'sent' });
    assert.equal(rec.draftStatus, 'sent');
    assert.equal(rec.completed, true);
    const plain = mod.recordDraftCompletion({ shows: {} }, 'broadway:x', [], { draftId: 'd' });
    assert.equal(plain.draftStatus, 'draft', 'default unchanged');
  } finally {
    fs.writeFileSync = realWrite;
    if (savedGA === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = savedGA;
  }
});

// ── BRO-3493 retro-review (BRO-5261) ────────────────────────────────────────

test('a revival does not adopt the earlier production\'s sent broadcast of the same title', async () => {
  const revival = [{ showId: 'our-town-2026', showTitle: 'Our Town', openingDate: '2026-10-10' }];
  const name = buildBroadcastName('Broadway Scorecard', revival);
  const store = [{ id: 'bc_old', name, status: 'sent', created_at: '2026-07-01 20:00:00.000000+00' }];
  const r = fakeResend(store);
  const out = await upsertBroadcastDraft({
    payload: { name }, request: r.request, ignoreStatuses: OPENING_NIGHT_IGNORE, notBefore: mod.broadcastNotBefore(revival),
  });
  assert.equal(out.action, 'created');
  // an orphan from THIS production (created after opening) is still reused
  const again = await upsertBroadcastDraft({
    payload: { name }, request: fakeResend(store.map((b) => (b.id === out.id ? { ...b, created_at: '2026-10-11T00:00:00Z' } : b))).request,
    ignoreStatuses: OPENING_NIGHT_IGNORE, notBefore: mod.broadcastNotBefore(revival),
  });
  assert.equal(again.action, 'updated');
});

test('broadcastNotBefore is a day before the earliest opening, null without dates', () => {
  assert.equal(mod.broadcastNotBefore([{ openingDate: '2026-10-10' }, { openingDate: '2026-10-08' }]), '2026-10-07T00:00:00.000Z');
  assert.equal(mod.broadcastNotBefore([{}]), null);
});

test('every Resend request carries a timeout signal', async () => {
  let seen;
  const req = makeResendRequest('re_test', async (url, opt) => { seen = opt.signal; return { ok: true, status: 200, text: async () => '{}' }; });
  await req('GET', RESEND_BROADCASTS_LIST_URL);
  assert.ok(seen instanceof AbortSignal);
});
