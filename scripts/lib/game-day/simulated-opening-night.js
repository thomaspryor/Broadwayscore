'use strict';
/**
 * Simulated opening night (game day, BRO-7781): six shows on one night, run through the PRODUCTION lane wiring on a
 * fake clock against a local synthetic outlet server. Nothing is stubbed between "an outlet page exists" and "the
 * live show JSON has the review", except the paid model call (recorded answers) and the hosting (a local static
 * server stands in for Vercel):
 *
 *   discovery     driver.wireLaneNight -> lane-runner -> adapters (production default feeds and section indexes, BWW
 *                 roundup, Google News, Playbill) -> titleMatchesShow (BRO-7739 main-title matcher) -> near-miss and
 *                 gap candidates (BRO-7748)
 *   byline/date   inline-score realFetchPorts().extractMeta / extractPublishDate on outlet markup; the manual-ingest
 *                 byline path (content-quality.extractAuthorFromHtml, BRO-7745) on the same TheaterMania page
 *   scoring       inline-score.ensembleScoreText over a recorded scorer (no model call)
 *   publish       publish.publishLaneReviews -> real-ports (compare-and-swap push to a scratch bare git "core data"
 *                 repo) -> the real scripts/generate-mobile-show-details.js in a scratch tree (the site's score gate,
 *                 min-reviews.js) -> a modelled deploy -> live JSON fetched over HTTP
 *   timing        the pre-embargo window and guard (BRO-7740) as the driver computes it, auto-fallback.nightTimes,
 *                 press-night-clock.planKicks (sweeps), all on the fake clock
 *   alerts        press-night-signals-notify posting to a local capture endpoint (Discord stand-in) and a captured
 *                 card comment
 *   manual inbox  manual-inbox.addEntries mid-night; the running lane reads it every pass (BRO-7741)
 *
 * It lives outside scripts/lib/opening-night-lane/ on purpose: the lane's arm hash covers that folder, and a test
 * harness must not disarm the lane.
 *
 * Usage: node scripts/lib/game-day/simulated-opening-night.js [--json] [--keep] [--out=<full report json>] [--record=<compact record json, read by check-opening-night-readiness.js>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const fixtureLib = require('./sim-night-fixture');

// Modelled stage costs on the fake clock (assumptions, as rehearsal.js DEFAULT_LATENCY).
const LATENCY = { passIntervalMs: 2 * 60 * 1000, regenMs: 30 * 1000, deployMs: 8 * 60 * 1000, cdnMs: 2 * 60 * 1000, pollMs: 15 * 1000 };
const FOUND_TO_LIVE_BAR_MS = 30 * 60 * 1000;

/** While fn runs, data/shows.json (read by the lane's main-title matcher and guards) is the sim's own show list. */
async function withSimShowsJson(shows, fn) {
  const target = path.join(REPO, 'data', 'shows.json');
  const orig = fs.readFileSync;
  const body = JSON.stringify({ shows });
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === target) {
      const enc = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].encoding;
      return enc ? body : Buffer.from(body);
    }
    return orig.call(this, p, ...rest);
  };
  try { return await fn(); } finally { fs.readFileSync = orig; }
}

/** The outlet server: GET /?t=<virtual ms>&u=<url> -> the page as of that instant, 404 otherwise. Records every hit. */
function startOutletServer(page) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const url = q.get('u'); const t = Number(q.get('t'));
    const html = page(url, t);
    hits.push({ url, t, ok: html !== undefined });
    if (html === undefined) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': /<rss/.test(html) ? 'application/rss+xml' : 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) })));
}

/** The alert capture endpoint (stands in for the Discord webhook). */
function startCaptureServer() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posts.push({ path: req.url, body: b }); res.writeHead(204); res.end(); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/webhook`, posts, close: () => new Promise((r) => server.close(r)) })));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 15000 }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error(`${res.statusCode} ${url}`)))); }).on('timeout', function onTimeout() { this.destroy(new Error(`timeout ${url}`)); }).on('error', reject);
  });
}
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 15000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('timeout', () => req.destroy(new Error(`timeout ${url}`))); req.on('error', reject); req.end(body);
  });
}

/**
 * A scratch site tree where the real show-JSON generator runs: scripts/src/node_modules are links to this checkout,
 * data/ links every entry except shows.json and reviews.json (the sim's), audit and cache (written by the generator).
 */
function buildSiteTree(dir, shows) {
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public', 'data', 'shows'), { recursive: true });
  for (const d of ['scripts', 'src', 'node_modules']) fs.symlinkSync(path.join(REPO, d), path.join(dir, d));
  const own = new Set(['shows.json', 'reviews.json', 'audit', 'cache']);
  for (const e of fs.readdirSync(path.join(REPO, 'data'))) if (!own.has(e)) fs.symlinkSync(path.join(REPO, 'data', e), path.join(dir, 'data', e));
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({ shows }, null, 2));
  return dir;
}

/** A bare git repo standing in for the private core-data repo, plus the lane's checkout of it. */
function buildCoreRepo(dir) {
  const bare = path.join(dir, 'core.git'); const work = path.join(dir, 'core');
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=sim', '-c', 'user.email=sim@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--bare', '--quiet']);
  git(dir, ['clone', '--quiet', bare, work]);
  // A bystander row: another show's review must survive every lane write (compare-and-swap, never a rebase).
  const seed = { _meta: { lastUpdated: 'sim' }, reviews: [{ showId: 'sim-bystander-2026', outletId: 'timeout', outlet: 'Time Out', criticName: 'Bystander One', url: 'https://example.com/bystander-1', assignedScore: 70, contentTier: 'complete' }] };
  fs.writeFileSync(path.join(work, 'reviews.json'), JSON.stringify(seed, null, 2));
  git(work, ['add', 'reviews.json']); git(work, ['commit', '--quiet', '-m', 'seed']); git(work, ['push', '--quiet', 'origin', 'HEAD:main']);
  return { bare, work };
}

/** Run the real generator for one show in the scratch tree (the site's score gate decides whether `cs` is written). */
function regenInTree(treeDir) {
  return async (showId) => {
    const env = { ...process.env }; delete env.CI; // CI=1 makes the generator write the prune ledger
    execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', 'scripts/generate-mobile-show-details.js', `--show=${showId}`], { cwd: treeDir, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  };
}

/**
 * Run the night. Returns a report; `pass` is the AND of every asserted check. Watch items are reported, not asserted.
 * @param opts.keep keep the scratch dir; opts.log a line logger
 */
async function runSimulatedNight({ keep = false, log = () => {}, only = null } = {}) {
  const gd = fixtureLib.buildGameDay();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'game-day-'));
  const treeDir = buildSiteTree(path.join(work, 'site'), gd.shows);
  const core = buildCoreRepo(work);
  fs.copyFileSync(path.join(core.work, 'reviews.json'), path.join(treeDir, 'data', 'reviews.json'));
  const liveDir = path.join(work, 'live');
  fs.mkdirSync(liveDir, { recursive: true });

  // Hermetic: any request that leaves this machine (a paid model, a scraper, the real site) fails the night.
  const outside = [];
  const dc = require('diagnostics_channel');
  const onUndici = ({ request }) => { if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(request.origin)) outside.push(`${request.origin}${String(request.path).slice(0, 80)}`); };
  dc.subscribe('undici:request:create', onUndici);
  const http0 = { get: http.get, request: http.request };
  const httpsMod = require('https');
  const https0 = { get: httpsMod.get, request: httpsMod.request };
  const watchOut = (mod, orig) => { for (const k of ['get', 'request']) mod[k] = function wrapped(a, ...rest) { const h = typeof a === 'string' ? new URL(a).hostname : a instanceof URL ? a.hostname : (a && (a.hostname || a.host)) || ''; if (!/^(127\.0\.0\.1|localhost)$/.test(String(h).replace(/:\d+$/, ''))) outside.push(`${h}`); return orig[k].call(this, a, ...rest); }; };
  watchOut(http, http0); watchOut(httpsMod, https0);
  const outlets = await startOutletServer(gd.page);
  const capture = await startCaptureServer();
  const publish = require('../opening-night-lane/publish');
  const liveServer = await publish.startStaticServer(liveDir);
  const report = { night: gd.night, shows: {}, alerts: [], cardComments: [], inbox: [], checks: [], watch: [], coverage: [], foundToLive: [], bylineManualIngest: null };
  try {
    await withSimShowsJson(gd.shows, async () => {
      const driver = require('../opening-night-lane/driver');
      const inline = require('../opening-night-lane/inline-score');
      const autoFallback = require('../opening-night-lane/auto-fallback');
      const laneOnlyMarkets = require('../opening-night-lane/lane-only-markets');
      const realPorts = require('../opening-night-lane/real-ports');
      const manualInbox = require('../opening-night-lane/manual-inbox');
      const ledger = require('../opening-night-lane/ledger');
      const { canonicalUrl } = require('../opening-night-lane/discovery');
      const { createPressSignalsNotifier } = require('../press-night-signals-notify');

      // Recorded scorer: the shape scoreReviewFile returns; a URL with no recording is a hard failure.
      const scorer = { scoreReviewFile: async (file) => { const sf = gd.scores[file.url] || gd.scores[(gd.reviews.find((r) => canonicalUrl(r.url) === canonicalUrl(file.url)) || {}).url]; return sf ? { success: true, scoredFile: sf, ensembleResult: {} } : { success: false, error: `no recorded score for ${file.url}` }; } };
      const scoreText = inline.ensembleScoreText(scorer);

      // One in-memory manual inbox for the night (the git-backed store's pure transitions).
      let inboxState = { leases: {} };

      for (const show of gd.shows.filter((x) => !only || only.includes(x.id))) {
        const night = gd.night;
        const mode = autoFallback.laneGuardMode(show, night, false); // LANE_PREEMBARGO_DIRECT_ONLY off: guard only for an assumed embargo
        const embargoMs = Date.parse(laneOnlyMarkets.embargoForNight(show, night));
        const preembargo = mode.enabled && Number.isFinite(embargoMs) ? { enabled: true, embargoMs, reason: mode.reason } : null;
        const times = autoFallback.nightTimes(show, night, { preembargo: !!preembargo });
        let t = times.laneStartMs;
        const now = () => t;
        const wait = async (ms) => { t += ms; };
        const fetchPage = async (url) => ({ content: await httpGet(`${outlets.base}/?t=${t}&u=${encodeURIComponent(url)}`) });
        const ledgerDir = path.join(work, 'ledger');
        const holder = `sim-lane-${show.id}`;
        const leaseState = () => ({ state: { leases: { [`${show.id}|${night}`]: { holder, expiresAt: new Date(t + 30 * 60 * 1000).toISOString() } } } });
        const forkClock = (startMs) => { let c = startMs; return { now: () => c, wait: async (ms) => { c += ms; } }; };
        const pages = [];
        const makePublishPorts = (clock) => {
          const real = realPorts.createRealPublishPorts({
            show: show.id, repoDir: treeDir, coreDir: core.work, holder, baseUrl: liveServer.baseUrl, now: clock.now, readLeases: leaseState, night,
            regen: regenInTree(treeDir), page: async (o) => { pages.push(o); return { delivered: true }; }, autoFixFirstGate: async () => ({ email: true }),
            env: {}, sleep: async () => {},
          });
          let visibleAt = Infinity;
          return {
            ...real,
            regenShow: async (id, urls) => { await clock.wait(LATENCY.regenMs); return real.regenShow(id, urls); },
            deploy: async () => {
              await clock.wait(LATENCY.deployMs);
              const src = path.join(treeDir, 'public', 'data', 'shows', `${show.id}.json`);
              fs.mkdirSync(path.join(liveDir, 'data', 'shows'), { recursive: true });
              fs.copyFileSync(src, path.join(liveDir, 'data', 'shows', `${show.id}.json`));
              visibleAt = clock.now() + LATENCY.cdnMs;
              return { shippedBy: 'sim deploy' };
            },
            fetchLiveShow: async (id) => (clock.now() >= visibleAt ? real.fetchLiveShow(id) : { rv: [] }),
          };
        };
        // Manual inbox: entries become visible to the lane at their drop time.
        const drops = gd.reviews.filter((r) => r.show === show.id && r.manualAfterMs != null).map((r) => ({ r, atMs: r.at + r.manualAfterMs, added: false }));
        const inbox = {
          readInbox: async () => {
            for (const d of drops) {
              if (d.added || t < d.atMs) continue;
              const res = manualInbox.addEntries(inboxState, { show: show.id, lines: [{ url: d.r.url }], addedBy: 'sim-coordinator', now: t });
              if (res.ok) inboxState = res.state;
              d.added = true;
              report.inbox.push({ show: show.id, url: d.r.url, addedAt: new Date(t).toISOString() });
            }
            return manualInbox.entriesFor(inboxState, show.id);
          },
          markInbox: async (updates) => { inboxState = manualInbox.markStatus(inboxState, { updates, now: t }).state; },
        };
        const notifier = createPressSignalsNotifier({
          env: { DISCORD_WEBHOOK_ALERTS: capture.url, LINEAR_API_KEY: 'sim-not-a-key' }, log: () => {},
          discord: (hook, text) => httpPost(hook, JSON.stringify({ content: text, show: show.id })),
          comment: async (card, body) => { report.cardComments.push({ card, show: show.id, body }); return true; },
          card: 'BRO-5955', runUrl: 'sim://game-day', fetchPage: (url) => fetchPage(url).then((p) => p.content),
        });
        const signals = [];
        const onPressSignals = async (sig) => {
          signals.push({ at: new Date(t).toISOString(), nearMisses: (sig.nearMisses || []).map((n) => n.url), gaps: (sig.gaps || []).map((g) => g.url || g.key) });
          return notifier(sig);
        };

        const runNight = driver.wireLaneNight({
          show, night, openingDate: show.openingDate, timeZone: 'America/New_York', ledgerDir,
          laneFetch: { fetchPage, close: () => {} }, scoreText,
          makePublishPorts, forkClock, now, wait,
          reviewTextsDir: path.join(work, 'review-texts'), onDiskUrls: [], onDiskRows: [],
          showScoreGuards: { urlMap: {}, allShows: gd.shows }, search: async () => [], decodeImpl: null,
          windowMs: times.watchEndMs - times.laneStartMs,
          tuning: { startedAt: times.laneStartMs, passIntervalMs: LATENCY.passIntervalMs, pollMs: LATENCY.pollMs, publishTimeoutMs: 60 * 60 * 1000 },
          preembargo, onPressSignals, manualInbox: inbox,
        });
        // The night ends 60 virtual minutes after the show's last scripted event (a page, a roundup, an inbox drop):
        // the rest of the production window only re-reads quiet pages, and cutting it keeps the run to minutes.
        const lastEvent = Math.max(...gd.reviews.filter((r) => r.show === show.id).flatMap((r) => [r.at, r.bwwAt || 0, r.manualAfterMs != null ? r.at + r.manualAfterMs : 0]));
        const stopAt = Math.min(times.watchEndMs, Math.max(lastEvent, embargoMs) + 60 * 60 * 1000);
        const quiet = console.log; console.log = () => {};
        let run;
        try { run = await runNight({ shouldStop: () => t >= stopAt }); } finally { console.log = quiet; }
        const read = ledger.readLedger(ledgerDir, show.id, night);
        let liveDoc = null;
        try { liveDoc = JSON.parse(fs.readFileSync(path.join(liveDir, 'data', 'shows', `${show.id}.json`), 'utf8')); } catch { /* nothing went live */ }
        report.shows[show.id] = { times: { embargo: new Date(embargoMs).toISOString(), laneStart: new Date(times.laneStartMs).toISOString(), watchEnd: new Date(times.watchEndMs).toISOString(), guard: mode.reason }, passes: run.passes, errors: run.errors, signals, pages, live: liveDoc, states: ledger.reviewStates(read.events), inbox: run.inbox };
        log(`${show.id}: ${run.passes} passes, ${(liveDoc && liveDoc.rv || []).length} live, ${signals.length} alert batch(es)`);
      }
      report.inboxFinal = Object.values(inboxState.leases).map((e) => ({ show: e.show, url: e.url, status: e.status || 'open', reason: e.reason || null }));
      report.alerts = capture.posts.map((p) => { try { return JSON.parse(p.body); } catch { return { content: p.body }; } });
      if (!only) evaluate(report, gd, { canonicalUrl });
    });

    // BRO-7745: the manual-ingest byline path (ingest-urls.js) on the served TheaterMania page must credit the critic.
    const { extractAuthorFromHtml } = require('../content-quality');
    const tmReview = gd.reviews.find((r) => r.byline.kind === 'theatermania');
    const html = gd.page(tmReview.url, tmReview.at + 1);
    // The registry roster is passed explicitly: the gitignored data/critic-registry.json may be absent (CI, worktrees), and
    // without it the pre-fix JSON-LD slug path ("dgordon" -> David Gordon) resolves nobody, so a revert would go unseen.
    const theaterManiaCritics = ['David Gordon', tmReview.critic];
    const author = extractAuthorFromHtml(html, '', { url: tmReview.url, outletId: 'theatermania', theaterManiaCritics });
    const got = author && (author.name || author.author || author);
    report.bylineManualIngest = { url: tmReview.url, expected: tmReview.critic, got: typeof got === 'string' ? got : JSON.stringify(got) };
    check(report, 'byline: manual ingest credits the TheaterMania critic, not the posting editor (BRO-7745)', report.bylineManualIngest.got === tmReview.critic, report.bylineManualIngest);
  } finally {
    dc.unsubscribe('undici:request:create', onUndici);
    Object.assign(http, http0); Object.assign(httpsMod, https0);
    await outlets.close(); await capture.close(); await liveServer.close();
    if (!keep) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); else report.workDir = work;
  }
  check(report, 'hermetic: no request left this machine (no paid model, scraper or live-site call)', outside.length === 0, [...new Set(outside)].slice(0, 10));
  report.pass = report.checks.every((c) => c.ok);
  return report;
}

function check(report, name, ok, detail) { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); }

function evaluate(report, gd, { canonicalUrl }) {
  const clock = require('../press-night-clock');
  const autoFallback = require('../opening-night-lane/auto-fallback');
  const alertUrls = report.alerts.map((a) => String(a.content || ''));
  for (const r of gd.reviews) {
    const s = report.shows[r.show];
    const live = ((s.live && s.live.rv) || []).find((x) => canonicalUrl(x.u) === canonicalUrl(r.url));
    const alerts = alertUrls.filter((txt) => txt.includes(r.url)).length;
    const label = `${r.show} ${r.outletId} (${r.critic})`;
    const st = s.states.find((x) => x.reviewKey === canonicalUrl(r.url));
    if (st && st.firstAt.discovered && st.firstAt['verified-live']) report.foundToLive.push({ review: label, via: r.via, ms: Date.parse(st.firstAt['verified-live']) - Date.parse(st.firstAt.discovered), pageToLiveMs: Date.parse(st.firstAt['verified-live']) - r.at });
    if (r.expect === 'live' || r.expect === 'alert+manual') {
      const item = { review: label, live: !!live, critic: live && live.cn, score: live && live.s };
      const ok = !!live && live.cn === r.critic && live.s === r.score;
      if (r.watch) { if (!ok) report.watch.push({ ...item, why: r.watch }); continue; }
      check(report, `live with the right critic and score: ${label}`, ok, item);
    }
    if (r.expect === 'alert+manual') check(report, `exactly one alert names the missed review: ${label}`, alerts === 1, { alerts });
    else if (live && alerts > 0) report.watch.push({ review: label, why: `${alerts} alert(s) for a review that went live (noise)` });
  }
  // Score gate: four Broadway critics is under min-reviews.js's floor, so the live show JSON carries no Critic Score.
  const fc = report.shows['sim-four-critics-special-2026'];
  check(report, 'score gate: 4 Broadway critics publish reviews but no Critic Score', fc && fc.live && (fc.live.rv || []).length === 4 && fc.live.cs == null, { reviews: fc && fc.live && (fc.live.rv || []).length, cs: fc && fc.live && fc.live.cs });
  const bmg = report.shows['sim-blue-man-group-holiday-2026'];
  check(report, 'no review page alerts: no lane publish timed out', Object.values(report.shows).every((s) => !s.pages.length), Object.fromEntries(Object.entries(report.shows).map(([k, s]) => [k, s.pages.length])));
  // Collector coverage: each review's drop time is inside the lane's window or before a later sweep (press-night-clock).
  const kicks = clock.planKicks(gd.shows, Date.parse(`${gd.night}T12:00:00Z`), { horizonDays: 2 });
  for (const r of gd.reviews) {
    const show = gd.shows.find((x) => x.id === r.show);
    const times = autoFallback.nightTimes(show, gd.night, { preembargo: report.shows[r.show].times.guard !== 'off' });
    const inLane = r.at >= times.laneStartMs && r.at <= times.watchEndMs;
    const before = r.at < times.laneStartMs; // a page already up when the lane starts is read on its first pass
    const sweep = (kicks || []).filter((k) => (k.showId || k.show || (k.show && k.show.id)) === r.show && (Number.isFinite(k.kickAtMs) ? k.kickAtMs : Date.parse(k.at || k.atIso || 0)) >= r.at).map((k) => k.kind);
    report.coverage.push({ review: `${r.show} ${r.outletId}`, drop: new Date(r.at).toISOString(), collector: inLane ? 'lane' : before ? 'lane (first pass)' : sweep.length ? `sweep ${sweep[0]}` : 'NONE' });
  }
  check(report, 'collector coverage: every review drop has a collector', report.coverage.every((c) => c.collector !== 'NONE'), report.coverage.filter((c) => c.collector === 'NONE'));
  // Page-to-live over the bar: reported, not asserted. Each is a known gap a sibling card owns (single-word lead titles,
  // a guessed embargo that is hours late); asserting it would turn this test red the day the fix lands elsewhere.
  for (const x of report.foundToLive) if (x.via !== 'bww' && x.pageToLiveMs > FOUND_TO_LIVE_BAR_MS) // bww: only on the roundup, which the fixture posts late on purpose
    report.watch.push({ review: x.review, why: `page-to-live ${Math.round(x.pageToLiveMs / 60000)} min (bar ${FOUND_TO_LIVE_BAR_MS / 60000}); found-to-live ${Math.round(x.ms / 60000)} min` });
  check(report, 'found-to-live: every review goes live within the bar once the lane has it', report.foundToLive.length > 0 && report.foundToLive.every((x) => x.ms <= FOUND_TO_LIVE_BAR_MS), report.foundToLive.filter((x) => x.ms > FOUND_TO_LIVE_BAR_MS));
  check(report, 'alerts: every alert batch reached both channels (Discord stand-in and the coordinator card)', report.alerts.length === report.cardComments.length && report.cardComments.every((c) => c.card === 'BRO-5955'), { discord: report.alerts.length, card: report.cardComments.length });
  check(report, 'manual inbox: every dropped URL ends published', report.inboxFinal.length === report.inbox.length && report.inboxFinal.every((e) => e.status === 'published'), report.inboxFinal);
}

function formatReport(report) {
  const lines = [`Simulated opening night ${report.night}: ${report.pass ? 'PASS' : 'FAIL'}`];
  for (const c of report.checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`);
  if (report.watch.length) { lines.push('  watch (reported, not asserted):'); for (const w of report.watch) lines.push(`    - ${JSON.stringify(w)}`); }
  const f = report.foundToLive.map((x) => x.ms).sort((a, b) => a - b);
  if (f.length) lines.push(`  found-to-live (simulated): median ${Math.round(f[Math.floor(f.length / 2)] / 60000)} min, max ${Math.round(f[f.length - 1] / 60000)} min over ${f.length} reviews`);
  lines.push(`  alerts posted: ${report.alerts.length}; card comments: ${report.cardComments.length}; inbox drops: ${report.inbox.length}`);
  return lines.join('\n');
}

/**
 * The small committed record (data/audit/simulated-opening-night.json) that check-opening-night-readiness.js reads, so
 * readiness never runs the night itself. Written on pass, fail AND crash: an old pass can never stand in for a broken run.
 */
function recordFrom(report, { at = new Date().toISOString(), sha = null, error = null } = {}) {
  if (!report) return { at, sha, pass: false, error: String(error || 'the night crashed'), failed: [], checks: 0 };
  const f = (report.foundToLive || []).map((x) => x.ms).sort((a, b) => a - b);
  return {
    at, sha, pass: !!report.pass,
    checks: report.checks.length,
    failed: report.checks.filter((c) => !c.ok).map((c) => c.name),
    watch: (report.watch || []).length,
    foundToLiveMedianMin: f.length ? Math.round(f[Math.floor(f.length / 2)] / 60000) : null,
    reviews: f.length,
  };
}

module.exports = { runSimulatedNight, formatReport, recordFrom, LATENCY, FOUND_TO_LIVE_BAR_MS };

if (require.main === module) {
  const recordPath = (process.argv.find((a) => a.startsWith('--record=')) || '').slice(9);
  // A partial night (GAME_DAY_ONLY) skips most checks, so its pass must never stand in as the readiness record.
  if (recordPath && process.env.GAME_DAY_ONLY) { console.error('--record refused with GAME_DAY_ONLY set: a partial night is not a full pass'); process.exit(2); }
  const writeRecord = (r, error) => {
    if (!recordPath) return;
    let sha = process.env.GITHUB_SHA || null;
    if (!sha) { try { sha = require('child_process').execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { /* no git */ } }
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(recordFrom(r, { sha, error }), null, 2) + '\n');
  };
  const json = process.argv.includes('--json');
  runSimulatedNight({ keep: process.argv.includes('--keep'), only: process.env.GAME_DAY_ONLY ? process.env.GAME_DAY_ONLY.split(',') : null, log: json ? () => {} : (l) => console.error(l) }).then((r) => {
    const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
    if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2)); // stdout also carries the lane's own log lines
    writeRecord(r, null);
    console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
    process.exit(r.pass ? 0 : 1);
  }, (e) => { console.error(e && e.stack || e); writeRecord(null, e && e.message || e); process.exit(2); });
}
