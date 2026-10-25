/**
 * runMain: run an async CLI entry point, then ALWAYS tear down and exit.
 *
 * BRO-4623: scrape-recoupment-announcements.js printed its SUMMARY and wrote
 * its findings at 01:04 (commercial-friday run 37083591866), then sat idle
 * until the 60-minute job timeout cancelled it at 01:48 and threw the results
 * away. A Playwright browser opened by fetchPage() was never closed, and its
 * pipes kept node's event loop alive. batch-commercial-research.js hung the
 * same way every Saturday since 2026-08-26 (run 37151980535). Both scripts
 * ended with `main().catch(... process.exit(1))`, which exits on failure only.
 *
 * Usage, at the bottom of an entry point:
 *
 *   const { runMain } = require('./lib/run-main');
 *   const { cleanup } = require('./lib/scraper');
 *   if (require.main === module) runMain(main, { teardown: [cleanup] });
 *
 * Contract:
 *   - main() resolving        -> exit code process.exitCode (default 0)
 *   - main() rejecting        -> logs `FATAL <err>`, exit code 1
 *   - every teardown fn runs after main settles, in order, each bounded by
 *     teardownTimeoutMs (a hung teardown must not recreate the hang it exists
 *     to prevent); a throwing/rejecting teardown is logged and skipped
 *   - exit(code) is then called unconditionally, so a stray open handle
 *     (browser, socket, interval) can never keep the job alive
 *
 * `exit` is injectable for tests; production uses process.exit.
 */

const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runMain(main, opts = {}) {
  const teardown = Array.isArray(opts.teardown) ? opts.teardown : (opts.teardown ? [opts.teardown] : []);
  const exit = typeof opts.exit === 'function' ? opts.exit : (code) => process.exit(code);
  const teardownTimeoutMs = Number.isFinite(opts.teardownTimeoutMs) ? opts.teardownTimeoutMs : DEFAULT_TEARDOWN_TIMEOUT_MS;
  const log = opts.log || console;

  let code = 0;
  try {
    await main();
    if (typeof process.exitCode === 'number' && process.exitCode !== 0) code = process.exitCode;
  } catch (e) {
    log.error('FATAL', e);
    code = 1;
  }

  for (const fn of teardown) {
    if (typeof fn !== 'function') continue;
    try {
      const r = await withTimeout(Promise.resolve().then(fn), teardownTimeoutMs);
      if (r && r.timedOut === true) {
        log.error(`runMain: teardown ${fn.name || '(anonymous)'} did not finish in ${teardownTimeoutMs}ms; exiting anyway`);
      }
    } catch (e) {
      log.error(`runMain: teardown ${fn.name || '(anonymous)'} failed: ${e && e.message ? e.message : e}`);
    }
  }

  exit(code);
  return code;
}

module.exports = { runMain, DEFAULT_TEARDOWN_TIMEOUT_MS };
