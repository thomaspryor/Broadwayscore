import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refreshSearchLandings } = require('../../scripts/lib/seo-search-landings.js');
const env = { POSTHOG_PERSONAL_API_KEY: 'test-key', POSTHOG_PROJECT_ID: '123' };

function destination(t) {
  const dir = mkdtempSync(path.join(process.cwd(), '.tmp-seo-search-landings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputFile = path.join(dir, 'landings.json');
  const previous = '{"generated":"2026-09-01","windowDays":90,"paths":["/show/hamilton-2015"]}\n';
  writeFileSync(outputFile, previous);
  return { outputFile, previous };
}

test('refresh queries 90 days of search entry sessions and writes the JSON snapshot', async t => {
  const { outputFile } = destination(t);
  let calls = 0;
  const out = await refreshSearchLandings({
    env, outputFile, now: new Date('2026-10-29T12:00:00Z'),
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'https://us.posthog.com/api/projects/123/query/');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      const { query } = JSON.parse(options.body);
      assert.equal(query.kind, 'HogQLQuery');
      assert.match(query.query, /select \$entry_pathname, count\(\) c from sessions/);
      assert.match(query.query, /\$start_timestamp > now\(\) - interval 90 day/);
      for (const engine of ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave', 'baidu', 'yandex']) {
        assert.ok(query.query.includes(`$entry_referring_domain like '%${engine}%'`));
      }
      assert.match(query.query, /group by 1 order by c desc limit 100000$/);
      return { ok: true, json: async () => ({ results: [
        ['/show/hamilton-2015/', 5], ['/critics/jesse-green', 3],
        ['/cast/aaron-tveit///', 2], ['/show/hamilton-2015', 1],
        ['/', 4], ['/browse', 2], ['/showcase/no', 2], [null, 1], ['', 1],
      ] }) };
    },
  });
  assert.equal(calls, 1);
  const contents = readFileSync(outputFile, 'utf8');
  assert.ok(contents.endsWith('\n'));
  assert.deepEqual(JSON.parse(contents), out);
  assert.deepEqual(out, {
    generated: '2026-10-29', windowDays: 90,
    paths: ['/cast/aaron-tveit', '/critics/jesse-green', '/show/hamilton-2015'],
  });
});

test('a new successful window replaces paths from the previous snapshot', async t => {
  const { outputFile } = destination(t);
  await refreshSearchLandings({ env, outputFile,
    fetch: async () => ({ ok: true, json: async () => ({ results: [['/show/wicked-2003', 1]] }) }),
  });
  assert.deepEqual(JSON.parse(readFileSync(outputFile, 'utf8')).paths, ['/show/wicked-2003']);
});

test('missing credentials fail before fetching and preserve the last snapshot', async t => {
  const { outputFile, previous } = destination(t);
  for (const missing of ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID']) {
    await assert.rejects(refreshSearchLandings({
      env: { ...env, [missing]: '' }, outputFile,
      fetch: async () => assert.fail('must not fetch without both credentials'),
    }), /not set/);
    assert.equal(readFileSync(outputFile, 'utf8'), previous);
  }
});

test('HTTP and transport failures preserve the last snapshot', async t => {
  const { outputFile, previous } = destination(t);
  for (const status of [401, 429, 503]) {
    await assert.rejects(refreshSearchLandings({ env, outputFile,
      fetch: async () => ({ ok: false, status, json: async () => assert.fail('must not parse failed response') }),
    }), new RegExp(`PostHog ${status}`));
    assert.equal(readFileSync(outputFile, 'utf8'), previous);
  }
  await assert.rejects(refreshSearchLandings({ env, outputFile,
    fetch: async () => { throw new Error('request timed out'); },
  }), /request timed out/);
  assert.equal(readFileSync(outputFile, 'utf8'), previous);
});

test('empty, unrelated and malformed results preserve the last snapshot', async t => {
  const { outputFile, previous } = destination(t);
  for (const body of [{ results: [] }, {}, { results: [['/browse', 1]] }, { results: 'invalid' }]) {
    await assert.rejects(refreshSearchLandings({ env, outputFile,
      fetch: async () => ({ ok: true, json: async () => body }),
    }));
    assert.equal(readFileSync(outputFile, 'utf8'), previous);
  }
  await assert.rejects(refreshSearchLandings({ env, outputFile,
    fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }),
  }), /invalid JSON/);
  assert.equal(readFileSync(outputFile, 'utf8'), previous);
});
