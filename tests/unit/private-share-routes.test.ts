/**
 * Every private share route (`src/app/<prefix>/[token]`) must be listed in
 * PRIVATE_SHARE_PREFIXES, which redaction, GA switch-off and replay
 * switch-off all derive from (BRO-4566). A new share kind that forgets the
 * list would leak its tokens to every analytics tool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_SHARE_PREFIXES, isPrivateSharePath, redactPrivateShareUrl } from '../../src/lib/analytics/redact-url';

const APP = join(__dirname, '..', '..', 'src', 'app');

/** Top-level route segments that have a `[token]` child. */
function tokenRoutes(): string[] {
  return readdirSync(APP).filter(d => {
    const p = join(APP, d);
    return statSync(p).isDirectory() && existsSync(join(p, '[token]'));
  });
}

test('every src/app/*/[token] route is a listed private share prefix', () => {
  const routes = tokenRoutes();
  assert.ok(routes.includes('plans'), `expected at least /plans/[token], found ${routes.join(', ')}`);
  const missing = routes.filter(r => !(PRIVATE_SHARE_PREFIXES as readonly string[]).includes(r));
  assert.deepEqual(missing, [], `add to PRIVATE_SHARE_PREFIXES in src/lib/analytics/redact-url.ts: ${missing.join(', ')}`);
});

test('each listed prefix is actually redacted and treated as private', () => {
  const token = 'abcdefabcdefabcdefabcdefabcdef12';
  for (const p of PRIVATE_SHARE_PREFIXES) {
    assert.equal(redactPrivateShareUrl(`/${p}/${token}`), `/${p}/:token`);
    assert.ok(isPrivateSharePath(`/${p}/${token}`));
  }
});
