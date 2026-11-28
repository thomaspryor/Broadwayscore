import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();

test('unmatched import writer requests minimal return and REST sends it', async t => {
  const source = fs.readFileSync(new URL('../../src/app/my-shows/ImportShows.tsx', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/supabaseRestInsert\(\s*'unmatched_imports'[\s\S]*?\.catch\(/g)];
  assert.ok(calls.length, 'unmatched import writer exists');
  for (const call of calls) assert.match(call[0], /returning:\s*'minimal'/);

  const originalLoad = Module._load;
  const requests = [];
  const client = { auth: {
    getUser: async () => ({ data: { user: { id: 'user' } }, error: null }),
    getSession: async () => ({ data: { session: { access_token: 'token' } } }),
  } };
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === './supabase') return { getSupabaseClient: async () => client };
    if (name === './deferred-auth') return { clearPendingAction() {} };
    if (name === './ugc-analytics') return {
      reportUgcError() {},
      instrumentedFetch: async (url, options) => {
        requests.push({ url, ...options });
        return options.headers.Prefer === 'return=minimal'
          ? new Response(null, { status: 201 })
          : new Response(JSON.stringify({ code: '42501', message: 'row-level security' }), { status: 403 });
      },
    };
    return originalLoad.call(this, name, ...args);
  });
  const path = require.resolve('../../src/lib/supabase-rest.ts');
  delete require.cache[path];
  const rest = require(path);
  loader.mock.restore();
  for (const title of ['A', 'B', 'C']) {
    assert.deepEqual(await rest.supabaseRestInsert('unmatched_imports', { title }, { returning: 'minimal' }), { data: null, error: null });
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.url.endsWith('/rest/v1/unmatched_imports') && r.headers.Prefer === 'return=minimal'));
});
