// BRO-4631: every edge function must be deployed with platform JWT
// verification on. Static checks always run; the live probe runs only when
// SUPABASE_URL is set (it sends the forged token from the card).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const functions = fs.readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);
const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/supabase-functions.yml'), 'utf8');

test('every edge function sets verify_jwt = true in config.toml', () => {
  assert.ok(functions.includes('show-score-proxy'));
  for (const fn of functions) {
    const re = new RegExp(`\\[functions\\.${fn}\\]\\s*\\n\\s*verify_jwt\\s*=\\s*true`);
    assert.match(config, re, `${fn} missing verify_jwt = true`);
  }
  assert.doesNotMatch(config, /verify_jwt\s*=\s*false/);
});

test('deploy workflow never disables JWT verification', () => {
  assert.doesNotMatch(workflow, /--no-verify-jwt/);
});

test('live probe: forged unsigned JWT is rejected by the gateway', { skip: !process.env.SUPABASE_URL }, async () => {
  const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/show-score-proxy`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.invalid',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ slug: 'x' }),
  });
  assert.equal(res.status, 401);
});
