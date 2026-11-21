// BRO-7525: a failed JSON.parse of a credential env var echoed the secret into a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseEnvJson } = require('../lib/parse-env-json.js');
const root = path.resolve(import.meta.dirname, '..', '..');

const SECRET = 'c3VwZXItc2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1ub3QtbGVhaw'; // not valid JSON when decoded

test('parse failure names the variable and never the value', () => {
  for (const base64 of [true, false]) {
    let err;
    try { parseEnvJson('GA_SERVICE_ACCOUNT_KEY', { base64, env: { GA_SERVICE_ACCOUNT_KEY: SECRET } }); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.match(err.message, /GA_SERVICE_ACCOUNT_KEY/);
    assert.ok(!err.message.includes(SECRET) && !err.message.includes('super-secret'));
    assert.equal(err.cause, undefined);
  }
});

test('valid base64 JSON parses', () => {
  const v = Buffer.from(JSON.stringify({ a: 1 })).toString('base64');
  assert.deepEqual(parseEnvJson('K', { base64: true, env: { K: v } }), { a: 1 });
});

test('no script decodes a credential env var straight into JSON.parse', () => {
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(f.name) || /\.test\./.test(f.name) || f.name === 'parse-env-json.js') continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/Buffer\.from\(\s*process\.env\.\w*(KEY|SECRET|TOKEN|CREDENTIAL)\w*\s*,\s*['"]base64['"]/i.test(src)
        || /JSON\.parse\(\s*process\.env\.\w*(KEY|SECRET|TOKEN|CREDENTIAL)\w*\s*[),]/i.test(src)) offenders.push(path.relative(root, p));
    }
  };
  walk(path.join(root, 'scripts'));
  assert.deepEqual(offenders, [], 'use scripts/lib/parse-env-json.js');
});
