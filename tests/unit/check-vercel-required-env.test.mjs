import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// require() the real modules, never copies (CLAUDE.md rule 15).
const { RUNTIME_ENV, requiredNames, checkEnv, scanApiRouteEnv } = require('../../scripts/lib/check-vercel-required-env.js');
const { parseEnvFile } = require('../../scripts/lib/load-env.js');
const { planUpsert, parseNames } = require('../../scripts/lib/sync-vercel-env.js');
const { pageTitle } = require('../../scripts/lib/probe-dispatch-link.js');

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('every process.env name a listed route reads is declared required or optional', () => {
  for (const [file, { required, optional }] of Object.entries(RUNTIME_ENV)) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const read = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]);
    assert.ok(read.length > 0, `${file} reads no env; drop it from RUNTIME_ENV`);
    for (const name of read) {
      assert.ok(required.includes(name) || optional.includes(name),
        `${file} reads process.env.${name} but RUNTIME_ENV does not list it`);
    }
  }
});

test('autonomous-action needs both the HMAC secret and the Linear key (BRO-5170)', () => {
  assert.deepEqual(requiredNames(), ['APPROVAL_HMAC_SECRET', 'GH_DISPATCH_TOKEN', 'GMAIL_CLIENT_ID', 'LINEAR_API_KEY']);
  assert.deepEqual(RUNTIME_ENV['src/app/api/autonomous-action/route.ts'].required, ['APPROVAL_HMAC_SECRET', 'LINEAR_API_KEY']);
});

test('the BRO-5170 state (no LINEAR_API_KEY line) is reported missing', () => {
  const env = parseEnvFile('APPROVAL_HMAC_SECRET="abc"\nGH_DISPATCH_TOKEN="g"\nGMAIL_CLIENT_ID="c"\nNEXT_PUBLIC_FEATURES="x"\n');
  assert.deepEqual(checkEnv(env, requiredNames()), { missing: ['LINEAR_API_KEY'], empty: [] });
});

test('a sensitive var pulled with an empty value counts as present', () => {
  const env = parseEnvFile('APPROVAL_HMAC_SECRET=""\nGH_DISPATCH_TOKEN="g"\nGMAIL_CLIENT_ID="c"\nLINEAR_API_KEY="lin_api_x"\n');
  assert.deepEqual(checkEnv(env, requiredNames()), { missing: [], empty: ['APPROVAL_HMAC_SECRET'] });
});

test('sync patches an existing production entry and keeps its id', () => {
  const existing = [
    { id: 'e1', key: 'LINEAR_API_KEY', target: ['preview'] },
    { id: 'e2', key: 'LINEAR_API_KEY', target: ['production', 'preview'] },
  ];
  assert.deepEqual(planUpsert(existing, 'LINEAR_API_KEY', 'v'), { action: 'patch', id: 'e2', body: { value: 'v' } });
});

test('sync creates a production entry when only a preview one exists', () => {
  const plan = planUpsert([{ id: 'e1', key: 'LINEAR_API_KEY', target: ['preview'] }], 'LINEAR_API_KEY', 'v');
  assert.equal(plan.action, 'create');
  assert.deepEqual(plan.body.target, ['production']);
});

test('sync only accepts allowlisted names', () => {
  assert.deepEqual(parseNames([]), ['LINEAR_API_KEY']);
  assert.deepEqual(parseNames(['--names=LINEAR_API_KEY']), ['LINEAR_API_KEY']);
  assert.throws(() => parseNames(['--names=VERCEL_TOKEN']), /allowlist/);
  assert.throws(() => parseNames(['--names=PATH']), /allowlist/);
});

test('probe reads the route page title', () => {
  assert.equal(pageTitle('<html><title>Configuration Error - Broadway Scorecard</title>'), 'Configuration Error');
  assert.equal(pageTitle('<title>Already Being Fixed - Broadway Scorecard</title>'), 'Already Being Fixed');
});

test('the API-route scan finds the autonomous-action names', () => {
  const found = scanApiRouteEnv(root);
  assert.ok(found.LINEAR_API_KEY?.has('src/app/api/autonomous-action/route.ts'));
  assert.ok(found.APPROVAL_HMAC_SECRET);
});
