#!/usr/bin/env node
/**
 * Newspapers.com — one-time login into a PERSISTENT Browserbase context.
 *
 * Why: newspapers.com's Cloudflare Turnstile blocks our local automation
 * browser at the sign-in form, and Safari (macOS Tahoe) no longer exposes the
 * httpOnly auth cookies to our extractor. Browserbase's stealth browser passes
 * Cloudflare; a *persistent context* saves the login so every later extraction
 * run is authenticated WITHOUT re-login (restores the old hands-off behaviour).
 *
 * Flow:
 *   1. Reuse (or create) a persistent Browserbase context, id saved to
 *      data/collection-state/browserbase-newspapers-context.json
 *   2. Start a keep-alive session on that context and open its live-view URL
 *   3. YOU log into newspapers.com in the live view (passes Cloudflare)
 *   4. Press Enter here — the session closes and the context keeps the cookies
 *
 * Usage:
 *   node scripts/newspapers-browserbase-login.js
 *   node scripts/newspapers-browserbase-login.js --new   # force a fresh context
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const API = 'https://api.browserbase.com/v1';
const CTX_FILE = path.join('data', 'collection-state', 'browserbase-newspapers-context.json');

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
}

async function bb(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': process.env.BROWSERBASE_API_KEY },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) { console.error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set'); process.exit(1); }

  const forceNew = process.argv.includes('--new');
  let contextId = null;
  if (!forceNew && fs.existsSync(CTX_FILE)) {
    contextId = JSON.parse(fs.readFileSync(CTX_FILE, 'utf8')).contextId;
  }
  if (!contextId) {
    const ctx = await bb('POST', '/contexts', { projectId });
    contextId = ctx.id;
    fs.mkdirSync(path.dirname(CTX_FILE), { recursive: true });
    fs.writeFileSync(CTX_FILE, JSON.stringify({ contextId, createdFor: 'newspapers.com' }, null, 2));
    console.log(`Created persistent context ${contextId} (saved to ${CTX_FILE})`);
  } else {
    console.log(`Reusing persistent context ${contextId}`);
  }

  // Keep-alive session bound to the persistent context (persist:true → save cookies back).
  const session = await bb('POST', '/sessions', {
    projectId,
    keepAlive: true,
    proxies: true,
    browserSettings: { context: { id: contextId, persist: true }, solveCaptchas: true },
  });
  console.log(`Session ${session.id} started.`);

  const dbg = await bb('GET', `/sessions/${session.id}/debug`);
  const liveUrl = dbg.debuggerFullscreenUrl || dbg.debuggerUrl;

  // Pre-navigate to the sign-in page so the live view lands there.
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.newspapers.com/signin/', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\n' + '='.repeat(70));
  console.log('OPEN THIS URL IN YOUR BROWSER AND LOG INTO NEWSPAPERS.COM:');
  console.log('\n  ' + liveUrl + '\n');
  console.log('It is a live view of the cloud browser. Cloudflare will pass there.');
  console.log('Log in (email + password, or "Sign in with Ancestry"), confirm you');
  console.log('see your account / a subscribed page, then come back here.');
  console.log('='.repeat(70) + '\n');

  await prompt('Press Enter AFTER you have logged in and see you are subscribed... ');

  // Verify subscription state before saving.
  await page.goto('https://www.newspapers.com/', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  const status = await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    return { signedIn: !t.includes('Sign In') || t.includes('Sign Out') || t.includes('My Account') };
  }).catch(() => ({ signedIn: false }));
  console.log(status.signedIn ? '✓ Looks signed in.' : '⚠️  Could not confirm sign-in — extraction may still fail.');

  await browser.close().catch(() => {});
  // Releasing the session persists the context cookies.
  await bb('POST', `/sessions/${session.id}`, { projectId, status: 'REQUEST_RELEASE' }).catch(() => {});
  console.log(`\nDone. Context ${contextId} now holds your newspapers.com login.`);
  console.log('Extraction will reuse it automatically (no re-login needed).');
}

main().catch(e => { console.error(e.message); process.exit(1); });
