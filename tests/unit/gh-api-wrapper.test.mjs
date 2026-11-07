// BRO-134: gh-api-wrapper.sh ledger + gh-api-client.js + direct-call scanner.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '../..');
// Isolate the ledger BEFORE the client is used: wrapper.sh writes under $HOME.
const HOME = mkdtempSync(join(tmpdir(), 'gh-api-test-'));
process.env.HOME = HOME;
const LEDGER = join(HOME, '.claude/gh-api-call-ledger.log');
const client = require(join(ROOT, 'scripts/lib/gh-api-client.js'));
const { scanFile, classify } = require(join(ROOT, 'scripts/lib/direct-github-api-scan.js'));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const reply = (status, body) => async () => new Response(body, { status });

test('wrapper.sh log appends a ledger line with caller, method, url', () => {
  execFileSync(join(ROOT, 'scripts/lib/gh-api-wrapper.sh'), ['log', 'unit.js', 'GET', 'https://api.github.com/x'], { env: { ...process.env, HOME } });
  assert.ok(existsSync(LEDGER));
  assert.match(readFileSync(LEDGER, 'utf8'), /unit\.js.*GET.*https:\/\/api\.github\.com\/x/);
});

test('fetchGitHubJSON logs the call, parses JSON, returns null on 204', async () => {
  globalThis.fetch = reply(200, '{"a":1}');
  assert.deepEqual(await client.fetchGitHubJSON('https://api.github.com/y', { caller: 'caller-y.js', token: 't' }), { a: 1 });
  assert.match(readFileSync(LEDGER, 'utf8'), /caller-y\.js.*https:\/\/api\.github\.com\/y/);
  globalThis.fetch = reply(204, null);
  assert.equal(await client.fetchGitHubJSON('https://api.github.com/z', { caller: 'c.js' }), null);
});

test('fetchGitHubJSON throws with status/body on non-2xx', async () => {
  globalThis.fetch = reply(403, 'rate limited');
  await assert.rejects(client.fetchGitHubJSON('https://api.github.com/q', { caller: 'c.js' }), (e) => e.status === 403 && e.body === 'rate limited');
});

test('dispatchWorkflow never throws and keeps the "<status> <body>" error shape', async () => {
  let seen;
  globalThis.fetch = async (url, o) => { seen = { url, o }; return new Response(null, { status: 204 }); };
  assert.deepEqual(await client.dispatchWorkflow({ workflow: 'w.yml', inputs: { a: '1' }, token: 't', caller: 'c', repo: 'o/r' }), { ok: true });
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches');
  assert.equal(seen.o.method, 'POST');
  assert.deepEqual(JSON.parse(seen.o.body), { ref: 'main', inputs: { a: '1' } });
  globalThis.fetch = reply(422, 'bad');
  assert.deepEqual(await client.dispatchWorkflow({ workflow: 'w.yml', token: 't', caller: 'c', repo: 'o/r' }), { ok: false, error: '422 bad' });
  globalThis.fetch = async () => { throw new Error('boom'); };
  assert.deepEqual(await client.dispatchWorkflow({ workflow: 'w.yml', token: 't', caller: 'c' }), { ok: false, error: 'boom' });
  globalThis.fetch = realFetch;
});

test('dispatchWorkflow sends the same request shape the old copies did', async () => {
  let seen;
  globalThis.fetch = async (url, o) => { seen = o; return new Response(null, { status: 204 }); };
  await client.dispatchWorkflow({ workflow: 'w.yml', token: 'tok', caller: 'dispatch-x' });
  assert.equal(seen.headers.Accept, 'application/vnd.github+json');
  assert.equal(seen.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.equal(seen.headers['User-Agent'], 'broadwayscorecard-dispatch-x');
  assert.match(seen.headers.Authorization, /tok$/);
  assert.ok(seen.signal, 'timeout signal attached');
  globalThis.fetch = realFetch;
});

test('fetchGitHubJSON: empty or invalid 2xx body returns null; hung request aborts at timeoutMs', async () => {
  globalThis.fetch = reply(200, '');
  assert.equal(await client.fetchGitHubJSON('https://api.github.com/e', { caller: 'c.js' }), null);
  globalThis.fetch = reply(200, 'not json');
  assert.equal(await client.fetchGitHubJSON('https://api.github.com/e', { caller: 'c.js' }), null);
  globalThis.fetch = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(client.fetchGitHubJSON('https://api.github.com/h', { caller: 'c.js', timeoutMs: 30 }), /timed out after 30ms/);
  assert.deepEqual(await client.dispatchWorkflow({ workflow: 'w.yml', token: 't', caller: 'c', repo: 'o/r', timeoutMs: 30 }), { ok: false, error: 'GitHub API POST https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches -> timed out after 30ms' });
  globalThis.fetch = realFetch;
});

test('scanner flags direct callers and ignores client users', () => {
  assert.equal(scanFile('a.js', 'no api here'), null);
  const direct = scanFile('b.js', 'function apiGet(u){ return fetch("https://api.github.com/"+u) }');
  assert.deepEqual(direct, { file: 'b.js', usesClient: false, helpers: ['apiGet'] });
  assert.equal(scanFile('c.js', "const {x}=require('./lib/gh-api-client.js'); // api.github.com").usesClient, true);
  const r = classify([
    { file: 'b.js', text: 'fetch("https://api.github.com/a")' },
    { file: 'new.js', text: 'fetch("https://api.github.com/b")' },
    { file: 'ok.js', text: "require('./gh-api-client.js') api.github.com" },
  ], ['b.js', 'gone.js']);
  assert.deepEqual(r, { direct: ['b.js', 'new.js'], newDirect: ['new.js'], staleBaseline: ['gone.js'] });
});
