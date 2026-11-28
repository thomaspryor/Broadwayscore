import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createAudienceRequest } = createRequire(import.meta.url)('./money-audience-request.js');

function clock() {
  let time = 0;
  const waits = [];
  const request = createAudienceRequest({
    now: () => time,
    sleep: async (ms) => { waits.push(ms); time += ms; },
  });
  return { request, waits, now: () => time };
}

test('paces General pages, money contacts, additions and unsubscribes together', async () => {
  const c = clock();
  const starts = [];
  for (const operation of ['General page 1', 'General page 2', 'money contacts', 'add', 'unsubscribe']) {
    const response = await c.request(async () => { starts.push(c.now()); return new Response(operation); });
    assert.equal(await response.text(), operation);
  }
  assert.deepEqual(starts, [0, 600, 1200, 1800, 2400]);
});

test('replays the November 2 contact-add rejection and honors Retry-After', async () => {
  const c = clock();
  let calls = 0;
  await c.request(async () => new Response('contacts'));
  const response = await c.request(async () => ++calls === 1
    ? new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
    : new Response('added'));
  assert.equal(await response.text(), 'added');
  assert.equal(calls, 2);
  assert.deepEqual(c.waits, [600, 2000]);
});

test('missing or malformed Retry-After backs off and stops after three attempts', async () => {
  for (const value of [null, 'bad', '-1', '0', 'Infinity']) {
    const c = clock();
    let calls = 0;
    const response = await c.request(async () => {
      calls++;
      return new Response('rate limited', { status: 429, headers: value === null ? {} : { 'retry-after': value } });
    });
    assert.equal(response.status, 429);
    assert.equal(await response.text(), 'rate limited');
    assert.equal(calls, 3);
    assert.deepEqual(c.waits, [1000, 2000]);
  }
});

test('a long Retry-After stops the sync without retrying early', async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(c.request(async () => {
    calls++;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
  }), /exceeds the 30-second retry budget/);
  assert.equal(calls, 1);
  assert.deepEqual(c.waits, []);
});

test('other HTTP failures and uncertain writes are never retried', async () => {
  for (const status of [401, 403, 422, 500, 503]) {
    const c = clock();
    let calls = 0;
    const response = await c.request(async () => { calls++; return new Response('failed', { status }); });
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  }
  const c = clock();
  let calls = 0;
  await assert.rejects(c.request(async () => { calls++; throw new Error('socket closed'); }), /socket closed/);
  assert.equal(calls, 1);
});
