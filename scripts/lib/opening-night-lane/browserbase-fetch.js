/**
 * The lane's Browserbase route for outlets only a real browser can read (BRO-6073).
 *
 * Talkin' Broadway sits behind a Cloudflare managed challenge that Bright Data, ScrapingBee and headless Playwright do
 * not pass from CI ("every Talkin' Broadway index failed" 59 times on 2026-10-29). collect-review-texts.js and
 * collect-talkinbroadway-index.js get it through a Browserbase session with solveCaptchas; this is the same route for
 * the lane. Only TB is routed: WSJ keeps fetchPage's free cookies tier (browserbase-route.js keeps 'direct-cookies'
 * ahead of Browserbase) and the paywall-teaser excerpt fallback (BRO-6066).
 *
 * Spend. One session is shared by every routed fetch of the process (discovery and review fetch alike, a new page per
 * fetch), created on first use and once at a time (single-flight), rotated before its timeout, at most `maxSessions`
 * per run. createBbSession is the chokepoint: kill switch, day ceiling, reserves and the lane's caller allowance
 * (browserbase-caps.js CALLER_ALLOWANCES 'opening-night-lane'). A refusal that will not change tonight (kill switch, no
 * keys, allowance used, denied host, run cap) turns the route off for the run; any other refusal or failure to create
 * or connect pauses it for `cooldownMs`. While the route is off, routed hosts go to plain fetchPage, as before.
 *
 * A 404/410 is an error with `status`, as fetchPage reports one: discovery skips a named TB page that is not filed yet,
 * and inline scoring never scores a not-found page. It is not a reason to fall back to a paid fetch. A page still behind
 * the challenge is an error with status 403 (no fallback: fetchPage fails TB the same way, slower), so inline scoring's
 * paywall-thumb fallback still applies. Any other status is content: after the challenge is solved, page.goto still
 * reports the challenge's 403 for the real page, so only verifyTbPage (or the scorer) judges it.
 */
'use strict';

const BROWSERBASE_HOSTS = Object.freeze(['talkinbroadway.com']);
const CALLER = 'opening-night-lane';
const LATCHING_REFUSAL = /kill switch|not set|caller allowance used|host denied/i;
// The allowance check refuses when it cannot count (Browserbase's list API failed): that may lift, so it only pauses.
const latches = (e) => !!(e && e.bbNoSession && LATCHING_REFUSAL.test(e.message) && !/count unknown/i.test(e.message));

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** True when the lane fetches this URL through Browserbase. */
function routesThroughBrowserbase(url) {
  const host = hostOf(url);
  return !!host && BROWSERBASE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

class BrowserbaseUnavailable extends Error {
  constructor(message) { super(message); this.name = 'BrowserbaseUnavailable'; this.bbUnavailable = true; }
}

/**
 * @param {object} p
 * @param {(opts: object) => Promise<{id: string, connectUrl: string}>} p.createSession - createBbSession
 * @param {(connectUrl: string) => Promise<import('playwright').Browser>} p.connect - chromium.connectOverCDP
 * @param {(page: object, url: string, opts?: object) => Promise<object>} p.readPage - browser-read-page.js readBrowserPage
 * @param {(sessionId: string) => Promise<void>} [p.releaseSession] - ends a created session that never got a browser
 * @param {object} [p.env] - needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID, or the route is off
 * @param {number} [p.maxSessions] - sessions this run may create
 * @param {number} [p.sessionTimeoutSec] - Browserbase session timeout; the session is replaced 5 min before it
 * @param {number} [p.fetchTimeoutMs] - one fetch, navigation and challenge wait together
 * @param {number} [p.cooldownMs] - pause after a refusal that may lift (reserve held, day cap, API error)
 */
function createBrowserbaseFetcher({
  createSession, connect, readPage, releaseSession = async () => {}, env = process.env, now = Date.now, log = () => {},
  maxSessions = 8, sessionTimeoutSec = 3600, fetchTimeoutMs = 60000, cooldownMs = 15 * 60 * 1000,
}) {
  let offReason = env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID ? null : 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set';
  let pausedUntil = 0;
  let created = 0;
  let current = null; // { browser, context, createdAt }
  let pending = null; // the in-flight create, shared by every fetch waiting on it
  const retired = new Set();
  const counts = { sessions: 0, fetches: 0, refusals: 0 };

  const available = () => !offReason && now() >= pausedUntil;
  const rotateAfterMs = (sessionTimeoutSec - Math.min(300, sessionTimeoutSec / 2)) * 1000;
  const fresh = (s) => s && s.browser.isConnected() && now() - s.createdAt < rotateAfterMs;

  async function open() {
    if (created >= maxSessions) { offReason = `run cap of ${maxSessions} sessions used`; throw new BrowserbaseUnavailable(offReason); }
    created++;
    let session;
    try {
      session = await createSession({
        caller: CALLER, purpose: 'opening-night lane Talkin Broadway fetch', host: BROWSERBASE_HOSTS[0], category: 'discovery',
        body: { timeout: sessionTimeoutSec, browserSettings: { solveCaptchas: true } },
      });
    } catch (e) {
      if (e && e.bbNoSession) created--; // refused before a session existed: it cost nothing
      counts.refusals++;
      if (latches(e)) offReason = e.message;
      else pausedUntil = now() + cooldownMs;
      log(`browserbase: no session (${e && e.message}); ${offReason ? 'off for the run' : `paused ${Math.round(cooldownMs / 60000)} min`}`);
      throw new BrowserbaseUnavailable(e && e.message);
    }
    let browser; let context;
    try {
      browser = await connect(session.connectUrl);
      context = browser.contexts()[0] || await browser.newContext();
    } catch (e) {
      // The session exists and bills until its timeout unless it is ended here.
      if (browser) browser.close().catch(() => {});
      await releaseSession(session.id).catch(() => {});
      pausedUntil = now() + cooldownMs;
      throw new BrowserbaseUnavailable(`connect failed: ${e && e.message}`);
    }
    counts.sessions++;
    const s = { browser, context, createdAt: now(), pages: 0 };
    browser.on('disconnected', () => { if (current === s) current = null; retired.delete(s); });
    log(`browserbase: session ${String(session.id).slice(0, 8)} (${created}/${maxSessions} this run)`);
    return s;
  }

  async function session() {
    if (fresh(current)) return current;
    if (current) retire(current);
    current = null;
    if (!pending) pending = open().then((s) => { current = s; return s; }).finally(() => { pending = null; });
    return pending;
  }

  /** Close a replaced session once its open pages are done (or straight away if none are). */
  function retire(s) {
    retired.add(s);
    if (!s.pages) { retired.delete(s); s.browser.close().catch(() => {}); }
  }

  async function fetch(url) {
    if (!available()) throw new BrowserbaseUnavailable(offReason || 'paused after a refusal');
    const s = await session();
    counts.fetches++;
    s.pages++;
    let page = null; let timer;
    try {
      page = await s.context.newPage();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`browserbase fetch timed out after ${fetchTimeoutMs}ms: ${url}`)), fetchTimeoutMs); });
      const r = await Promise.race([readPage(page, url, { timeoutMs: Math.max(5000, fetchTimeoutMs - 15000) }), deadline]);
      if (r.challenge) throw Object.assign(new Error(`403 still behind the Cloudflare challenge: ${url}`), { status: 403 });
      if (r.status === 404 || r.status === 410) throw Object.assign(new Error(`${r.status} not found: ${url}`), { status: r.status });
      return { content: r.html, finalUrl: r.finalUrl && r.finalUrl !== url ? r.finalUrl : null, status: r.status, via: 'browserbase' };
    } finally {
      clearTimeout(timer);
      if (page) page.close().catch(() => {});
      s.pages--;
      if (retired.has(s) && !s.pages) retire(s);
    }
  }

  async function close() {
    offReason = 'closed';
    if (pending) await pending.catch(() => {}); // a create still in flight lands in `current` and is closed below
    const all = [current, ...retired].filter(Boolean);
    current = null; retired.clear();
    await Promise.all(all.map((s) => s.browser.close().catch(() => {})));
  }

  return { available, fetch, close, stats: () => ({ ...counts, created, off: offReason }) };
}

/**
 * fetchPage with the Browserbase route: routed hosts go through `browserbase` while it is available, everything else
 * (and routed hosts while it is off) through `fetchPage`. Same shape as scraper.fetchPage: (url, opts) -> {content}.
 */
function laneFetchPage({ fetchPage, browserbase }) {
  return async (url, opts) => {
    if (!opts?.directOnly && browserbase && routesThroughBrowserbase(url) && browserbase.available()) {
      try {
        return await browserbase.fetch(url);
      } catch (e) {
        if (!e || !e.bbUnavailable) throw e;
      }
    }
    return fetchPage(url, opts);
  };
}

/** The real wiring: scraper.fetchPage plus a Browserbase fetcher over createBbSession and Playwright, loaded lazily. */
function createLaneFetch({ env = process.env, log = (m) => console.log(m) } = {}) {
  const { fetchPage } = require('../scraper');
  const browserbase = createBrowserbaseFetcher({
    env, log,
    createSession: (opts) => require('../browserbase-session').createBbSession(opts),
    connect: (connectUrl) => require('playwright').chromium.connectOverCDP(connectUrl),
    readPage: (page, url, opts) => require('../browser-read-page').readBrowserPage(page, url, opts),
    releaseSession: (id) => fetch(`${require('../browserbase-session').SESSIONS_URL}/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': env.BROWSERBASE_API_KEY },
      body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID, status: 'REQUEST_RELEASE' }),
    }).then(() => {}),
  });
  return { fetchPage: laneFetchPage({ fetchPage, browserbase }), browserbase, close: () => browserbase.close() };
}

module.exports = { BROWSERBASE_HOSTS, CALLER, routesThroughBrowserbase, BrowserbaseUnavailable, createBrowserbaseFetcher, laneFetchPage, createLaneFetch };
