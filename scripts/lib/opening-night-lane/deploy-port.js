'use strict';
/**
 * Deploy port for the opening-night lane (BRO-6649, plan v2 Step 3).
 *
 * A lane publish used to wait for the 5-minute deploy cron, which fired hours late on Oct 29-30. Now the publish
 * dispatches vercel-deploy.yml itself with `source=lane-press-night`. vercel-deploy.yml maps any source other than
 * "land" to a plain workflow_dispatch, which should-deploy-gate.js treats as "ship now" (deduped only when HEAD is
 * live and core data has not advanced; the lane's core-data push has advanced it). The gate only decides, it cannot
 * deploy, so the explicit source value is the press-night reason and the audit trail. The dispatch is made only from a
 * leased lane publish, at most one open dispatch per show (CLAUDE.md section 2: no routine manual deploys).
 *
 * deploy() never blocks: publish.js polls the live site for the batch's URLs anyway. "In flight" means a dispatch is
 * open until the URLs it covers are seen live through observe() (fed by the cache-busted live fetch) or CEILING_MS
 * passes. A batch that arrives while one is open only queues its URLs; when the open dispatch ends, one trailing
 * dispatch goes out if any queued URL is still not live (a build already running may have pulled core data before
 * that batch's push). Waiting inside deploy() would spend the batch's 20 minute verify budget, so it does not.
 */
const { execFileSync } = require('child_process');
const { canonicalUrl } = require('./discovery');

const WORKFLOW = 'vercel-deploy.yml';
const SOURCE = 'lane-press-night';
const CEILING_MS = 13 * 60 * 1000; // a Vercel build is ~9 minutes (vercel-deploy.yml)
const MAX_DISPATCHES_PER_URL = 3; // a URL that is still not live after this many builds is not a deploy problem; the live-timeout page covers it
const EXEC_TIMEOUT_MS = 30 * 1000; // execFileSync blocks the event loop (and the lease heartbeat); never let gh hang it
const BACKOFF_MS = [5000, 15000, 45000]; // same shape as scripts/lib/dispatch-with-retry.sh (4 attempts)
// Only real rate limits retry. A 403 "Resource not accessible by integration" is a permissions error and will not clear.
const RETRYABLE = /rate.?limit|HTTP 429|secondary/i;

/** gh workflow run with the dispatch-with-retry.sh backoff on rate limits. Returns {ok, error?}. */
function ghDispatcher({ exec = execFileSync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ref = 'main' } = {}) {
  return async () => {
    let last = '';
    for (let i = 0; i <= BACKOFF_MS.length; i++) {
      try {
        exec('gh', ['workflow', 'run', WORKFLOW, '--ref', ref, '-f', `source=${SOURCE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: EXEC_TIMEOUT_MS });
        return { ok: true };
      } catch (e) {
        last = String((e && (e.stderr || e.message)) || e).slice(0, 300);
        if (!RETRYABLE.test(last) || i === BACKOFF_MS.length) break;
        await sleep(BACKOFF_MS[i]);
      }
    }
    return { ok: false, error: last };
  };
}

/**
 * @param {{show:string, night?:string, dispatch:()=>Promise<{ok:boolean,error?:string}>, page?:(o:object)=>any,
 *          now?:()=>number, ceilingMs?:number, log?:(m:string)=>void}} o
 */
function createDeployPort({ show, night, dispatch, page, now = () => Date.now(), ceilingMs = CEILING_MS, log = (m) => console.warn(m) } = {}) {
  if (!show || typeof dispatch !== 'function') throw new Error('deploy-port: show and dispatch are required');
  let open = null; // {at, urls:Set, pending:boolean}; pending = the dispatch call itself is still running
  let queued = new Set(); // URLs from batches that arrived while a dispatch was open, or whose dispatch failed
  const attempts = new Map(); // url -> dispatches that covered it
  const dispatches = [];
  let running = Promise.resolve();

  const pageSafe = async (title, description) => {
    if (!page) return;
    try { await page({ conditionKey: `lane-deploy-dispatch:${show}:${night || 'night'}`, disposition: 'digest', title, description }); } catch (e) { log(`deploy-port: page failed (${String((e && e.message) || e).slice(0, 120)})`); } // paging must not break a publish
  };

  /** Start a dispatch for `urls`. `open` is set before the call so an overlapping batch queues instead of dispatching too. */
  function fire(urls) {
    const cover = new Set([...urls].filter((u) => (attempts.get(u) || 0) < MAX_DISPATCHES_PER_URL));
    if (!cover.size) return { dispatched: false, reason: urls.size ? 'dispatch cap per URL reached; the cron and the live-timeout page cover it' : 'nothing landed' };
    for (const u of cover) attempts.set(u, (attempts.get(u) || 0) + 1);
    const slot = { at: now(), urls: cover, pending: true };
    open = slot;
    running = running.then(async () => {
      let res;
      try { res = await dispatch(); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      dispatches.push({ at: now(), urls: [...cover], ok: !!(res && res.ok) });
      if (res && res.ok) { slot.pending = false; slot.at = now(); log(`deploy dispatched (${cover.size} url(s))`); return; }
      if (open === slot) open = null;
      for (const u of cover) queued.add(u); // a failed dispatch still counts toward the per-URL cap, so the retry on the next batch or poll is bounded
      await pageSafe(`Lane deploy dispatch failed for ${show}`, `gh workflow run ${WORKFLOW} failed: ${(res && res.error) || 'unknown'}. The 5-minute deploy cron still ships the data; the live poll keeps running.`);
    });
    return { dispatched: true };
  }

  const expired = () => open && !open.pending && now() - open.at >= ceilingMs;

  function closeAndMaybeTrail(liveSet) {
    open = null;
    const rest = new Set([...queued].filter((u) => !(liveSet && liveSet.has(u))));
    queued = new Set();
    return rest.size ? fire(rest) : null;
  }

  return {
    /** Never blocks on the dispatch or the build. */
    deploy({ expectedUrls = [], night: n } = {}) {
      if (n) night = n;
      const urls = new Set(expectedUrls.map(canonicalUrl).filter(Boolean));
      if (expired()) { for (const u of open.urls) queued.add(u); closeAndMaybeTrail(null); }
      if (open) { for (const u of urls) queued.add(u); return { dispatched: false, coalesced: true }; }
      const all = new Set([...urls, ...queued]); queued = new Set();
      return fire(all);
    },
    /** Called with the live show doc after every cache-busted fetch. */
    observe(doc) {
      const live = new Set(((doc && doc.rv) || []).map((x) => canonicalUrl(x && x.u)).filter(Boolean));
      if (!open) { // a failed dispatch left URLs queued: retry them on the next poll while they are still not live
        if ([...queued].some((u) => !live.has(u))) closeAndMaybeTrail(live);
        return;
      }
      if (open.pending) return;
      if ([...open.urls].every((u) => live.has(u)) || expired()) {
        for (const u of open.urls) queued.add(u); // anything the open dispatch covered that is still not live goes round again
        closeAndMaybeTrail(live);
      }
    },
    /** Resolves when every dispatch started so far has finished (tests, shutdown). */
    idle: async () => { let p; do { p = running; await p; } while (p !== running); },
    isOpen: () => !!open,
    dispatches: () => dispatches.slice(),
  };
}

module.exports = { WORKFLOW, SOURCE, CEILING_MS, MAX_DISPATCHES_PER_URL, ghDispatcher, createDeployPort };
