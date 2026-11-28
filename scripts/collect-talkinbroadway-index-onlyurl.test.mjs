// BRO-7262: the single-page mode of the Talkin' Broadway collector must refuse
// half-given or off-site input before it spends a Browserbase session.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-talkinbroadway-index.js');
const run = (...a) => spawnSync('node', [script, ...a], { encoding: 'utf8', env: { ...process.env, BROWSERBASE_API_KEY: '', BROWSERBASE_PROJECT_ID: '' } });

describe('collect-talkinbroadway-index --only-url guard', () => {
  it('needs --show and --only-url together', () => {
    assert.equal(run('--show=x').status, 2);
    assert.equal(run('--only-url=https://www.talkinbroadway.com/page/a/b.html').status, 2);
  });
  it('refuses a URL that is not a talkinbroadway.com review page', () => {
    for (const u of ['http://www.talkinbroadway.com/page/a.html', 'https://evil.example/page/a.html', 'https://www.talkinbroadway.com/other/a.html']) {
      const r = run('--show=x', `--only-url=${u}`);
      assert.equal(r.status, 2, u);
      assert.match(r.stderr, /only-url must be/);
    }
  });
  it('a valid pair passes the guard (then stops: no Browserbase key here)', () => {
    const r = run('--show=x', '--only-url=https://www.talkinbroadway.com/page/regional/chicago/ch944.html');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no BROWSERBASE_API_KEY/);
  });
});
