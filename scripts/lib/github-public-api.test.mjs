import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ghApiJson, isGhAuthError, normalizeRunsPage } = require('./github-public-api.js');
const API_PATH = 'repos/thomaspryor/Broadwayscore/actions/workflows/test.yml/runs?per_page=100&page=2&branch=main&created=%3E%3D2026-10-12';
const authError = () => Object.assign(new Error('gh failed'), { stderr: 'please run: gh auth login' });

test('authenticated gh keeps its jq shape and never calls the public API', () => {
  const calls = [];
  const result = ghApiJson(API_PATH, {
    jq: '.workflow_runs',
    exec: (...args) => { calls.push(args); return '[{"id":12}]'; },
    mapRest: () => assert.fail('fallback must not run'),
  });
  assert.deepEqual(result, [{ id: 12 }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['api', API_PATH, '--jq', '.workflow_runs']);
});

test('only auth failures and a missing gh warrant the fallback', () => {
  for (const err of [authError(), { code: 'ENOENT' }, { message: 'GH_TOKEN environment variable' }]) {
    assert.equal(isGhAuthError(err), true);
  }
  for (const message of ['HTTP 403 rate limit exceeded', 'HTTP 404', 'HTTP 500', 'bad credentials']) {
    const err = new Error(message);
    let calls = 0;
    assert.throws(() => ghApiJson(API_PATH, { exec: () => { calls++; throw err; } }), e => e === err);
    assert.equal(calls, 1);
  }
});

test('malformed authenticated JSON never triggers a public retry', () => {
  let calls = 0;
  assert.throws(() => ghApiJson(API_PATH, { exec: () => { calls++; return 'invalid'; } }), SyntaxError);
  assert.equal(calls, 1);
});

test('public response normalization preserves all jq fields and missing/empty distinctions', () => {
  const row = { id: 12, head_sha: 'abc', created_at: 'created', updated_at: 'updated', run_started_at: 'started', conclusion: 'failure', status: 'completed' };
  assert.deepEqual(normalizeRunsPage({ total_count: 1, workflow_runs: [row] }), {
    total: 1, runs: [{ databaseId: 12, headSha: 'abc', createdAt: 'created', updatedAt: 'updated', runStartedAt: 'started', conclusion: 'failure', status: 'completed' }],
  });
  assert.deepEqual(normalizeRunsPage({ total_count: 0, workflow_runs: [] }), { total: 0, runs: [] });
  assert.equal(normalizeRunsPage({}).runs, null);
});

test('auth-free child fetch preserves the exact path, proxy and CA settings with bounded timeouts', () => {
  const env = { PATH: process.env.PATH, HOME: '/tmp/empty-home', HTTPS_PROXY: 'http://localhost:1234', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' };
  let calls = 0;
  const result = ghApiJson(API_PATH, {
    env, mapRest: normalizeRunsPage,
    exec: (cmd, args, options) => {
      if (++calls === 1) throw authError();
      assert.equal(cmd, process.execPath);
      assert.equal(args.at(-1), `https://api.github.com/${API_PATH}`);
      assert.equal(options.env.NODE_USE_ENV_PROXY, '1');
      assert.equal(options.env.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.timeout, 60000);
      return '{"total_count":0,"workflow_runs":[]}';
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { total: 0, runs: [] });
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
});

test('the real fallback child sends no authorization and fails closed on HTTP/JSON errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5715-api-'));
  const preload = path.join(dir, 'fetch.cjs');
  try {
    for (const status of [200, 403, 404, 500, 'malformed']) {
      fs.writeFileSync(preload, `globalThis.fetch = async (url, opts) => {
        if (url !== ${JSON.stringify(`https://api.github.com/${API_PATH}`)}) throw Error('wrong URL');
        if (opts.headers.Authorization || opts.headers.authorization) throw Error('unexpected authorization');
        if (!opts.signal) throw Error('missing timeout');
        return { ok: ${status === 200 || status === 'malformed'}, status: ${JSON.stringify(status)}, json: async () => {
          ${status === 'malformed' ? "throw Error('invalid JSON')" : 'return { total_count: 0, workflow_runs: [] }'};
        } };
      };`);
      const exec = (cmd, args, options) => {
        if (cmd === 'gh') throw Object.assign(new Error('missing gh'), { code: 'ENOENT' });
        return execFileSync(cmd, ['--require', preload, ...args], options);
      };
      const run = () => ghApiJson(API_PATH, { exec, env: { PATH: process.env.PATH, HOME: dir }, mapRest: normalizeRunsPage });
      if (status === 200) assert.deepEqual(run(), { total: 0, runs: [] });
      else assert.throws(run, err => String(err.stderr).includes(status === 'malformed' ? 'invalid JSON' : `HTTP ${status}`));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
