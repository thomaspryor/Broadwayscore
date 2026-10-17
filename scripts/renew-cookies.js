#!/usr/bin/env node

/**
 * Automatic cookie renewal for paywalled outlets (BRO-4183). The Stage only
 * for now; more outlets are added to RENEW_OUTLETS one at a time.
 *
 * Replaces scripts/thestage-login.js (env-var credentials, /tmp profile, no
 * guards). Runs ONLY on the Mac Studio, from launchd
 * (scripts/launchd/com.broadwayscore.cookie-renew.plist), never in CI:
 * per-runner logins are what tripped The Stage's 2-device limit on
 * 2026-03-30 (cloud-memory/feedback_stage_cookie_only.md).
 *
 * Each run:
 *   1. Probe: fetch the outlet's walled article (scripts/lib/cookie-probes.js,
 *      the same probe check-cookie-health.js Layer 3 uses) with the current
 *      cookies and without any. Logged in -> exit 0. Probe URL no longer
 *      walled -> alert, exit 2. Fetch error or a page that isn't the
 *      recognised registration gate (challenge, maintenance) -> exit 1.
 *      No login on uncertainty.
 *   2. Open the persistent profile (always the same "device"). If the
 *      profile's own session is still alive, take its cookies: no login.
 *   3. Otherwise, if the gate allows (lib/cookie-renew.js decideLogin), submit
 *      the login form ONCE with credentials from the macOS Keychain.
 *      CAPTCHA / emailed code / rejection / anything unexpected -> sticky
 *      needs-human stop + one email with the login link. Never retried.
 *   4. Save cookies (data/cookies/<outlet>.json, method "auto-renew"), then
 *      re-push the COOKIES_BUNDLE_* secrets via the extractor's --from-local
 *      mode (it stays the only bundle writer).
 *   5. Confirm: dispatch check-cookie-health.yml with live_check=true and
 *      read the outlet's Layer 3 line from the run log.
 *
 * Usage:
 *   node scripts/renew-cookies.js --outlet=thestage [--headed] [--no-push] [--no-confirm]
 *   node scripts/renew-cookies.js --outlet=thestage --probe-only
 *   node scripts/renew-cookies.js --outlet=thestage --manual     # headed profile, YOU log in, then push
 *   node scripts/renew-cookies.js --outlet=thestage --reset      # clear a needs-human stop (keeps login history)
 *
 * Exit: 0 ok/nothing to do, 1 error, 2 probe vacuous, 3 needs human,
 *       4 push/confirm failed.
 */

'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help');

// Before any other require or side effect (task #498).
if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 43).join('\n'));
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { extractArticleTextFromUrl } = require('./lib/article-extractor');
const { COOKIE_PROBES, classifyWalledProbe } = require('./lib/cookie-probes');
const {
  RENEW_OUTLETS, profileDir, emptyOutletState, decideLogin, classifyLoginFailure,
  loadState, saveState, acquireLock, readKeychain,
} = require('./lib/cookie-renew');
const { launchOtpBrowser, writeOtpCookies, COOKIE_DIR } = require('./lib/otp-login-helpers');

const REPO_ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(COOKIE_DIR, '_renew-state.json');
const LOCK_PATH = path.join(COOKIE_DIR, '_renew.lock');
const REPO = 'thomaspryor/Broadwayscore';
const HEALTH_WORKFLOW = 'check-cookie-health.yml';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

async function fetchProbe(url, cookies) {
  const headers = { 'User-Agent': UA, Accept: 'text/html' };
  if (cookies) headers.Cookie = cookieHeader(cookies, new URL(url).hostname);
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  return { html, body: extractArticleTextFromUrl(html, url) || '' };
}

function readLocalCookies(fileKey) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(COOKIE_DIR, `${fileKey}.json`), 'utf8'));
    return Array.isArray(c) ? c : [];
  } catch {
    return [];
  }
}

// needs-human stops page the owner (one email with the login link; allowlisted
// prefix 'cookie-renew:needs-human:' in lib/page-worthy-alerts.js). Everything
// else (probe URL went free, push failed, CI confirm failed) goes to the
// morning digest. The router's per-conditionKey cooldown dedups repeats.
async function alertOwner({ outlet, kind, needsHuman, title, description, url }) {
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

// In-profile probe. Returns { status, cookies }: cookies only when logged in.
async function profileSession(context, outletCfg, probe) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  const html = await page.content();
  const status = classifyWalledProbe({
    withCookies: { html, body: extractArticleTextFromUrl(html, probe.url) || '' },
    minBody: probe.minBody, wallMarker: probe.wallMarker, gateMarker: probe.gateMarker,
  });
  if (status !== 'logged-in') return { status, cookies: null };
  return { status, cookies: (await context.cookies()).filter((c) => c.domain.includes(outletCfg.cookieDomain)) };
}

// --manual: the owner logs in by hand inside the SAME persistent profile
// (same device), so recovery from a needs-human stop never adds a session
// elsewhere. Resolves once the page leaves the login URL (10 min limit).
async function manualLogin(context, cfg) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('Log in in the browser window (10 min limit). Leave the window open; it closes itself.');
  await page.waitForURL((u) => !/\/login/i.test(u.pathname), { timeout: 10 * 60 * 1000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function submitLogin(context, cfg, creds) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  const reject = page.getByRole('button', { name: cfg.selectors.consentReject });
  if (await reject.count()) { await reject.first().click().catch(() => {}); await page.waitForTimeout(500); }

  const email = page.locator(cfg.selectors.email).first();
  const password = page.locator(cfg.selectors.password).first();
  if (!(await email.count()) || !(await password.count())) {
    return { url: page.url(), html: await page.content(), formMissing: true };
  }
  await email.fill(creds.email);
  await password.fill(creds.password);

  const submit = page.getByRole('button', { name: cfg.selectors.submit });
  if (await submit.count()) await submit.first().click();
  else await password.press('Enter');

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return { url: page.url(), html: await page.content(), formMissing: false };
}

function pushBundles() {
  // The extractor is the only COOKIES_BUNDLE_* writer; --from-local rebuilds
  // every bundle from data/cookies/*.json without reading Safari. It exits
  // non-zero if any secret failed to push, which throws here.
  execFileSync('python3', ['scripts/extract-safari-cookies.py', '--from-local', '--push'], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 300000 });
}

async function confirmViaHealthCheck(outlet) {
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
    const line = log.slice(liveIdx >= 0 ? liveIdx : 0).split('\n').find((l) => l.includes(` ${outlet}: `));
    const ok = !!line && line.includes('✅');
    console.log(`Health check ${run.url}: ${line ? line.replace(/^.*?\t/, '').trim() : `no ${outlet} Layer 3 line found`}`);
    return { ok, url: run.url };
  }
  return { ok: false, url: null, timeout: true };
}

// --- main --------------------------------------------------------------------

async function main() {
  const outlet = arg('outlet');
  const cfg = RENEW_OUTLETS[outlet];
  const probe = COOKIE_PROBES[outlet];
  if (!cfg || !probe) {
    console.error(`Unknown or unsupported --outlet=${outlet}. Supported: ${Object.keys(RENEW_OUTLETS).join(', ')}`);
    return 1;
  }
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    console.error('Refusing to run in CI: logins from runners are what tripped the device limit. Mac Studio only.');
    return 1;
  }
  const probeOnly = flag('probe-only');
  if (process.platform !== 'darwin' && !probeOnly) {
    console.error('Login/renewal runs only on the Mac Studio (darwin). Use --probe-only elsewhere.');
    return 1;
  }

  const release = acquireLock(LOCK_PATH);
  if (!release) { console.log('Another renew-cookies run holds the lock; skipping.'); return 0; }
  try {
    const all = loadState(STATE_PATH);
    const state = { ...emptyOutletState(), ...(all[outlet] || {}) };
    const persist = () => { all[outlet] = state; saveState(STATE_PATH, all); };

    if (flag('reset')) {
      // Login history is kept on purpose: clearing it would lift the
      // 2-logins-in-7-days guard right after a human intervened.
      state.needsHuman = null;
      persist();
      console.log(`${outlet}: needs-human stop cleared (login history kept).`);
      return 0;
    }

    // 1. Probe the cookies CI is using (local file == last pushed bundle entry).
    let status;
    try {
      const [withCookies, withoutCookies] = [await fetchProbe(probe.url, readLocalCookies(cfg.fileKey)), await fetchProbe(probe.url, null)];
      status = classifyWalledProbe({ withCookies, withoutCookies, minBody: probe.minBody, wallMarker: probe.wallMarker, gateMarker: probe.gateMarker });
      console.log(`${outlet} probe: ${status} (with cookies ${withCookies.body.length} chars, without ${withoutCookies.body.length}, floor ${probe.minBody})`);
    } catch (e) {
      console.error(`${outlet} probe failed: ${e.message}. Not logging in on an uncertain probe.`);
      return 1;
    }
    if (status === 'vacuous') {
      await alertOwner({ outlet, kind: 'probe-vacuous', title: `Cookie renew: ${outlet} probe URL is no longer walled`,
        description: `${probe.url} returns the full article with no cookies, so logged-in state cannot be measured. Pick a recent walled article in scripts/lib/cookie-probes.js.`, url: probe.url });
      return 2;
    }
    if (status === 'error') {
      console.error(`${outlet}: probe page is not the recognised registration gate (challenge/maintenance/redesign?). Not logging in on an uncertain probe.`);
      return 1;
    }
    const manual = flag('manual');
    if (status === 'logged-in' && !state.pendingPush && !manual) {
      state.lastSuccessAt = new Date().toISOString();
      persist();
      console.log(`${outlet}: logged in, nothing to do.`);
      return 0;
    }
    if (probeOnly) return status === 'logged-in' ? 0 : 3;

    if (status !== 'logged-in' || manual) {
      // 2 + 3. Persistent profile: reuse its session, else one gated login.
      const context = await launchOtpBrowser(profileDir(outlet), { headless: !flag('headed') && !manual, userAgent: UA });
      let cookies;
      try {
        if (manual) {
          state.logins = [...state.logins, new Date().toISOString()].slice(-10);
          persist();
          await manualLogin(context, cfg);
          const after = await profileSession(context, cfg, probe);
          if (!after.cookies) {
            console.error(`${outlet}: still not logged in after manual login (${after.status}). Nothing pushed.`);
            return 3;
          }
          cookies = after.cookies;
          state.needsHuman = null;
          console.log(`${outlet}: manual login verified.`);
        } else {
          const existing = await profileSession(context, cfg, probe);
          if (existing.status === 'error') {
            console.error(`${outlet}: in-profile probe page not recognised; not logging in on an uncertain probe.`);
            return 1;
          }
          cookies = existing.cookies;
        }
        if (cookies && !manual) {
          console.log(`${outlet}: profile session still valid; no login needed.`);
        } else if (!cookies) {
          const gate = decideLogin(state, Date.now());
          if (!gate.allowed) {
            console.log(`${outlet}: login not attempted: ${gate.reason}`);
            if (gate.escalate) {
              state.needsHuman = { at: new Date().toISOString(), reason: gate.reason };
              persist();
              await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} needs you`,
                description: `${gate.reason}. Check the account's active sessions, then run: node scripts/renew-cookies.js --outlet=${outlet} --manual`, url: cfg.loginUrl });
              return 3;
            }
            return 0;
          }

          const creds = { email: readKeychain(`${outlet}-email`), password: readKeychain(`${outlet}-password`) };
          if (!creds.email || !creds.password) {
            state.needsHuman = { at: new Date().toISOString(), reason: 'Keychain credentials missing' };
            persist();
            await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} credentials missing`,
              description: `Add Keychain items service=broadwayscorecard-cookie-renew accounts ${outlet}-email / ${outlet}-password, then --reset.`, url: cfg.loginUrl });
            return 3;
          }

          // Record the attempt BEFORE submitting so a crash still counts.
          state.logins = [...state.logins, new Date().toISOString()].slice(-10);
          persist();
          console.log(`${outlet}: submitting login (one attempt, no retries)...`);
          let why = null;
          try {
            const after = await submitLogin(context, cfg, creds);
            const verified = await profileSession(context, cfg, probe);
            cookies = verified.cookies;
            if (!cookies) why = after.formMissing ? 'login form not found (page changed?)' : classifyLoginFailure(after);
          } catch (e) {
            why = `login step threw: ${e.message.split('\n')[0]}`;
          }
          if (why) {
            // Any failure after a submit may have created a session: stop
            // until a human looks, never retry automatically.
            state.needsHuman = { at: new Date().toISOString(), reason: `login did not produce a session: ${why}` };
            persist();
            await alertOwner({ outlet, needsHuman: true, title: `Cookie renew: ${outlet} login needs you`, url: cfg.loginUrl, description:
              `Automatic login stopped without retrying (${why}). Run: node scripts/renew-cookies.js --outlet=${outlet} --manual (logs in inside the same browser profile, so no extra device).` });
            return 3;
          }
          console.log(`${outlet}: login succeeded.`);
        }
      } finally {
        await context.close().catch(() => {});
      }

      const httpOnly = cookies.filter((c) => c.httpOnly).length;
      const cookiePath = writeOtpCookies(cfg.fileKey, cookies, { method: 'auto-renew' });
      console.log(`Wrote ${cookies.length} cookies (${httpOnly} httpOnly) to ${cookiePath}`);
      state.pendingPush = true;
      persist();
    }

    // 4. Push.
    if (flag('no-push')) { console.log('--no-push: bundles not updated.'); return 0; }
    try {
      pushBundles();
    } catch (e) {
      await alertOwner({ outlet, kind: 'push-failed', title: `Cookie renew: ${outlet} push failed`,
        description: `Cookies renewed locally but COOKIES_BUNDLE_* push failed (${e.message}). The next run retries the push.`, url: `https://github.com/${REPO}/settings/secrets/actions` });
      return 4;
    }
    state.pendingPush = false;
    state.lastSuccessAt = new Date().toISOString();
    persist();

    // 5. Confirm in CI.
    if (flag('no-confirm')) return 0;
    const confirm = await confirmViaHealthCheck(outlet);
    if (confirm.ok === false) {
      await alertOwner({ outlet, kind: 'confirm-failed', title: `Cookie renew: ${outlet} CI health check still failing`,
        description: `Cookies were renewed and pushed, but check-cookie-health did not report ${outlet} logged in${confirm.timeout ? ' (timed out waiting)' : ''}.`, url: confirm.url || `https://github.com/${REPO}/actions/workflows/${HEALTH_WORKFLOW}` });
      return 4;
    }
    console.log(`${outlet}: renewal complete.`);
    return 0;
  } finally {
    release();
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error('renew-cookies failed:', err.stack || err.message);
  process.exit(1);
});
