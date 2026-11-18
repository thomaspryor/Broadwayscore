#!/usr/bin/env node

/**
 * Automatic cookie renewal for paywalled outlets (BRO-4183, BRO-7705):
 * thestage, nytimes, newyorker, wapo, thetimes, ft, telegraph. Ends the
 * manual Safari re-login + extract-safari-cookies.py dance (macOS Tahoe no
 * longer persists httpOnly cookies to Safari's store).
 *
 * Runs ONLY on the Mac Studio, from launchd
 * (scripts/launchd/com.broadwayscore.cookie-renew.plist, --outlets=all),
 * never in CI or cloud: per-runner logins are what tripped The Stage's
 * 2-device limit on 2026-03-30, and outlets IP-block datacenter logins.
 *
 * Each run, per outlet (one at a time, one lock for the whole run):
 *   1. Probe (lib/cookie-probes.js). Fetchable outlets (thestage, nytimes,
 *      wapo): the walled article over HTTPS with the saved cookies and
 *      without (control). Browser-only outlets (newyorker, thetimes, ft,
 *      telegraph): measured inside the persistent profile in step 2, with an
 *      anonymous-profile control. A bot challenge or unrecognised page is
 *      never "logged out": no login on uncertainty.
 *   2. Plan (lib/cookie-renew.js planRenewal): logged in and no auth cookie
 *      lapses within RENEW_LEAD_MS (3d) -> nothing to do. Otherwise open the
 *      outlet's persistent profile (always the same "device"). Its session
 *      alive -> take its cookies. Profile logged out but the saved cookies
 *      still good -> adopt them into the profile. No login either way.
 *   3. Only then, if decideLogin allows (cooldown 20h, max 2 per 7d, no
 *      sticky stop), ONE login through the outlet's adapter
 *      (lib/cookie-login-adapters.js) with credentials from the macOS
 *      Keychain (NYT/New Yorker need only the email: the one-time code is
 *      read from Gmail). Missing Keychain items, CAPTCHA, emailed code,
 *      rejection, anything unexpected -> sticky needs-human stop + one email.
 *      Never retried; cleared by --reset (a missing-credentials stop clears
 *      itself once the Keychain items exist).
 *   4. Cookies that differ from the saved file are written
 *      (data/cookies/<outlet>.json, method "auto-renew", which the Safari
 *      extractor then leaves alone).
 * After the loop: one COOKIES_BUNDLE_* push via the extractor's --from-local
 * mode (it stays the only bundle writer; localOnly outlets are not pushed),
 * then one check-cookie-health.yml live_check run confirms the outlets CI
 * can see (ciConfirm).
 *
 * Usage:
 *   node scripts/renew-cookies.js --outlets=all [--headed] [--no-push] [--no-confirm]
 *   node scripts/renew-cookies.js --outlet=nytimes          # one outlet (--outlets=a,b for several)
 *   node scripts/renew-cookies.js --outlets=all --probe-only # report login state, change nothing
 *   node scripts/renew-cookies.js --outlet=ft --manual       # headed profile, YOU log in, then push
 *   node scripts/renew-cookies.js --outlet=ft --reset        # clear a needs-human stop (keeps login history)
 *
 * Exit (worst across outlets): 0 ok/nothing to do, 1 error, 2 probe vacuous,
 *       3 needs human, 4 push/confirm failed.
 */

'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help');

// Before any other require or side effect (task #498).
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 52).join('\n'));
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { extractArticleTextFromUrl } = require('./lib/article-extractor');
const { COOKIE_PROBES, classifyWalledProbe } = require('./lib/cookie-probes');
const renew = require('./lib/cookie-renew');
const {
  RENEW_OUTLETS, profileDir, profileNameFor, emptyOutletState, decideLogin, classifyLoginFailure,
  loadState, saveState, acquireLock, readKeychain, renewLockPath, loginAdapterFor, missingCredentials,
  planRenewal, resolveProbeMode, decideControlUnverified, authCookiesChanged, credentialGate, worstExitCode,
} = renew;
const { launchOtpBrowser, writeOtpCookies, COOKIE_DIR } = require('./lib/otp-login-helpers');
const bprobe = require('./lib/cookie-browser-probe');

const REPO_ROOT = path.join(__dirname, '..');
// COOKIE_RENEW_STATE_PATH: tests / supervised dry runs only.
const STATE_PATH = process.env.COOKIE_RENEW_STATE_PATH || path.join(COOKIE_DIR, '_renew-state.json');
// Shared with the gap driver and the login/recover scripts (BRO-7171 plan item 8).
const LOCK_PATH = renewLockPath();
const REPO = 'thomaspryor/Broadwayscore';
const HEALTH_WORKFLOW = 'check-cookie-health.yml';
const UA = bprobe.UA;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

// --- helpers -----------------------------------------------------------------

function cookieHeader(cookies, host) {
  return (cookies || [])
    .filter((c) => c.name && c.value && c.domain)
    .filter((c) => { const d = c.domain.replace(/^\./, ''); return host === d || host.endsWith('.' + d); })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function fetchProbe(probe, cookies) {
  const url = probe.url;
  const headers = { 'User-Agent': UA, Accept: 'text/html' };
  if (cookies) headers.Cookie = cookieHeader(cookies, new URL(url).hostname);
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const html = await res.text();
  // A 403 bot page is classified (as 'error') rather than thrown.
  if (!res.ok && !require('./lib/cookie-probes').isBotChallenge(html)) throw new Error(`HTTP ${res.status} for ${url}`);
  return { html, body: probe.extractBody ? probe.extractBody(html) || '' : extractArticleTextFromUrl(html, url) || '' };
}

function readLocalCookies(fileKey) {
  try {
    // COOKIE_RENEW_COOKIE_DIR: supervised dry runs only (reads; writes still go to COOKIE_DIR).
    const c = JSON.parse(fs.readFileSync(path.join(process.env.COOKIE_RENEW_COOKIE_DIR || COOKIE_DIR, `${fileKey}.json`), 'utf8'));
    return Array.isArray(c) ? c : [];
  } catch {
    return [];
  }
}

// Rollback: the jar being replaced is kept in data/cookies/_prev/ (a
// subdirectory, so the extractor's --from-local never bundles it).
function backupJar(fileKey) {
  const src = path.join(COOKIE_DIR, `${fileKey}.json`);
  try {
    if (!fs.existsSync(src)) return;
    const dir = path.join(COOKIE_DIR, '_prev');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, `${fileKey}.json`));
  } catch (e) {
    console.warn(`[backup] ${fileKey}: could not keep the previous jar (${e.message})`);
  }
}

const keepDomain = (cfg) => (c) => renew.cookieInDomains(c, cfg.cookieDomains);

function toPlaywrightCookie(c) {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: Number(c.expires) > 0 ? Number(c.expires) : undefined,
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  };
}

// needs-human stops page the owner (one email with the login link; allowlisted
// prefix 'cookie-renew:needs-human:' in lib/page-worthy-alerts.js). Everything
// else (probe URL went free, push failed, CI confirm failed) goes to the
// morning digest. The router's per-conditionKey cooldown dedups repeats, and
// the sticky needsHuman state means a stop alerts once, not every run.
async function alertOwner({ outlet, kind, needsHuman, title, description, url }) {
  if (process.env.COOKIE_RENEW_ALERT_DRY_RUN) {
    console.log(`[alert dry-run] ${needsHuman ? 'NEEDS-HUMAN EMAIL' : `digest:${kind}`} ${outlet}: ${title}`);
    return;
  }
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(description.slice(0, 180))} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
  } catch { /* not on a GUI session */ }
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    await routeAlert({
      conditionKey: needsHuman ? `cookie-renew:needs-human:${outlet}` : `cookie-renew:${kind}:${outlet}`,
      disposition: needsHuman ? 'human' : 'digest',
      title,
      description,
      url,
    });
  } catch (e) {
    console.error(`[alert] failed: ${e.message}`);
  }
}

function gh(argv, opts = {}) {
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- steps -------------------------------------------------------------------

// In-profile probe. Returns { status, cookies, detail }: cookies only when logged in.
async function profileSession(context, cfg, probe, { waitMs } = {}) {
  const r = await bprobe.loadProbe(context, probe, { waitMs });
  const all = (await context.cookies()).filter(keepDomain(cfg));
  const hasAuthCookie = renew.hasAuthCookie(all, cfg.authCookies);
  let status = bprobe.classify(probe, r);
  let detail = bprobe.describe(probe, r);
  // A metered wall can show a visitor the whole article (Telegraph, 1 in 4
  // fresh loads): no auth cookie means no session, whatever the body says.
  if (status === 'logged-in' && !hasAuthCookie) { status = 'logged-out'; detail += ', but no auth cookie (metered free view)'; }
  if (status !== 'logged-in') return { status, cookies: null, detail, page: r, hasAuthCookie };
  return { status, detail, page: r, hasAuthCookie, cookies: all };
}

// --manual: the owner logs in by hand inside the SAME persistent profile
// (same device), so recovery from a needs-human stop never adds a session
// elsewhere. Resolves once the page leaves the login URL (10 min limit).
async function manualLogin(context, cfg) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('Log in in the browser window (10 min limit). Leave the window open; it closes itself.');
  const loginHost = new URL(cfg.loginUrl).host;
  const loginPath = new URL(cfg.loginUrl).pathname;
  await page.waitForURL((u) => u.host !== loginHost || u.pathname !== loginPath, { timeout: 10 * 60 * 1000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

function pushBundles() {
  // The extractor is the only COOKIES_BUNDLE_* writer; --from-local rebuilds
  // every bundle from data/cookies/*.json without reading Safari. It exits
  // non-zero if any secret failed to push, which throws here.
  execFileSync('python3', ['scripts/extract-safari-cookies.py', '--from-local', '--push'], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 300000 });
}

async function confirmViaHealthCheck(outlets) {
  const listRuns = () => JSON.parse(gh(['run', 'list', '--repo', REPO, '--workflow', HEALTH_WORKFLOW, '--limit', '5', '--json', 'databaseId,status,conclusion,url,createdAt,event']));
  // A run already in flight loaded the OLD secrets at job start. Let it
  // finish rather than stacking a second run on top of it.
  for (let i = 0; i < 15 && listRuns().some((r) => r.status !== 'completed'); i++) {
    if (i === 0) console.log('check-cookie-health already running; waiting for it to finish before dispatching.');
    await sleep(60000);
  }
  // Our run is the first workflow_dispatch run whose id wasn't listed before
  // dispatch (ids, not timestamps: this Mac's clock vs GitHub's createdAt).
  const before = new Set(listRuns().map((r) => r.databaseId));
  gh(['workflow', 'run', HEALTH_WORKFLOW, '--repo', REPO, '-f', 'live_check=true']);
  console.log('Dispatched check-cookie-health (live_check=true).');

  for (let i = 0; i < 25; i++) {
    await sleep(60000);
    const run = listRuns().find((r) => r.event === 'workflow_dispatch' && !before.has(r.databaseId));
    if (!run || run.status !== 'completed') continue;
    const log = gh(['run', 'view', String(run.databaseId), '--repo', REPO, '--log'], { maxBuffer: 64 * 1024 * 1024 });
    // Exact section header: "Live Access Test" alone also appears in
    // Layer-1 lines for no-cookie outlets.
    const liveIdx = log.indexOf('--- Live Access Test');
    const section = log.slice(liveIdx >= 0 ? liveIdx : 0).split('\n');
    const result = {};
    for (const outlet of outlets) {
      const line = section.find((l) => l.includes(` ${outlet}: `));
      result[outlet] = !!line && line.includes('✅');
      console.log(`Health check ${run.url}: ${line ? line.replace(/^.*?\t/, '').trim() : `no ${outlet} Layer 3 line found`}`);
    }
    return { result, url: run.url };
  }
  return { result: Object.fromEntries(outlets.map((o) => [o, false])), url: null, timeout: true };
}

// --- one outlet ----------------------------------------------------------------

/**
 * @returns {Promise<{code:number, summary:string}>}
 */
async function runOutlet(outlet, all, opts) {
  const cfg = RENEW_OUTLETS[outlet];
  const probe = COOKIE_PROBES[outlet];
  const state = { ...emptyOutletState(), ...(all[outlet] || {}) };
  const persist = () => { all[outlet] = state; saveState(STATE_PATH, all); };
  const done = (code, summary) => ({ code, summary });

  if (opts.reset) {
    // Login history is kept on purpose: clearing it would lift the
    // 2-logins-in-7-days guard right after a human intervened.
    state.needsHuman = null;
    persist();
    return done(0, 'needs-human stop cleared (login history kept)');
  }
  const manual = opts.manual;

  const profile = profileNameFor(outlet);
  const localCookies = readLocalCookies(cfg.fileKey);

  // 1. Probe the cookies CI is using (local file == last pushed bundle entry).
  let probeStatus = 'unknown';
  let inBrowser = !!probe.browserOnly;
  let fellBack = false;
  if (!probe.browserOnly) {
    try {
      const [withCookies, withoutCookies] = [await fetchProbe(probe, localCookies), await fetchProbe(probe, null)];
      probeStatus = classifyWalledProbe({ withCookies, withoutCookies, minBody: probe.minBody, wallMarker: probe.wallMarker, gateMarker: probe.gateMarker });
      console.log(`${outlet} probe: ${probeStatus} (with cookies ${withCookies.body.length} chars, without ${withoutCookies.body.length}, floor ${probe.minBody})`);
      // BRO-7716: a bot-walled fetch probe falls back to the in-browser probe.
      const mode = resolveProbeMode({ browserOnly: false, probeStatus });
      if (mode.fellBack) console.log(`${outlet}: fetch probe hit a bot wall -> falling back to the in-browser profile probe`);
      probeStatus = mode.probeStatus;
      inBrowser = mode.inBrowser;
      fellBack = mode.fellBack;
    } catch (e) {
      return done(1, `probe failed: ${e.message}. Not logging in on an uncertain probe.`);
    }
  }

  const plan = manual ? { action: 'refresh', reason: 'manual' } : planRenewal({ probeStatus, cookies: localCookies, authCookies: cfg.authCookies, nowMs: Date.now() });
  if (plan.action === 'stop') {
    if (probeStatus === 'vacuous') {
      await alertOwner({ outlet, kind: 'probe-vacuous', title: `Cookie renew: ${outlet} probe URL is no longer walled`,
        description: `${probe.url} returns the full article with no cookies, so logged-in state cannot be measured. Pick a recent walled article in scripts/lib/cookie-probes.js.`, url: probe.url });
      return done(2, 'probe url no longer walled (vacuous); alerted');
    }
    return done(1, 'probe page not recognised (bot challenge/maintenance/redesign); not logging in on an uncertain probe');
  }
  if (plan.action === 'none') {
    if (!state.pendingPush) {
      state.lastSuccessAt = new Date().toISOString();
      persist();
    }
    return done(0, `logged in, nothing to do (${plan.reason})`);
  }
  if (opts.probeOnly && !inBrowser) {
    return done(probeStatus === 'logged-in' ? 0 : 3, `${probeStatus} (${plan.reason})`);
  }
  console.log(`${outlet}: ${plan.reason} -> checking the persistent profile (${profile})`);

  // 2 + 3. Persistent profile: reuse its session, adopt the saved cookies,
  // else one gated login.
  const context = await launchOtpBrowser(profileDir(profile), { headless: !opts.headed && !manual, userAgent: UA });
  let cookies = null;
  let how = null;
  try {
    if (manual) {
      state.logins = [...state.logins, new Date().toISOString()].slice(-10);
      persist();
      await manualLogin(context, cfg);
      const after = await profileSession(context, cfg, probe);
      if (!after.cookies) return done(3, `still not logged in after manual login (${after.status}, ${after.detail}). Nothing saved.`);
      cookies = after.cookies;
      how = 'manual login verified';
      state.needsHuman = null;
    } else {
      let existing = await profileSession(context, cfg, probe);
      console.log(`${outlet} in-profile probe: ${existing.status} (${existing.detail})`);
      if (existing.status === 'error') return done(1, 'in-profile probe page not recognised (bot challenge?); not logging in on an uncertain probe');
      if (existing.status === 'logged-in' && inBrowser) {
        // The control: the same url in a cookie-less profile must be walled.
        const c = await bprobe.classifyWithControl(probe, existing.page).catch((e) => ({ error: e.message }));
        // Fallback outlets (BRO-7716): the in-profile probe cannot detect a
        // vacuous (free) probe URL, only this control can. A bot-walled
        // control is tolerated for --probe-only (read-only) and fails closed
        // otherwise: no cookie write/push, no healthy stamp.
        const blocked = c.status === 'control-blocked';
        const unverified = c.error || c.status === 'error' || blocked;
        if (unverified) {
          const d = decideControlUnverified({ fellBack, probeOnly: !!opts.probeOnly });
          const why = c.error ? c.error.split('\n')[0] : blocked ? `control hit a bot challenge (HTTP ${c.control && c.control.httpStatus})` : 'control page not recognised';
          if (d === 'fail') return done(1, `anonymous control failed: ${why}${fellBack ? ' (vacuity unverified; not writing cookies)' : ''}`);
          console.log(`${outlet}: anonymous control failed (${why}); profile reads logged in, probe-only continues`);
        } else if (c.status === 'vacuous') {
          await alertOwner({ outlet, kind: 'probe-vacuous', title: `Cookie renew: ${outlet} probe URL is no longer walled`,
            description: `${probe.url} shows the full article to a browser with no session. Pick a recent walled article in scripts/lib/cookie-probes.js.`, url: probe.url });
          return done(2, 'probe url no longer walled for an anonymous browser (vacuous); alerted');
        }
      }
      if (opts.probeOnly) {
        return done(existing.status === 'logged-in' ? 0 : 3, `profile ${existing.status} (${existing.detail})`);
      }
      // Positive wall evidence before anything that changes the profile or
      // spends a login: a slower re-load must show HTTP 200 and the outlet's
      // rendered wall marker (bprobe.confirmWall).
      const confirmLoggedOut = async (when) => {
        const again = await profileSession(context, cfg, probe, { waitMs: 8000 });
        if (again.cookies) return { cookies: again.cookies };
        const c = bprobe.confirmWall(again, probe);
        console.log(`${outlet} logged-out check ${when}: ${c.ok ? 'confirmed' : 'NOT confirmed'} (${c.reason}; ${again.detail})`);
        return { ok: c.ok, reason: c.reason };
      };
      if (!existing.cookies) {
        const c = await confirmLoggedOut('before adopting/logging in');
        if (c.cookies) { existing = { ...existing, cookies: c.cookies }; how = 'profile session valid (slow render)'; }
        else if (!c.ok) return done(1, `profile reads logged out but it is not confirmed (${c.reason}); not adopting cookies or logging in on an uncertain probe`);
      }
      // The saved file may hold a session the profile lacks (a Safari or
      // standalone-script login): adopt it instead of logging in. Never when
      // the fetch probe has just shown that file is logged out.
      if (!existing.cookies && localCookies.length && probeStatus !== 'logged-out') {
        try {
          await context.addCookies(localCookies.filter((c) => c.name && c.value && c.domain).map(toPlaywrightCookie));
        } catch (e) {
          return done(1, `could not adopt the saved cookies (${e.message.split('\n')[0]}); not logging in`);
        }
        existing = await profileSession(context, cfg, probe);
        console.log(`${outlet} in-profile probe after adopting the saved cookies: ${existing.status} (${existing.detail})`);
        if (existing.cookies) how = 'adopted the saved cookies into the profile';
        else {
          const c = await confirmLoggedOut('after adopting the saved cookies');
          if (c.cookies) { existing = { ...existing, cookies: c.cookies }; how = 'adopted the saved cookies into the profile'; }
          else if (!c.ok) return done(1, `after adopting the saved cookies the page is not a confirmed wall (${c.reason}); not logging in`);
        }
      }
      if (existing.cookies) {
        cookies = existing.cookies;
        how = how || 'profile session valid';
      } else {
        // 3. One gated login. The Keychain is read only when a login could
        // actually happen (or to lift a missing-credentials stop).
        const adapter = loginAdapterFor(outlet);
        const handleGate = async (gate) => {
          if (gate.escalate) {
            state.needsHuman = { at: new Date().toISOString(), reason: gate.reason, code: 'login-limit' };
            persist();
            await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} needs you`,
              description: `${gate.reason}. Check the account's active sessions, then run: node scripts/renew-cookies.js --outlet=${outlet} --manual`, url: cfg.loginUrl });
            return done(3, `needs-human: ${gate.reason} (one email sent)`);
          }
          return done(state.needsHuman ? 3 : 0, `login not attempted: ${gate.reason}`);
        };
        const credsStop = renew.isCredsMissingStop(state.needsHuman);
        if (!credsStop) {
          const gate = decideLogin(state, Date.now());
          if (!gate.allowed) return handleGate(gate);
        }
        const creds = Object.fromEntries((adapter ? adapter.credentials : []).map((k) => [k, readKeychain(`${outlet}-${k}`)]));
        const g = credentialGate(state, adapter, creds, new Date().toISOString());
        Object.assign(state, g.state);
        persist();
        if (g.note) console.log(`${outlet}: ${g.note}`);
        if (g.action === 'stop-new') {
          await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} needs its login saved`, url: cfg.loginUrl,
            description: `${outlet} is logged out and no Keychain login exists for it. Add: security add-generic-password -s ${renew.KEYCHAIN_SERVICE} -a ${outlet}-email -w '<email>'${g.missing.includes('password') ? ` ; security add-generic-password -s ${renew.KEYCHAIN_SERVICE} -a ${outlet}-password -w` : ''}. The next run picks it up. Or log in once: node scripts/renew-cookies.js --outlet=${outlet} --manual` });
          return done(3, `needs-human: logged out and Keychain item(s) missing: ${g.missing.map((k) => `${outlet}-${k}`).join(', ')} (one email sent)`);
        }
        if (g.action === 'stop-sticky') return done(3, `login not attempted: needs-human since ${state.needsHuman.at}: ${state.needsHuman.reason}`);
        if (credsStop) {
          const gate = decideLogin(state, Date.now());
          if (!gate.allowed) return handleGate(gate);
        }
        // Record the attempt BEFORE submitting so a crash still counts.
        state.logins = [...state.logins, new Date().toISOString()].slice(-10);
        persist();
        console.log(`${outlet}: submitting login via ${adapter.kind} (one attempt, no retries)...`);
        let why = null;
        try {
          const page = context.pages()[0] || (await context.newPage());
          const after = await require('./lib/cookie-login-adapters').runLoginFlow(page, adapter, cfg, creds);
          const verified = await profileSession(context, cfg, probe);
          cookies = verified.cookies;
          if (!cookies) why = after.why || (after.formMissing ? 'login form not found (page changed?)' : classifyLoginFailure(after));
        } catch (e) {
          why = `login step threw: ${e.message.split('\n')[0]}`;
        }
        if (why) {
          // Any failure after a submit may have created a session: stop
          // until a human looks, never retry automatically.
          state.needsHuman = { at: new Date().toISOString(), reason: `login did not produce a session: ${why}`, code: 'login-failed' };
          persist();
          await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} login needs you`, url: cfg.loginUrl, description:
            `Automatic login stopped without retrying (${why}). Run: node scripts/renew-cookies.js --outlet=${outlet} --manual (logs in inside the same browser profile, so no extra device).` });
          return done(3, `needs-human: login did not produce a session (${why}); one email sent`);
        }
        how = 'logged in';
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  // 4. Save only a session that differs from the file (or a manual login).
  const changed = manual || authCookiesChanged(localCookies, cookies, cfg.authCookies);
  if (!changed) {
    if (!state.pendingPush) { state.lastSuccessAt = new Date().toISOString(); persist(); }
    const still = planRenewal({ probeStatus: 'logged-in', cookies, authCookies: cfg.authCookies, nowMs: Date.now() });
    return done(0, `logged in (${how}); session matches the saved cookies, nothing to save${still.action === 'refresh' ? ` (note: ${still.reason}; the outlet did not roll it, a login follows once it lapses)` : ''}`);
  }
  const httpOnly = cookies.filter((c) => c.httpOnly).length;
  backupJar(cfg.fileKey);
  const cookiePath = writeOtpCookies(cfg.fileKey, cookies, { method: 'auto-renew' });
  console.log(`${outlet}: wrote ${cookies.length} cookies (${httpOnly} httpOnly) to ${cookiePath}`);
  if (cfg.localOnly) {
    state.pendingPush = false;
    state.lastSuccessAt = new Date().toISOString();
    persist();
    return done(0, `renewed (${how}); local-only, saved for the local browser driver`);
  }
  state.pendingPush = true;
  persist();
  return done(0, `renewed (${how}); queued for the bundle push`);
}

// --- main --------------------------------------------------------------------

function parseOutlets() {
  const raw = arg('outlets') || arg('outlet');
  if (!raw) return { error: `Pass --outlets=all or --outlet=<name>. Supported: ${Object.keys(RENEW_OUTLETS).join(', ')}` };
  const list = raw === 'all' ? Object.keys(RENEW_OUTLETS) : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((o) => !RENEW_OUTLETS[o] || !COOKIE_PROBES[o]);
  if (bad.length) return { error: `Unknown or unsupported outlet(s): ${bad.join(', ')}. Supported: ${Object.keys(RENEW_OUTLETS).join(', ')}` };
  return { list };
}

async function main() {
  const { list, error } = parseOutlets();
  if (error) { console.error(error); return 1; }
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.CLAUDE_CODE_REMOTE === 'true') {
    console.error('Refusing to run in CI/cloud: logins from runners trip device limits and IP blocks. Mac Studio only.');
    return 1;
  }
  const opts = { probeOnly: flag('probe-only'), manual: flag('manual'), reset: flag('reset'), headed: flag('headed') };
  if (process.platform !== 'darwin' && !opts.probeOnly) {
    console.error('Login/renewal runs only on the Mac Studio (darwin). Use --probe-only elsewhere.');
    return 1;
  }
  if (opts.manual && list.length !== 1) { console.error('--manual takes exactly one --outlet.'); return 1; }

  const release = acquireLock(LOCK_PATH);
  if (!release) { console.log('Another renew-cookies run holds the lock; skipping.'); return 0; }
  const all = loadState(STATE_PATH);
  const results = {};
  // The lock is held through the push and its state write, so a concurrent
  // run can never overwrite a login record or a needs-human stop written in
  // between (ship-check). Only the CI confirmation (up to ~40 min, no state
  // writes) runs after release.
  let confirmable = [];
  try {
    for (const outlet of list) {
      let r;
      try {
        r = await runOutlet(outlet, all, opts);
      } catch (e) {
        r = { code: 1, summary: `failed: ${e.message.split('\n')[0]}` };
      }
      results[outlet] = r;
      console.log(`${outlet}: ${r.summary}`);
      // An outlet stuck on an uncertain probe never logs in (by design), so
      // it would otherwise fail quietly forever: one digest alert after 12h.
      if (!opts.probeOnly && !opts.reset) {
        const t = renew.trackUncertain(all[outlet], r.code, Date.now());
        all[outlet] = t.state;
        saveState(STATE_PATH, all);
        if (t.alert) {
          await alertOwner({ outlet, kind: 'stuck-uncertain', title: `Cookie renew: ${outlet} login state unreadable for 12h+`,
            description: `renew-cookies.js has not been able to tell whether ${outlet} is logged in since ${t.state.uncertainSince} (last: ${r.summary}). It will not log in on an uncertain reading. Check: node scripts/verify-cookie-login.js --outlets=${outlet}`, url: COOKIE_PROBES[outlet].url });
        }
      }
    }

    // Push once for every outlet with renewed cookies (or a push left over
    // from a failed run).
    const fresh = loadState(STATE_PATH);
    const pending = list.filter((o) => fresh[o] && fresh[o].pendingPush && !RENEW_OUTLETS[o].localOnly);
    if (pending.length && !opts.probeOnly && !opts.reset) {
      if (flag('no-push')) {
        console.log(`--no-push: bundles not updated (pending: ${pending.join(', ')}).`);
      } else {
        try {
          pushBundles();
          for (const o of pending) Object.assign(fresh[o], { pendingPush: false, lastSuccessAt: new Date().toISOString() });
          saveState(STATE_PATH, fresh);
          console.log(`Pushed COOKIES_BUNDLE_* for: ${pending.join(', ')}`);
          confirmable = flag('no-confirm') ? [] : pending.filter((o) => RENEW_OUTLETS[o].ciConfirm);
        } catch (e) {
          for (const o of pending) {
            results[o] = { code: 4, summary: `${results[o].summary}; bundle push failed (${e.message.split('\n')[0]}), retried next run` };
            await alertOwner({ outlet: o, kind: 'push-failed', title: `Cookie renew: ${o} push failed`,
              description: `Cookies renewed locally but COOKIES_BUNDLE_* push failed (${e.message}). The next run retries the push.`, url: `https://github.com/${REPO}/settings/secrets/actions` });
          }
        }
      }
    }
  } finally {
    release();
  }

  // Confirm in CI the outlets its live check can see.
  if (confirmable.length) {
    const c = await confirmViaHealthCheck(confirmable).catch((e) => ({ result: {}, url: null, error: e.message }));
    for (const o of confirmable) {
      if (c.result[o]) continue;
      results[o] = { code: 4, summary: `${results[o].summary}; CI health check did not confirm${c.timeout ? ' (timed out)' : c.error ? ` (${c.error.split('\n')[0]})` : ''}` };
      await alertOwner({ outlet: o, kind: 'confirm-failed', title: `Cookie renew: ${o} CI health check still failing`,
        description: `Cookies were renewed and pushed, but check-cookie-health did not report ${o} logged in${c.timeout ? ' (timed out waiting)' : ''}.`, url: c.url || `https://github.com/${REPO}/actions/workflows/${HEALTH_WORKFLOW}` });
    }
  }

  console.log(`\n=== renew-cookies ${new Date().toISOString()} ===`);
  for (const o of list) console.log(`${results[o].code === 0 ? 'OK  ' : results[o].code === 3 ? 'HUMAN' : 'FAIL'} ${o.padEnd(10)} ${results[o].summary}`);
  return worstExitCode(list.map((o) => results[o].code));
}

main().then((code) => process.exit(code), (err) => {
  console.error('renew-cookies failed:', err.stack || err.message);
  process.exit(1);
});
