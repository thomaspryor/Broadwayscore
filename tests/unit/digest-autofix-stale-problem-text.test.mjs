import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshDigestDispatchBrief } from '../../scripts/lib/digest-dispatch-freshness.js';

function card(overrides = {}) {
  return {
    id: 'issue-354', identifier: 'BRO-354', title: 'BSC Daily: Push-retry deadman',
    description: 'PARKED: Auto-filed by digest-autofix\n\n## Problem\nCannot measure push-retry failures: local ledger absent.\n\n## Acceptance criteria\n`node scripts/check-health-row-absent.js --row-b64 UHVzaC1yZXRyeSBkZWFkbWFu`',
    comments: { nodes: [] }, ...overrides,
  };
}

function deps(overrides = {}) {
  const comments = [];
  return {
    comments,
    probeRow: async name => ({
      verdict: 'present', generatedAt: '2026-10-26T12:00:00.000Z',
      matched: { name, status: 'warn', message: '222 failures across 30 workflows in the last 7d.' },
    }),
    createComment: async (id, body) => comments.push({ id, body }),
    ...overrides,
  };
}

test('changed failure category is commented and returned for the worker prompt, without changing the card', async () => {
  const issue = card();
  const before = structuredClone(issue);
  const io = deps();
  const brief = await refreshDigestDispatchBrief(issue, io);
  assert.deepEqual(issue, before);
  assert.equal(io.comments.length, 1);
  assert.equal(io.comments[0].id, issue.id);
  assert.equal(io.comments[0].body, brief);
  assert.match(brief, /222 failures across 30 workflows/);
  assert.match(brief, /2026-10-26T12:00:00.000Z/);
  assert.match(brief, /obsolete failure mode/);
});

test('unchanged failure evidence needs no comment but still reaches the worker', async () => {
  const io = deps();
  const brief = await refreshDigestDispatchBrief(card({ description: 'PARKED: Auto-filed by digest-autofix\n\n## Problem\n222 failures across 30 workflows in the last 7d.' }), io);
  assert.match(brief, /222 failures/);
  assert.equal(io.comments.length, 0);
});

test('a recovered row is flagged as absent rather than dispatching the old failure as current', async () => {
  const io = deps({ probeRow: async () => ({ verdict: 'absent', matched: { status: 'pass', message: 'No failures.' } }) });
  const brief = await refreshDigestDispatchBrief(card(), io);
  assert.match(brief, /Live verdict: absent; status: pass/);
  assert.equal(io.comments.length, 1);
});

test('credential skips are explicitly unverifiable and retain the actual skip message', async () => {
  const io = deps({ probeRow: async () => ({ verdict: 'unknown', matched: { message: 'Skipped: cannot fetch durable ledger in read-only mode.' } }) });
  const brief = await refreshDigestDispatchBrief(card(), io);
  assert.match(brief, /Cannot verify the current row/);
  assert.match(brief, /Skipped: cannot fetch durable ledger/);
  assert.doesNotMatch(brief, /Live verdict: absent/);
  assert.equal(io.comments.length, 1);
});

test('probe errors flag uncertainty without leaking request details', async () => {
  const io = deps({ probeRow: async () => { throw new Error('credential-bearing-request'); } });
  const brief = await refreshDigestDispatchBrief(card(), io);
  assert.match(brief, /Cannot verify/);
  assert.doesNotMatch(brief, /credential-bearing-request/);
  assert.equal(io.comments.length, 1);
});

test('a failed comment does not prevent current evidence from reaching the worker', async () => {
  const logs = [];
  const io = deps({ createComment: async () => { throw new Error('credential-bearing-request'); }, log: msg => logs.push(msg) });
  assert.match(await refreshDigestDispatchBrief(card(), io), /222 failures/);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /credential-bearing-request/);
});

test('retries deduplicate unchanged evidence independently of measurement time', async () => {
  const io = deps();
  const first = await refreshDigestDispatchBrief(card(), io);
  const next = deps({ probeRow: async () => ({ ...(await io.probeRow('Push-retry deadman')), generatedAt: '2026-10-27T12:00:00.000Z' }) });
  await refreshDigestDispatchBrief(card({ comments: { nodes: [{ body: first, createdAt: '2026-10-26T12:00:00.000Z' }] } }), next);
  assert.equal(next.comments.length, 0);
});

test('the newest measurement wins even when an older comment matches the current state', async () => {
  const io = deps();
  const original = await refreshDigestDispatchBrief(card(), io);
  const recovered = deps({ probeRow: async () => ({ verdict: 'absent', matched: { status: 'pass', message: 'No failures.' } }) });
  const recovery = await refreshDigestDispatchBrief(card(), recovered);
  const again = deps();
  await refreshDigestDispatchBrief(card({ comments: { nodes: [
    { body: recovery, createdAt: '2026-10-27T00:00:00Z' },
    { body: original, createdAt: '2026-10-26T00:00:00Z' },
  ] } }), again);
  assert.equal(again.comments.length, 1, 'a recurrence after recovery needs a new comment');
});

test('ordinary cards and canaries do not trigger any probe or mutation', async () => {
  for (const title of ['Fix push contention', 'CANARY: touch a marker', 'BSC Daily: ']) {
    const io = deps({ probeRow: () => assert.fail('unexpected probe'), createComment: () => assert.fail('unexpected comment') });
    assert.equal(await refreshDigestDispatchBrief(card({ title }), io), '');
  }
  assert.equal(await refreshDigestDispatchBrief(card({ description: 'Auto-filed START-NOW card' }), {
    probeRow: () => assert.fail('unparked cards must not probe'),
    createComment: () => assert.fail('unparked cards must not comment'),
  }), '');
});

test('owner-alert-router cards without a row-b64 command are checked using their BSC Daily row name', async () => {
  const io = deps({ probeRow: async name => {
    assert.equal(name, 'Sync: cast coverage');
    return { verdict: 'unknown', matched: null };
  } });
  assert.match(await refreshDigestDispatchBrief(card({ title: 'BSC Daily: Sync: cast coverage', description: 'PARKED: Auto-filed by owner-alert-router' }), io), /Cannot verify/);
});
