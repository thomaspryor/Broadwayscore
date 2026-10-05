// BRO-4623: a script that fetchPage()s through Playwright and returns from
// main() without calling cleanup() used to hang until the CI job timeout
// (commercial-friday run 37083591866: done 01:04, cancelled 01:48, orphan
// chrome-headless-shell). The shared browser now closes itself after
// PLAYWRIGHT_IDLE_CLOSE_MS with no fetch in flight.
//
// Each case runs in a child process with a fake `chromium` whose browser
// holds a ref'd interval until close(), standing in for the real browser's
// pipes: exactly the handle that kept node alive in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRAPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scraper.js');

const FAKE = `
const scraper = require(${JSON.stringify(SCRAPER)});
const counts = { launches: 0, closes: 0, closedDuringFetch: 0 };
let fetching = 0;
const GOTO_MS = Number(process.env.FAKE_GOTO_MS || 0);
const LAUNCH_MS = Number(process.env.FAKE_LAUNCH_MS || 0);
const GOTO_FAIL = process.env.FAKE_GOTO_FAIL === '1';
const CLOSE_HANGS = process.env.FAKE_CLOSE_HANGS === '1';
let kills = 0;
scraper.__setChromiumForTest({
  launch: async () => {
    counts.launches++;
    if (LAUNCH_MS) await new Promise((r) => setTimeout(r, LAUNCH_MS));
    const keepAlive = setInterval(() => {}, 1000); // stands in for Chromium's pipes
    return {
      newPage: async () => ({
        goto: async () => {
          fetching++;
          try {
            await new Promise((r) => setTimeout(r, GOTO_MS));
            if (GOTO_FAIL) throw new Error('Target page, context or browser has been closed');
          } finally { fetching--; }
        },
        content: async () => '<html><body>ok</body></html>',
        close: async () => {},
      }),
      close: async () => {
        counts.closes++;
        if (fetching > 0) counts.closedDuringFetch++;
        if (CLOSE_HANGS) return new Promise(() => {}); // a wedged browser: close() never settles
        clearInterval(keepAlive);
      },
      // SIGKILL ends the real process and with it the pipes.
      process: () => ({ killed: false, kill: () => { kills++; clearInterval(keepAlive); } }),
    };
  },
});
process.on('exit', () => console.log('COUNTS ' + JSON.stringify(counts) + ' KILLS ' + kills));
const fetchOne = () => scraper.fetchWithPlaywright('http://127.0.0.1:9/article', { fast: true, skipConsentDismiss: true });
`;

function runChild(body, env, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', FAKE + body], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const m = /COUNTS (\{.*\}) KILLS (\d+)/.exec(out);
      resolve({ code, killed, ms: Date.now() - t0, out, counts: m ? JSON.parse(m[1]) : null, kills: m ? Number(m[2]) : null });
    });
  });
}

// The bug shape: main() returns with no cleanup() and no process.exit().
const RETURN_WITHOUT_CLEANUP = `
(async () => {
  const r = await fetchOne();
  console.log('fetched ' + !!(r && r.content));
})();
`;

test('a caller that never calls cleanup() still exits once the browser is idle', async () => {
  const r = await runChild(RETURN_WITHOUT_CLEANUP, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '200' }, 15000);
  assert.equal(r.killed, false, `process hung (killed after 15s):\n${r.out}`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /fetched true/);
  assert.deepEqual(r.counts, { launches: 1, closes: 1, closedDuringFetch: 0 });
});

test('control: with the idle close disabled the same caller hangs (the fake reproduces the bug)', async () => {
  const r = await runChild(RETURN_WITHOUT_CLEANUP, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '0' }, 1500);
  assert.equal(r.killed, true, `expected the BRO-4623 hang, but the child exited:\n${r.out}`);
});

test('the browser is never closed while a fetch is in flight (sequential and overlapping fetches)', async () => {
  const body = `
(async () => {
  await fetchOne();                                  // arms the idle timer
  await new Promise((r) => setTimeout(r, 30));       // well inside the idle window
  const slow = fetchOne();                           // must cancel it
  await new Promise((r) => setTimeout(r, 30));
  const fast = fetchOne();                           // overlaps the slow one
  const [a, b] = await Promise.all([slow, fast]);
  console.log('fetched ' + !!(a && a.content && b && b.content));
})();
`;
  const r = await runChild(body, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '100', FAKE_GOTO_MS: '250' }, 15000);
  assert.equal(r.killed, false, r.out);
  assert.match(r.out, /fetched true/);
  assert.equal(r.counts.closedDuringFetch, 0, r.out);
  assert.equal(r.counts.launches, 1, 'no relaunch: the idle timer never fired mid-run');
  assert.equal(r.counts.closes, 1);
});

test('cleanup() closes the browser once and cancels the pending idle close', async () => {
  const body = `
(async () => {
  await fetchOne();
  await scraper.cleanup();
  await new Promise((r) => setTimeout(r, 400));      // past the idle window
  process.exit(0);
})();
`;
  const r = await runChild(body, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '150' }, 15000);
  assert.equal(r.killed, false, r.out);
  assert.deepEqual(r.counts, { launches: 1, closes: 1, closedDuringFetch: 0 });
});

// Review finding (BRO-4623 second-opinion): two fetches that both start
// while no browser is open used to launch one browser EACH, and the last
// assignment to the shared slot won. The other browser had no reference left
// for cleanup() or the idle close, so its pipes held the process open forever.
test('concurrent first fetches share one launch, and the process still exits', async () => {
  const body = `
(async () => {
  const [a, b] = await Promise.all([fetchOne(), fetchOne()]);
  console.log('fetched ' + !!(a && a.content && b && b.content));
})();
`;
  const r = await runChild(body, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '150', FAKE_LAUNCH_MS: '200' }, 15000);
  assert.equal(r.killed, false, `process hung (an orphaned browser kept it alive):\n${r.out}`);
  assert.match(r.out, /fetched true/);
  assert.deepEqual(r.counts, { launches: 1, closes: 1, closedDuringFetch: 0 });
});

// Review finding (BRO-4623 ship-check): the failed-fetch path closed the
// shared browser with a bare `await playwright.close()`. On a wedged browser
// that close never settles, so the fetch sat there until the 90s tier
// deadline reset the browser. Every close path is now bounded at 5s.
test('a failed fetch on a wedged browser still returns, and the browser is killed', async () => {
  const body = `
(async () => {
  const r = await fetchOne();
  console.log('returned ' + (r === null ? 'null' : 'content'));
})();
`;
  const r = await runChild(body, { SCRAPER_PLAYWRIGHT_IDLE_CLOSE_MS: '0', FAKE_GOTO_FAIL: '1', FAKE_CLOSE_HANGS: '1' }, 15000);
  assert.equal(r.killed, false, `the failed fetch waited on an unbounded browser.close():\n${r.out}`);
  assert.match(r.out, /returned null/);
  assert.equal(r.counts.launches, 1);
  assert.equal(r.kills, 1, 'the hung close was ended with SIGKILL');
});
