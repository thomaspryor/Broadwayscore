#!/usr/bin/env node
// scripts/ux-walkthrough.mjs — nightly signed-in UX walkthrough.
//
// Mints a real (throwaway) signed-in session against the live Supabase
// project, seeds realistic diary/watchlist/list data through it, captures a
// screenshot matrix of the signed-in surfaces on demo.broadwayscorecard.com,
// and runs the screenshots past three independent vision models (GPT-4o,
// Gemini, Claude) for a holistic UX review. Findings two-or-more models agree
// on get filed as Notion cards. The synthetic user is always torn down.
//
// This exists because narrow e2e assertions ("did the POST succeed") miss
// what a human QA pass catches by looking: flow outcomes, cross-surface
// consistency, affordance clarity, hierarchy. See card #219.
//
// v2 (card #239) adds an INTERACTIVE pass on top of the static matrix: every
// visible control gets clicked and viewport-diffed (dead-control detection),
// previously-unopened modal/sheet states get captured, cheap structural
// probes run per screenshot (sub-16px inputs, deformed toggles, impossible
// actions, horizontal overflow), and a small library of real-iOS event
// sequences (encoded from tests/e2e/my-shows-mock.spec.ts's commit-on-close
// regression spec) gets replayed against the deployed demo — headless
// WebKit/Chromium don't reproduce these quirks via device emulation alone.
// These deterministic findings are filed alongside model findings, tagged
// by detector instead of by model-agreement count.
//
// CLI:
//   --base-url <url>      defaults to https://demo.broadwayscorecard.com
//   --skip-review         seed + screenshot only, skip the LLM panel
//   --keep                skip cleanup (debugging only — leaves synthetic rows)
//   --out <dir>           screenshot/run dir (defaults to .claude/ux-walkthrough/<runId>/)
//   --selftest             calibration mode: neuters a real control's React
//                          handler in-page and asserts the interactive pass
//                          catches it as a dead control. No seeding/matrix/
//                          review. Exit 0 pass, 1 fail.
//
// Exit codes: 0 success, 1 fatal (auth/seed/capture failure), 2 review panel
// fully failed (all 3 models errored — screenshots still captured).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

function loadDotenv(path = '.env') {
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore */ }
}
loadDotenv();

function parseArgs(argv) {
  const args = { baseUrl: 'https://demo.broadwayscorecard.com', skipReview: false, keep: false, out: null, noFile: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--skip-review') args.skipReview = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--no-file') args.noFile = true; // compute findings, skip Notion writes (calibration runs)
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--selftest') args.selftest = true;
  }
  return args;
}

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!URL_ENV || !ANON) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

// ── Service-role key resolution ─────────────────────────────────────────────
// CI carries SUPABASE_SERVICE_ROLE_KEY directly as a secret. Locally it's
// usually absent (kept out of .env deliberately) — fall back to fetching it
// live via the Supabase Management API using SUPABASE_ACCESS_TOKEN, which IS
// in .env. Avoids ever needing to hand-paste the service key locally.
async function resolveServiceRoleKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set and no SUPABASE_ACCESS_TOKEN to derive it');
  const ref = process.env.SUPABASE_PROJECT_REF || new global.URL(URL_ENV).hostname.split('.')[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Management API api-keys HTTP ${res.status}`);
  const keys = await res.json();
  const svc = Array.isArray(keys) ? keys.find(k => k.name === 'service_role') : null;
  if (!svc?.api_key) throw new Error('service_role key not found in Management API response');
  return svc.api_key;
}

/** GoTrue admin call with the service-role key. */
async function adminFetch(serviceKey, method, path, body) {
  const res = await fetch(`${URL_ENV}/auth/v1/${path}`, {
    method,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function makeUser(serviceKey, tag) {
  const email = `ux-walkthrough+${tag}-${Date.now()}@bsc-test.dev`;
  const r = await adminFetch(serviceKey, 'POST', 'admin/users', {
    email, email_confirm: true,
    user_metadata: { full_name: 'UX Walkthrough Test', uxWalkthroughTest: true },
  });
  if (!r.ok || !r.json?.id) throw new Error(`createUser: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return { id: r.json.id, email };
}

/** Mint a real access token + full session object (for localStorage injection). */
async function mintSession(serviceKey, email) {
  const link = await adminFetch(serviceKey, 'POST', 'admin/generate_link', { type: 'magiclink', email });
  const hashed = link.json?.hashed_token ?? link.json?.properties?.hashed_token;
  if (!link.ok || !hashed) throw new Error(`generateLink: HTTP ${link.status} ${link.text.slice(0, 200)}`);
  const res = await fetch(`${URL_ENV}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`verify: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  // This is exactly the shape @supabase/supabase-js writes under storageKey
  // (GoTrueClient._saveSession, no userStorage configured → full session as-is).
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at,
    expires_in: json.expires_in,
    token_type: json.token_type || 'bearer',
    user: json.user,
  };
}

async function deleteUser(serviceKey, id) {
  await adminFetch(serviceKey, 'DELETE', `admin/users/${id}`);
}

// Best-effort startup sweep for synthetic users a PRIOR run failed to clean
// up (workflow timeout, runner OOM, cancellation — none of which reach the
// `finally` block in main()). Only touches accounts matching BOTH the email
// suffix AND this script's own uxWalkthroughTest tag (codex adversarial
// review, 2026-07-20: email suffix alone isn't proof this script created the
// row), older than 1h (safely past any run's ~2-5min duration — collision
// risk is a developer manually pausing a local run past 1h, an accepted edge
// case for test tooling). Enumerates ALL pages first, then deletes — deleting
// mid-pagination would shift a page-based offset and skip later-page
// survivors (same codex finding). Never throws.
async function sweepOrphanedTestUsers(serviceKey) {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const toDelete = [];
    let page = 1;
    for (;;) {
      const r = await adminFetch(serviceKey, 'GET', `admin/users?page=${page}&per_page=200`);
      const users = r.json?.users;
      if (!r.ok) { console.error(`[ux-walkthrough] orphan sweep: admin/users page ${page} HTTP ${r.status} — stopping early`); break; }
      if (!Array.isArray(users) || users.length === 0) break;
      for (const u of users) {
        if (!u.email?.endsWith('@bsc-test.dev')) continue;
        if (!u.user_metadata?.uxWalkthroughTest) continue;
        if (new Date(u.created_at).getTime() >= cutoff) continue;
        toDelete.push(u.id);
      }
      if (users.length < 200) break;
      page++;
    }
    let swept = 0;
    for (const id of toDelete) {
      // deleteUser() discards adminFetch's result, so an HTTP-level failure
      // wouldn't surface here — check r.ok directly so `swept` can't
      // over-report (codex finding, 2026-07-20).
      const r = await adminFetch(serviceKey, 'DELETE', `admin/users/${id}`).catch(() => ({ ok: false }));
      if (r.ok) swept++;
    }
    if (swept > 0) console.error(`[ux-walkthrough] swept ${swept} orphaned @bsc-test.dev user(s) from prior run(s)`);
  } catch (err) {
    console.error(`[ux-walkthrough] orphan sweep failed (non-fatal): ${err.message}`);
  }
}

/** One PostgREST call with a user JWT — mirrors src/lib/supabase-rest.ts. */
async function rest(token, method, path, body, prefer = 'return=representation') {
  const res = await fetch(`${URL_ENV}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ── Seed data ────────────────────────────────────────────────────────────────
// All show IDs below are stable, always-present shows verified against
// data/shows.json (CLAUDE.md §3: never stub show IDs from memory).
function isoDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function seedReviews(token, userId) {
  const results = [];
  // 15 reviews spread across ~3 years (0 to ~1090 days ago), mixing whole and
  // half-star ratings, some with notes, one deliberate multi-viewing pair
  // (same show, two different date_seen — real repeat-viewer behavior).
  const plan = [
    { show: 'hamilton-2015', daysAgo: 20, rating: 5, text: 'Still the best thing on Broadway.' },
    { show: 'hamilton-2015', daysAgo: 730, rating: 4.5, text: 'First time seeing it — worth the hype.' }, // multi-viewing pair
    { show: 'wicked-2003', daysAgo: 45, rating: 4, text: null },
    { show: 'the-lion-king-1997', daysAgo: 90, rating: 4.5, text: 'Took the kids, they loved it.' },
    { show: 'chicago-1996', daysAgo: 150, rating: 3.5, text: null },
    { show: 'aladdin-2014', daysAgo: 200, rating: 4, text: 'Genie stole the show.' },
    { show: 'six-2021', daysAgo: 260, rating: 5, text: 'Obsessed.' },
    { show: 'moulin-rouge-2019', daysAgo: 320, rating: 4.5, text: null },
    { show: 'hadestown-2019', daysAgo: 400, rating: 5, text: 'Best score in years.' },
    { show: 'the-outsiders-2024', daysAgo: 10, rating: 4, text: null },
    { show: 'stereophonic-2024', daysAgo: 500, rating: 3, text: 'Long, but the acting is great.' },
    { show: 'water-for-elephants-2024', daysAgo: 600, rating: 3.5, text: null },
    { show: 'waitress-2016', daysAgo: 900, rating: 4, text: null },
    { show: 'dear-evan-hansen-2016', daysAgo: 1000, rating: 4.5, text: 'Cried three times.' },
    { show: 'chicago-1996', daysAgo: 1080, rating: 3, text: 'Earlier cast — different vibe.' }, // second Chicago viewing
  ];
  for (const p of plan) {
    const r = await rest(token, 'POST', 'reviews', {
      user_id: userId, show_id: p.show, rating: p.rating, review_text: p.text, date_seen: isoDate(p.daysAgo),
    });
    if (r.ok) results.push({ table: 'reviews', id: Array.isArray(r.json) ? r.json[0]?.id : r.json?.id });
    else console.error(`[seed] review insert failed (${p.show}): HTTP ${r.status} ${r.text.slice(0, 150)}`);
  }
  return results;
}

async function seedWatchlist(token, userId) {
  const results = [];
  const plan = [
    { show: 'the-outsiders-2024', plannedDate: null }, // no date — "someday" entry
    { show: 'six-2021', plannedDate: isoDate(-30) },   // 30 days in the future → "Upcoming"
    { show: 'moulin-rouge-2019', plannedDate: isoDate(5) }, // 5 days ago, no review → "To be rated"
  ];
  for (const p of plan) {
    const r = await rest(token, 'POST', 'watchlist', { user_id: userId, show_id: p.show, planned_date: p.plannedDate });
    if (r.ok) results.push({ table: 'watchlist', id: Array.isArray(r.json) ? r.json[0]?.id : r.json?.id, show_id: p.show });
    else console.error(`[seed] watchlist insert failed (${p.show}): HTTP ${r.status} ${r.text.slice(0, 150)}`);
  }
  return results;
}

async function seedPublicList(token, userId) {
  const results = [];
  const lIns = await rest(token, 'POST', 'lists', { user_id: userId, name: 'UX Walkthrough Faves', is_public: true, share_slug: `uxw-${Date.now()}` });
  const listId = Array.isArray(lIns.json) ? lIns.json[0]?.id : null;
  if (!lIns.ok || !listId) {
    console.error(`[seed] list create failed: HTTP ${lIns.status} ${lIns.text.slice(0, 150)}`);
    return results;
  }
  results.push({ table: 'lists', id: listId });
  let position = 1000;
  for (const show of ['hamilton-2015', 'hadestown-2019', 'six-2021']) {
    const li = await rest(token, 'POST', 'list_items', { list_id: listId, show_id: show, position });
    position += 1000;
    if (li.ok) results.push({ table: 'list_items', id: Array.isArray(li.json) ? li.json[0]?.id : li.json?.id });
  }
  return results;
}

// ── Screenshot matrix ───────────────────────────────────────────────────────
const VIEWPORTS = [{ label: 'mobile', width: 390, height: 844 }, { label: 'desktop', width: 1440, height: 900 }];

async function withPage(browser, session, viewport, fn) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  // Injected before any page script runs on every navigation in this context —
  // sets the exact key src/lib/supabase.ts reads (storageKey: 'bsc_auth').
  await context.addInitScript((sessionJson) => {
    window.localStorage.setItem('bsc_auth', sessionJson);
  }, JSON.stringify(session));
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

async function shoot(page, outDir, name) {
  const file = join(outDir, `${name}.png`);
  // Cap capture height: Anthropic's vision API rejects images with any
  // dimension > 8000px — oversized fullPage shots 400'd the Claude reviewer
  // out of every run, silently degrading the panel to 2 models (verification,
  // 2026-07-20). Capture full page first, then check the REAL rendered height
  // from the PNG header and re-capture clipped if oversized — scrollHeight
  // can't be trusted (the bottom-sheet scroll lock made it report 844 while
  // fullPage rendered 10935). 4000px keeps everything reviewers need and is
  // consistent input for all three models.
  const MAX_CAPTURE_HEIGHT = 4000;
  await page.screenshot({ path: file, fullPage: true });
  const header = readFileSync(file).subarray(16, 24);
  const pngHeight = header.readUInt32BE(4);
  if (pngHeight > MAX_CAPTURE_HEIGHT) {
    const vp = page.viewportSize();
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: vp.width, height: MAX_CAPTURE_HEIGHT } });
  }
  return file;
}

// ── Interactive pass ─────────────────────────────────────────────────────────
// Static screenshots only prove a screen *rendered* — they can't catch a
// control whose handler does nothing, or does something off-viewport. Click
// every visible enabled control and diff the VIEWPORT (not fullPage — an
// effect that lands 2000px below the fold reads as "nothing happened" to the
// user looking at their screen, which is exactly the +Add card bug this
// exists to catch; card #239 evidence).
const DESTRUCTIVE_LABEL_PATTERNS = [
  /delete rating/i, /remove from watchlist/i, /delete list/i,
  /remove show/i, /delete this rating/i, /sign out/i,
];
const INTERACTIVE_PASS_CAP = 20;

function escapeAttr(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/** Enumerate visible, enabled, labeled buttons/links — the interactive surface a user actually sees. */
async function discoverInteractiveTargets(page) {
  return page.evaluate((patterns) => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('button, a[href]')) {
      if (el.disabled) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // A control that already represents the CURRENT state (the active tab,
      // the pressed toggle) legitimately no-ops when clicked again — that's
      // not a dead control, it's an idempotent re-selection. Standard ARIA
      // state attributes are the generic, app-agnostic signal for this.
      if (el.getAttribute('aria-selected') === 'true') continue;
      if (el.getAttribute('aria-pressed') === 'true') continue;
      if (el.getAttribute('aria-checked') === 'true' && el.getAttribute('role') !== 'switch') continue;
      if (el.hasAttribute('aria-current')) continue;
      // Date-picker triggers (DatePickerButton) open the OS-native picker via
      // showPicker()/focus() on a sibling hidden `input[type=date]` — that UI
      // is outside the DOM, so a correct click is byte-identical to a dead
      // one in a headless screenshot. Structural detection (sibling date
      // input) generalizes across every trigger label ("Add date", "Edit
      // date", ...) instead of hardcoding text (adversarial review finding,
      // 2026-07-21 — confirmed false-positive on "Add date").
      if (el.parentElement?.querySelector('input[type="date"]')) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!label) continue;
      if (patterns.some(p => new RegExp(p.source, p.flags).test(label))) continue;
      const key = `${el.tagName}::${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tag: el.tagName.toLowerCase(), label, hasAriaLabel: !!el.getAttribute('aria-label') });
    }
    return out;
  }, DESTRUCTIVE_LABEL_PATTERNS.map(p => ({ source: p.source, flags: p.flags })));
}

function locateTarget(page, target) {
  // :visible matters here, not just style: this app renders duplicate
  // same-label controls for different breakpoints (e.g. two "Grid view"
  // buttons — one for the desktop-inline row, one for the mobile row —
  // sharing an aria-label, with the inactive one collapsed to a 0x0 rect by
  // its hidden ancestor rather than removed from the DOM). Without :visible,
  // .first() returns DOM order, which can be the 0x0 one; a real click on it
  // is a no-op that Playwright's actionability check rejects, swallowed by
  // testControlForDeadness's .catch() — screenshots then look byte-identical
  // and a genuinely-working control files as a false dead-control (confirmed
  // reproducible on demo.broadwayscorecard.com, 2026-07-21 — increasing the
  // post-click wait had zero effect, which is what exposed this as a
  // selector bug rather than a render-timing race).
  if (target.hasAriaLabel) {
    return page.locator(`${target.tag}[aria-label="${escapeAttr(target.label)}"]:visible`).first();
  }
  return page.locator(`${target.tag}:visible`).filter({ hasText: target.label }).first();
}

/** Click one control, viewport-diff before/after. Navigation always counts as a visible change. */
async function testControlForDeadness(page, target) {
  const loc = locateTarget(page, target);
  if (await loc.count() === 0) return null;
  const beforeUrl = page.url();
  // Park the pointer off-element before EITHER screenshot: Playwright's
  // .click() leaves the mouse hovering the target, and hover:scale/shadow
  // styles (btn-primary etc.) make virtually every button "change" on click
  // regardless of whether its handler fired — silently defeating the whole
  // detector (a real dead control masked as "changed" by its own hover
  // state; caught by --selftest, 2026-07-20). 250ms covers the app's
  // standard `transition-all duration-200`.
  await page.mouse.move(0, 0).catch(() => {});
  await page.waitForTimeout(250);
  let before;
  try { before = await page.screenshot({ fullPage: false }); } catch { return null; }
  await loc.click({ timeout: 5000 }).catch(() => {});
  // 1500ms, matching this file's own convention for post-interaction settle
  // waits elsewhere (captureMatrix uses 1200-1500ms after navigations). Live
  // verification runs against the real demo showed the Grid/List view
  // re-render intermittently landing after 600-1000ms under real network/
  // data-fetch load, occasionally misclassifying a working toggle as dead —
  // adversarial review's timing-budget concern, confirmed empirically
  // 2026-07-21 (flagged on ~1-2 of ~60 controls per run, not the same
  // control every run — a genuine timing flake, not a logic bug: DOM
  // inspection confirmed aria-pressed correctly reflects state and only the
  // truly-visible mobile toggle is ever selected as the test target).
  await page.waitForTimeout(1500);
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl) return { dead: false, navigated: true };
  await page.mouse.move(0, 0).catch(() => {});
  await page.waitForTimeout(250);
  let after;
  try { after = await page.screenshot({ fullPage: false }); } catch { return null; }
  // Raw-byte equality as the "pixel diff": two headless screenshots of the
  // same deterministic render, with the pointer parked in the same neutral
  // spot for both, are byte-identical iff nothing painted differently — no
  // pixelmatch dependency needed for a binary "did anything change" check.
  return { dead: before.equals(after) };
}

// Worst case per control (20s goto timeout + 1.2s settle + 5s click timeout
// + 0.6s + mouse-park pauses) is far above the typical case — cap wall-clock
// per state so a degraded demo instance can't burn the whole run here alone
// (ship-check finding, 2026-07-21: unbounded, 3 states × 20 controls could
// exceed the 15-minute run budget on a slow runner with no early exit).
const INTERACTIVE_PASS_BUDGET_MS = 4 * 60 * 1000;

async function runInteractivePass(page, stateUrl, vpLabel, stateName) {
  const findings = [];
  const targets = await discoverInteractiveTargets(page);
  const capped = targets.slice(0, INTERACTIVE_PASS_CAP);
  if (targets.length > capped.length) {
    console.error(`[ux-walkthrough] interactive pass: ${stateName}/${vpLabel} has ${targets.length} controls, testing first ${capped.length}`);
  }
  const deadline = Date.now() + INTERACTIVE_PASS_BUDGET_MS;
  let tested = 0;
  let budgetHit = false;
  for (let i = 0; i < capped.length; i++) {
    if (Date.now() > deadline) {
      budgetHit = true;
      console.error(`[ux-walkthrough] interactive pass ${stateName}/${vpLabel}: hit ${INTERACTIVE_PASS_BUDGET_MS / 1000}s budget after ${tested}/${capped.length} controls — stopping early`);
      break;
    }
    if (i > 0) {
      // Reset between controls so one click's side effects can't mask or
      // fake out the next control's before/after diff.
      await page.goto(stateUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    const target = capped[i];
    const result = await testControlForDeadness(page, target);
    if (!result) continue;
    tested++;
    if (result.dead) {
      findings.push({
        summary: `Dead control: "${target.label}" (${target.tag}) on ${stateName} produced no visible change in the ${vpLabel} viewport after clicking (no navigation, no repaint)`,
        screenshot: `${vpLabel}__${stateName}`,
        severity: 'high',
        tag: 'dead-control',
      });
    }
  }
  console.error(`[ux-walkthrough] interactive pass ${stateName}/${vpLabel}: tested ${tested} control(s), ${findings.length} dead${budgetHit ? ' (budget-limited)' : ''}`);
  return findings;
}

// ── Static probes ────────────────────────────────────────────────────────────
// Cheap page.evaluate() checks that don't need a model opinion — deterministic
// structural facts a vision model can plausibly miss (a 15px input, a
// squashed toggle) or has no way to know (a future planned_date sitting next
// to a rate-stars control implies an impossible action a static crop can't
// reveal without the surrounding data).
async function probeFontSizeFloor(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], input[type="password"], input:not([type]), textarea')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = parseFloat(window.getComputedStyle(el).fontSize);
      if (size < 16) {
        out.push({ tag: el.tagName.toLowerCase(), fontSize: size, name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '(unlabeled)' });
      }
    }
    return out;
  });
}

async function probeDeformedToggles(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="switch"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const ratio = rect.width / rect.height;
      // A pill toggle reads ~1.6-2.3x wider than tall; tap-minimum CSS (e.g.
      // min-height:44px on the button) squashes it toward square/tall without
      // touching its declared width — ratio collapse is the tell.
      if (ratio < 1.4 || ratio > 3.0) {
        out.push({ label: el.getAttribute('aria-label') || el.closest('div')?.textContent?.trim().slice(0, 40) || '(unlabeled toggle)', width: rect.width, height: rect.height, ratio: Math.round(ratio * 100) / 100 });
      }
    }
    return out;
  });
}

async function probeImpossibleRatingActions(page) {
  return page.evaluate(() => {
    const out = [];
    for (const g of document.querySelectorAll('[role="radiogroup"]')) {
      const label = g.getAttribute('aria-label') || '';
      if (!/^rate /i.test(label)) continue;
      let container = g;
      for (let i = 0; i < 6 && container.parentElement; i++) container = container.parentElement;
      const text = container.textContent || '';
      if (/upcoming/i.test(text)) {
        out.push({ label, context: text.replace(/\s+/g, ' ').slice(0, 120) });
      }
    }
    return out;
  });
}

async function probeHorizontalOverflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    return overflow > 1 ? { overflowPx: overflow } : null;
  });
}

async function probeAutofocusOffViewport(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return null;
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '(unlabeled)',
      top: Math.round(r.top), bottom: Math.round(r.bottom), viewportHeight: window.innerHeight,
    };
  });
}

async function runStaticProbes(page, vpLabel, stateName) {
  const findings = [];

  if (vpLabel === 'mobile') {
    for (const f of await probeFontSizeFloor(page)) {
      findings.push({
        summary: `Sub-16px text input on mobile: <${f.tag}> "${f.name}" renders at ${f.fontSize}px font-size on ${stateName} — iOS Safari auto-zooms the viewport on focus below 16px`,
        screenshot: `${vpLabel}__${stateName}`, severity: 'medium', tag: 'probe',
      });
    }
  }

  for (const t of await probeDeformedToggles(page)) {
    findings.push({
      summary: `Deformed toggle on ${stateName} (${vpLabel}): "${t.label}" renders ${t.width}x${t.height} (aspect ${t.ratio}) — outside the expected pill-toggle ratio, likely squashed by a tap-minimum`,
      screenshot: `${vpLabel}__${stateName}`, severity: 'medium', tag: 'probe',
    });
  }

  for (const r of await probeImpossibleRatingActions(page)) {
    findings.push({
      summary: `Impossible action on ${stateName} (${vpLabel}): "${r.label}" rate-stars control renders inside an Upcoming (future-dated, unseen) entry — context: "${r.context}"`,
      screenshot: `${vpLabel}__${stateName}`, severity: 'high', tag: 'probe',
    });
  }

  const overflow = await probeHorizontalOverflow(page);
  if (overflow) {
    findings.push({
      summary: `Horizontal overflow on ${stateName} (${vpLabel}): page scrollWidth exceeds clientWidth by ${overflow.overflowPx}px`,
      screenshot: `${vpLabel}__${stateName}`, severity: 'medium', tag: 'probe',
    });
  }

  return findings;
}

// ── iOS quirk simulation library ─────────────────────────────────────────────
// Headless WebKit/Chromium don't replicate real iOS Safari input semantics
// via device emulation alone. Each quirk is instead encoded as the exact DOM
// event sequence real iOS fires — verified against
// tests/e2e/my-shows-mock.spec.ts's "touch commit-on-close" regression spec,
// which reproduces the actual 2026-07-20 incident — and replayed against the
// real deployed page.
async function simulateIosDateWheelCommitOnOpen(page) {
  return page.evaluate(async () => {
    const panel = document.querySelector('[data-testid="my-shows-content"]') || document.body;
    // Scope to the "Not yet booked" card specifically — the same lookup the
    // e2e regression spec uses. A bare first-date-input-on-page query picks
    // up the Upcoming entry instead (it renders above Not-yet-booked and
    // already has a set date), testing the wrong card's picker entirely
    // (ship-check finding, 2026-07-21).
    const nb = [...panel.querySelectorAll('h3')].find(h => /not yet booked/i.test(h.textContent || ''))?.parentElement;
    const input = nb?.querySelector('input[type="date"]');
    if (!input) return { skipped: 'no "Not yet booked" date input on page' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    // Diff against the WHOLE panel, not just `nb` — a commit-on-open re-sort
    // can move the card OUT of the Not-yet-booked section entirely (the
    // original incident), which changes panel content but may leave the `nb`
    // node reference stale/detached rather than reflecting the removal.
    const beforeText = panel.textContent || '';
    // iOS: `change` fires with TODAY the instant the wheel opens, before the
    // user has picked anything.
    const today = new Date().toISOString().split('T')[0];
    setter.call(input, today);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const committedMidWheel = (panel.textContent || '') !== beforeText;
    // User scrolls to a real date and closes the wheel (blur/focusout).
    const future = new Date(); future.setDate(future.getDate() + 60);
    const futureStr = future.toISOString().split('T')[0];
    setter.call(input, futureStr);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    return { committedMidWheel, futureStr };
  });
}

// Interactive pass + Create List/Import modal captures run on mobile only.
// Desktop row/card action icons are hover-revealed by design (see RUBRIC note
// below) so "visible enabled controls" isn't a stable set there without
// simulating a hover per element; mobile is also where the motivating +Add
// card bug actually happened. Scoping decision, logged so it isn't a silent
// cap.
async function captureMatrix({ browser, session, baseUrl, outDir }) {
  const shots = [];
  const findings = [];
  console.error('[ux-walkthrough] interactive pass + Create List/Import sheet capture: mobile viewport only (desktop actions are hover-revealed, not a stable static target set)');
  for (const vp of VIEWPORTS) {
    await withPage(browser, session, vp, async (page) => {
      const pushShot = async (name) => {
        shots.push({ name, file: await shoot(page, outDir, name) });
        findings.push(...await runStaticProbes(page, vp.label, name.replace(`${vp.label}__`, '')));
      };

      // ── my-shows: diary, grid + list ──
      await page.goto(`${baseUrl}/my-shows?tab=diary`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      await pushShot(`${vp.label}__diary_grid`);

      // ── Import sheet — never opened by the matrix before card #239 ──
      const importBtn = page.getByText('Import from Show Score or Mezzanine', { exact: true }).first();
      if (await importBtn.count() > 0) {
        await importBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        await pushShot(`${vp.label}__import_sheet`);
        const cancelBtn = page.getByText('Cancel', { exact: true }).first();
        if (await cancelBtn.count() > 0) await cancelBtn.click().catch(() => {});
        await page.waitForTimeout(300);
      }

      const listToggle = page.locator('[aria-label="List view"]:visible').first();
      if (await listToggle.count() > 0) {
        await listToggle.click().catch(() => {});
        await page.waitForTimeout(500);
        await pushShot(`${vp.label}__diary_list`);
      }

      // Editor open — click the first "Edit rating" affordance. For most rows
      // this is a Next.js <Link> to the show page with ?edit=1 (client-side
      // route change, NOT a browser navigation — waitForNavigation's 'load'
      // event never fires for it). ShowHeroRedesign's autoEditLatest effect
      // opens the panel only once its own getReviewsForShow() fetch resolves,
      // so poll the URL + the testid rather than waiting on a load event.
      const editBtn = page.locator('[aria-label="Edit rating"]:visible').first();
      if (await editBtn.count() > 0) {
        await editBtn.click().catch(() => {});
        await page.waitForURL(/\/show\//, { timeout: 10000 }).catch(() => {});
        const editorVisible = await page.locator('[data-testid="rating-editor"]').first()
          .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (!editorVisible) console.error(`[ux-walkthrough] WARN: rating-editor testid never appeared at ${vp.label} (url=${page.url()})`);
        await page.waitForTimeout(400);
        await pushShot(`${vp.label}__rating_editor`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        // The click navigated away from /my-shows — go back for the delete-confirm capture below.
        await page.goto(`${baseUrl}/my-shows?tab=diary`, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }

      // Delete confirm state — click "Delete rating", capture the inline confirm,
      // then dismiss with "No" so the seeded row survives for cleanup.
      const delBtn = page.locator('[aria-label="Delete rating"]:visible').first();
      if (await delBtn.count() > 0) {
        await delBtn.click().catch(() => {});
        await page.waitForTimeout(300);
        await pushShot(`${vp.label}__delete_confirm`);
        const noBtn = page.getByText('No', { exact: true }).first();
        if (await noBtn.count() > 0) await noBtn.click().catch(() => {});
      }

      // ── Interactive pass: click every visible enabled control on diary_grid ──
      if (vp.label === 'mobile') {
        await page.goto(`${baseUrl}/my-shows?tab=diary`, { waitUntil: 'load', timeout: 20000 });
        await page.waitForTimeout(1200);
        findings.push(...await runInteractivePass(page, `${baseUrl}/my-shows?tab=diary`, vp.label, 'diary_grid'));
      }

      // ── my-shows: watchlist, grid + list ──
      await page.goto(`${baseUrl}/my-shows?tab=watchlist`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      await pushShot(`${vp.label}__watchlist_grid`);

      if (vp.label === 'desktop') {
        // Grid hover state — chromium-only, real mouse hover over the first card.
        const firstCard = page.locator('[data-testid="my-shows-content"] a').first();
        if (await firstCard.count() > 0) {
          await firstCard.hover().catch(() => {});
          await page.waitForTimeout(300);
          await pushShot(`${vp.label}__watchlist_grid_hover`);
        }
      }

      // ── Date-picker trigger state — never opened by the matrix before
      // card #239. The native OS picker itself isn't capturable in a
      // headless screenshot (it's outside the DOM); this proves the trigger
      // opens without erroring and feeds the probe/iOS-sim layers.
      const addDateBtn = page.getByText('Add date', { exact: true }).first();
      if (await addDateBtn.count() > 0) {
        await addDateBtn.click().catch(() => {});
        await page.waitForTimeout(400);
        await pushShot(`${vp.label}__date_picker_trigger`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      }

      const wListToggle = page.locator('[aria-label="List view"]:visible').first();
      if (await wListToggle.count() > 0) {
        await wListToggle.click().catch(() => {});
        await page.waitForTimeout(500);
        await pushShot(`${vp.label}__watchlist_list`);
      }

      // ── Interactive pass: watchlist_grid — this is the state the
      // motivating +Add card bug lived on (card #239 evidence). ──
      if (vp.label === 'mobile') {
        await page.goto(`${baseUrl}/my-shows?tab=watchlist`, { waitUntil: 'load', timeout: 20000 });
        await page.waitForTimeout(1200);
        findings.push(...await runInteractivePass(page, `${baseUrl}/my-shows?tab=watchlist`, vp.label, 'watchlist_grid'));
      }

      // ── my-shows: lists tab ──
      await page.goto(`${baseUrl}/my-shows?tab=lists`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1200);
      await pushShot(`${vp.label}__lists_tab`);

      // ── Create List sheet — never opened by the matrix before card #239;
      // the deformed-toggle bug (Ranked toggle) lived here and was invisible
      // to a matrix that never opened the modal.
      const newListBtn = page.getByText('New list', { exact: true }).first();
      if (await newListBtn.count() > 0) {
        await newListBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        await pushShot(`${vp.label}__create_list_sheet`);
        const autofocusIssue = await probeAutofocusOffViewport(page).catch(() => null);
        if (autofocusIssue) {
          findings.push({
            summary: `iOS quirk: autofocused <${autofocusIssue.tag}> "${autofocusIssue.label}" in the Create List sheet (${vp.label}) sits outside the viewport (top=${autofocusIssue.top}, bottom=${autofocusIssue.bottom}) — iOS Safari does not auto-scroll to reveal it, unlike this Chromium capture`,
            screenshot: `${vp.label}__create_list_sheet`, severity: 'medium', tag: 'ios-quirk',
          });
        }
        const cancelBtn = page.getByText('Cancel', { exact: true }).first();
        if (await cancelBtn.count() > 0) await cancelBtn.click().catch(() => {});
        await page.waitForTimeout(300);

        if (vp.label === 'mobile') {
          await page.goto(`${baseUrl}/my-shows?tab=lists`, { waitUntil: 'load', timeout: 20000 });
          await page.waitForTimeout(1000);
          findings.push(...await runInteractivePass(page, `${baseUrl}/my-shows?tab=lists`, vp.label, 'lists_tab'));
        }
      }

      // ── show page (rated + watchlisted show) ──
      await page.goto(`${baseUrl}/show/hamilton`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      await pushShot(`${vp.label}__show_hero_rated`);

      // ── browse / homepage, signed-in ──
      await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      await pushShot(`${vp.label}__homepage_signed_in`);
    });
  }
  return { shots, findings };
}

// The date-wheel-commit-on-open quirk only exists on the coarse-pointer code
// path (DatePickerButton's isCoarse() check) — needs its own hasTouch/isMobile
// context. Isolated from captureMatrix's main pass deliberately: changing
// pointer emulation for the whole matrix would shift how every `(pointer:
// coarse)` CSS branch renders at "mobile" width, which is exactly the
// surface the model panel and calibration are tuned against.
async function captureIosDateWheelSim({ browser, session, baseUrl, outDir }) {
  const vp = VIEWPORTS.find(v => v.label === 'mobile');
  const shots = [];
  const findings = [];
  // newContext/newPage/addInitScript inside the try: a throw here (browser
  // crashed, OOM) used to escape uncaught past this function into main()'s
  // unguarded finally, losing every screenshot captureMatrix already took
  // (manifest.json/review.json never get written) — ship-check finding,
  // 2026-07-21.
  let context;
  try {
    context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true });
    await context.addInitScript((sessionJson) => {
      window.localStorage.setItem('bsc_auth', sessionJson);
    }, JSON.stringify(session));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/my-shows?tab=watchlist`, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1500);
    const result = await simulateIosDateWheelCommitOnOpen(page).catch(err => ({ error: err.message }));
    const name = 'mobile__ios_date_wheel_sim';
    shots.push({ name, file: await shoot(page, outDir, name) });
    if (result?.committedMidWheel) {
      findings.push({
        summary: `iOS quirk regression: date-wheel commit-on-open reproduced on watchlist_grid (mobile, touch context) — the picker committed TODAY before a date was picked, matching the 2026-07-20 incident`,
        screenshot: name, severity: 'high', tag: 'ios-quirk',
      });
    } else if (result?.skipped) {
      console.error(`[ux-walkthrough] iOS date-wheel sim skipped: ${result.skipped}`);
    } else if (result?.error) {
      console.error(`[ux-walkthrough] iOS date-wheel sim errored: ${result.error}`);
    }
  } catch (err) {
    console.error(`[ux-walkthrough] iOS date-wheel sim failed: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  return { shots, findings };
}

// Signed-out context — captures the sign-in modal, which the matrix (always
// signed-in) never opens. Desktop: direct "Sign in" pill. Mobile: that pill
// is `hidden sm:flex` (header space, owner 2026-07-12) so sign-in lives in
// the hamburger menu instead.
async function captureSignInModal({ browser, baseUrl, outDir }) {
  const shots = [];
  const findings = [];
  for (const vp of VIEWPORTS) {
    // newContext/newPage inside the try (same fix as captureIosDateWheelSim,
    // ship-check finding 2026-07-21): a throw here used to escape uncaught
    // into main()'s unguarded finally.
    let context;
    try {
      context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1000);
      if (vp.label === 'mobile') {
        const menuBtn = page.locator('[aria-label="Open menu"]:visible').first();
        if (await menuBtn.count() === 0) { console.error(`[ux-walkthrough] sign-in modal (mobile): no hamburger trigger found`); continue; }
        await menuBtn.click().catch(() => {});
        await page.waitForTimeout(400);
        const signInBtn = page.getByText('Sign In', { exact: true }).first();
        if (await signInBtn.count() === 0) { console.error(`[ux-walkthrough] sign-in modal (mobile): no Sign In item in hamburger menu`); continue; }
        await signInBtn.click().catch(() => {});
      } else {
        const signInBtn = page.locator('[aria-label="Sign in"]:visible').first();
        if (await signInBtn.count() === 0) { console.error(`[ux-walkthrough] sign-in modal (desktop): no Sign in trigger found`); continue; }
        await signInBtn.click().catch(() => {});
      }
      await page.waitForTimeout(500);
      const name = `${vp.label}__sign_in_modal`;
      shots.push({ name, file: await shoot(page, outDir, name) });
      findings.push(...await runStaticProbes(page, vp.label, 'sign_in_modal'));
      const autofocusIssue = await probeAutofocusOffViewport(page).catch(() => null);
      if (autofocusIssue) {
        findings.push({
          summary: `iOS quirk: autofocused <${autofocusIssue.tag}> "${autofocusIssue.label}" in the sign-in modal (${vp.label}) sits outside the viewport (top=${autofocusIssue.top}, bottom=${autofocusIssue.bottom})`,
          screenshot: name, severity: 'medium', tag: 'ios-quirk',
        });
      }
    } catch (err) {
      console.error(`[ux-walkthrough] sign-in modal capture (${vp.label}) failed: ${err.message}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }
  return { shots, findings };
}

// ── Multi-model review panel ────────────────────────────────────────────────
const RUBRIC = `You are reviewing screenshots of a signed-in Broadway show-tracking web app (Broadwayscorecard). A user rates/reviews shows they've seen, keeps a watchlist with planned dates, and can share public lists.

Screenshots are labeled <viewport>__<surface>, e.g. "mobile__diary_grid" or "desktop__rating_editor". Viewports: mobile=390px, desktop=1440px.

Review across these dimensions:
1. HIERARCHY — is the most important info (show title, rating, action) the most visually prominent? Is anything buried that shouldn't be, or loud that shouldn't be (e.g. a date more prominent than the show title)?
2. CONSISTENCY ACROSS VIEWS/BREAKPOINTS — FIRST inventory the recurring components (star rows, badges, buttons, dates, posters) and explicitly compare each one's SIZE, color, and style across every screenshot at the SAME viewport: e.g. are the stars in desktop__diary_list the same size as the stars in desktop__to_be_rated and desktop__diary_grid? A component rendered noticeably larger/smaller in one sibling view than everywhere else is ALWAYS a finding. The SAME action must use the SAME icon everywhere: e.g. if removing a card is a trash icon on one card type and an X on another, that is ALWAYS a finding. Cross-surface parity issues (e.g. an icon present in grid but missing in list) belong here too. NOTE: desktop row/card action icons are hover-revealed by design — do not flag them as "missing" from static desktop screenshots.
3. AFFORDANCE CLARITY — do interactive elements look tappable/clickable? Is a destructive action (delete) clearly different from a safe one, and does its confirm step read as an obvious "are you sure," not just a color change?
4. FEEDBACK AFTER ACTION — after clicking ANYTHING, did visible feedback occur IN VIEWPORT (not somewhere below the fold that requires scrolling to notice)? After adding/rating/removing a show specifically, is there visible confirmation, and does the item land somewhere sensible (not buried mid-list with no signal it moved)?
5. DEAD ENDS — any screen where a signed-in user has no obvious next action?
6. 12PX FLOOR — any text that looks smaller than ~12px, especially on mobile.
7. DESIGN TOKENS — hardcoded-looking colors that don't match the app's dark score-card aesthetic (unexpected zinc/slate grays, off-brand reds/greens).
8. IMPOSSIBLE ACTIONS — does any control imply an action the user can't actually take right now? E.g. a "rate this" star control on a show that's Upcoming/unseen, an editable-looking field for read-only data, a delete affordance on something that isn't actually removable from this screen.

Return ONLY a JSON object: {"findings": [{"summary": "...", "screenshot": "<label of the most relevant screenshot>", "severity": "high"|"medium"|"low"}]}. Max 8 findings. Be specific — quote what you see, don't speculate. If you see nothing worth flagging in a dimension, skip it. No markdown fencing, no commentary.`;

function imageToBase64(path) {
  return readFileSync(path).toString('base64');
}

function parseFindingsJson(content) {
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  const parsed = JSON.parse(s);
  if (!parsed || !Array.isArray(parsed.findings)) throw new Error('missing findings array');
  return parsed.findings.map(f => ({
    summary: String(f.summary || '').trim(),
    screenshot: String(f.screenshot || '').trim(),
    severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
  })).filter(f => f.summary);
}

// Send the full matrix — ~19-25 screenshots is well within each model's
// image-input limits, and a positional slice() silently drops whichever
// surfaces happen to land last (shots is mobile-then-desktop ordered, so an
// early cap always cut the same desktop screens — ship-check finding,
// 2026-07-20). If the matrix grows enough to need capping again, cap by
// deduping near-identical surfaces, not by truncating the list.
function pickReviewImages(shots) {
  return shots;
}

async function reviewWithOpenAI(shots, apiKey) {
  const images = pickReviewImages(shots);
  const content = [
    { type: 'text', text: RUBRIC },
    ...images.flatMap(s => [
      { type: 'text', text: `Screenshot: ${s.name}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageToBase64(s.file)}` } },
    ]),
  ];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o', temperature: 0.3, max_tokens: 1500, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  return parseFindingsJson(text);
}

async function reviewWithGemini(shots, apiKey) {
  const images = pickReviewImages(shots);
  const parts = [{ text: RUBRIC }];
  for (const s of images) {
    parts.push({ text: `Screenshot: ${s.name}` });
    parts.push({ inlineData: { mimeType: 'image/png', data: imageToBase64(s.file) } });
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // gemini-2.5-pro's mandatory "thinking" phase eats into maxOutputTokens
    // before any visible text — a low budget here (e.g. 1500) can burn it
    // all on thinking and return content with no `parts` at all (see
    // scripts/visual-qa.mjs's reviewWithGemini comment for the same gotcha).
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini returned no content (finishReason=${body?.candidates?.[0]?.finishReason}, ${JSON.stringify(body).slice(0, 200)})`);
  return parseFindingsJson(text);
}

async function reviewWithClaude(shots, apiKey) {
  const images = pickReviewImages(shots);
  const content = [{ type: 'text', text: RUBRIC }];
  for (const s of images) {
    content.push({ type: 'text', text: `Screenshot: ${s.name}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageToBase64(s.file) } });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    // max_tokens 6000: sonnet-5 auto-engages extended thinking on the 19-image
    // review and 1500 tokens were consumed ENTIRELY by the thinking block —
    // the response had no text and the reviewer errored 'no content' every
    // run (verification, 2026-07-20). Budget must cover thinking + answer.
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 6000, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body?.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no content');
  return parseFindingsJson(text);
}

async function runReviewPanel(shots) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  const runOne = async (label, fn) => {
    try {
      const findings = await fn();
      console.error(`[ux-walkthrough] ${label}: ${findings.length} finding(s)`);
      return { model: label, findings, error: null };
    } catch (err) {
      console.error(`[ux-walkthrough] ${label} FAILED: ${err.message}`);
      return { model: label, findings: [], error: err.message };
    }
  };

  const [openai, gemini, claude] = await Promise.all([
    openaiKey ? runOne('gpt-4o', () => reviewWithOpenAI(shots, openaiKey)) : Promise.resolve({ model: 'gpt-4o', findings: [], error: 'OPENAI_API_KEY missing' }),
    geminiKey ? runOne('gemini', () => reviewWithGemini(shots, geminiKey)) : Promise.resolve({ model: 'gemini', findings: [], error: 'GEMINI_API_KEY missing' }),
    claudeKey ? runOne('claude', () => reviewWithClaude(shots, claudeKey)) : Promise.resolve({ model: 'claude', findings: [], error: 'ANTHROPIC_API_KEY missing' }),
  ]);
  return [openai, gemini, claude];
}

// ── Dedupe + Notion filing ──────────────────────────────────────────────────
// Rough token-overlap similarity — good enough to group "star sizes differ
// between grid and list" (gpt-4o) with "grid/list star inconsistency" (gemini)
// without a fourth LLM call just to dedupe.
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
}
function similarity(a, b) {
  const wa = new Set(normalize(a));
  const wb = new Set(normalize(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
}

function dedupeFindings(panelResults) {
  const all = [];
  for (const r of panelResults) {
    for (const f of r.findings) all.push({ ...f, model: r.model });
  }
  const groups = [];
  for (const f of all) {
    let placed = false;
    for (const g of groups) {
      if (similarity(f.summary, g.items[0].summary) >= 0.5) {
        g.items.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ items: [f] });
  }
  return groups.map(g => ({
    summary: g.items[0].summary,
    screenshot: g.items[0].screenshot,
    severity: g.items.some(i => i.severity === 'high') ? 'high' : (g.items.some(i => i.severity === 'medium') ? 'medium' : 'low'),
    models: [...new Set(g.items.map(i => i.model))],
    agreementCount: new Set(g.items.map(i => i.model)).size,
  }));
}

// Deterministic findings (dead-control/probe/ios-quirk) were filed as a bare
// concat with the model-panel's deduped list — a probe catching the same bug
// a model also flagged (e.g. a deformed toggle) filed as two separate Notion
// cards instead of merging into one (ship-check finding, 2026-07-21). Same
// similarity() grouping as dedupeFindings, just across both sources; the
// deterministic flag survives the merge so it still bypasses the agreement
// gate in fileNotionCards.
function mergeFindingSources(modelFindings, deterministicFindings) {
  const merged = modelFindings.map(f => ({ ...f }));
  for (const det of deterministicFindings) {
    const existing = merged.find(f => similarity(det.summary, f.summary) >= 0.5);
    if (existing) {
      existing.deterministic = true;
      existing.models = [...new Set([...(existing.models || []), ...det.models])];
    } else {
      merged.push({ ...det });
    }
  }
  return merged;
}

async function existingCardTitles() {
  try {
    // notion-brain.js --text only matches Name/Notes, NOT tags (ship-check
    // finding, 2026-07-20) — searching the tag string 'ux-audit' silently
    // matched zero cards every run, so dedup-vs-existing-cards never fired.
    // Titles are literally "UX audit: ..." (titleFor below) — search that.
    const out = execFileSync('node', ['scripts/notion-brain.js', 'search', '--text', 'UX audit', '--limit', '50'], { encoding: 'utf8' });
    const cards = JSON.parse(out.slice(out.indexOf('[')));
    return cards.map(c => c.name);
  } catch (err) {
    console.error(`[ux-walkthrough] could not fetch existing ux-audit cards: ${err.message}`);
    return [];
  }
}

function titleFor(finding) {
  return `UX audit: ${finding.summary}`.slice(0, 120);
}

async function fileNotionCards(deduped, existingTitles, respondingCount) {
  const filed = [];
  for (const f of deduped) {
    // Deterministic findings (dead-control/probe/ios-quirk) are a hard
    // measurement, not a model opinion — they don't need the 2+-model
    // agreement gate that exists to filter out one-off model hallucination.
    if (!f.deterministic && f.agreementCount < 2) continue;
    const title = titleFor(f);
    const dupe = existingTitles.some(t => similarity(t, title) >= 0.6);
    if (dupe) {
      console.error(`[ux-walkthrough] skip (existing card match): ${title}`);
      continue;
    }
    const evidence = f.deterministic
      ? `Flagged by the automated ${f.models[0]} detector in the nightly signed-in UX walkthrough's interactive pass (deterministic — not a model opinion).`
      : `Flagged by ${f.agreementCount} of ${respondingCount} responding review models (${f.models.join(', ')}) in the nightly signed-in UX walkthrough.`;
    const notes = `## Problem\n${f.summary}\n\n## Evidence\n${evidence} Reference screenshot: ${f.screenshot}.\n\n## Suggested approach\nReproduce on demo.broadwayscorecard.com signed in, compare grid/list + mobile/desktop, fix per design-system tokens (memory/design-system.md).\n\n## Acceptance criteria\nFix verified in the next nightly walkthrough run (no repeat finding) + /visual-qa pass.`;
    try {
      execFileSync('node', [
        'scripts/notion-brain.js', 'create', title,
        '--status', 'Not started', '--priority', f.severity === 'high' ? 'P1 Next' : 'P2 Later',
        '--category', 'Product', '--type', 'Fix', '--tags', 'ugc,ux-audit',
        '--notes', notes,
      ], { encoding: 'utf8' });
      filed.push(title);
      console.error(`[ux-walkthrough] filed: ${title}`);
    } catch (err) {
      console.error(`[ux-walkthrough] Notion create failed for "${title}": ${err.message}`);
    }
  }
  return filed;
}

// ── Self-test (calibration) ─────────────────────────────────────────────────
// Proves the interactive pass actually catches a dead control (AC1) without
// touching the deployed app: cloneNode(true) copies markup but NOT React's
// event-delegation binding (React 17+ delegates clicks at the root container
// and matches DOM nodes via an internal fiber pointer the clone doesn't
// carry), so replacing a real button with its own clone is a faithful stand-
// in for "handler removed on a test branch" — in-page only, torn down with
// the browser context.
async function runSelfTest({ browser, session, baseUrl }) {
  const vp = VIEWPORTS.find(v => v.label === 'mobile');
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  await context.addInitScript((sessionJson) => {
    window.localStorage.setItem('bsc_auth', sessionJson);
  }, JSON.stringify(session));
  const page = await context.newPage();
  try {
    const stateUrl = `${baseUrl}/my-shows?tab=lists`;
    await page.goto(stateUrl, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1200);
    const neutered = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'New list');
      if (!btn) return false;
      btn.replaceWith(btn.cloneNode(true));
      return true;
    });
    if (!neutered) {
      console.error('[ux-walkthrough] SELFTEST FAIL: could not find "New list" button to neuter');
      return false;
    }
    const result = await testControlForDeadness(page, { tag: 'button', label: 'New list', hasAriaLabel: false });
    const caught = !!result?.dead;
    console.error(caught
      ? '[ux-walkthrough] SELFTEST PASS: dead-control detector caught the neutered "New list" button'
      : `[ux-walkthrough] SELFTEST FAIL: neutered "New list" button did not register as dead (result=${JSON.stringify(result)})`);
    return caught;
  } finally {
    await context.close();
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanup(token, userId, seeded) {
  for (const item of seeded.filter(s => s.table === 'list_items')) {
    await rest(token, 'DELETE', `list_items?id=eq.${item.id}`, null, 'return=minimal').catch(() => {});
  }
  for (const item of seeded.filter(s => s.table === 'lists')) {
    await rest(token, 'DELETE', `lists?id=eq.${item.id}`, null, 'return=minimal').catch(() => {});
  }
  await rest(token, 'DELETE', `watchlist?user_id=eq.${userId}`, null, 'return=minimal').catch(() => {});
  await rest(token, 'DELETE', `reviews?user_id=eq.${userId}`, null, 'return=minimal').catch(() => {});
  await rest(token, 'DELETE', `profiles?id=eq.${userId}`, null, 'return=minimal').catch(() => {});
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out || join('.claude/ux-walkthrough', runId);
  mkdirSync(outDir, { recursive: true });

  console.error(`[ux-walkthrough] base=${args.baseUrl} out=${outDir}`);

  const serviceKey = await resolveServiceRoleKey();
  await sweepOrphanedTestUsers(serviceKey);
  const user = await makeUser(serviceKey, 'a');
  console.error(`[ux-walkthrough] minted synthetic user ${user.email}`);

  let exitCode = 0;
  let seeded = [];
  let session = null;
  try {
    session = await mintSession(serviceKey, user.email);
    const token = session.access_token;

    // Mirror AuthContext.ensureProfile — reviews/watchlist/lists FK to profiles(id).
    await rest(token, 'POST', 'profiles', { id: user.id, display_name: 'UX Walkthrough Test' }, 'return=representation,resolution=merge-duplicates');

    if (args.selftest) {
      const browser = await chromium.launch();
      try {
        const passed = await runSelfTest({ browser, session, baseUrl: args.baseUrl });
        exitCode = passed ? 0 : 1;
      } finally {
        await browser.close();
      }
    } else {
      const [reviewRows, watchlistRows, listRows] = await Promise.all([
        seedReviews(token, user.id), seedWatchlist(token, user.id), seedPublicList(token, user.id),
      ]);
      seeded = [...reviewRows, ...watchlistRows, ...listRows];
      console.error(`[ux-walkthrough] seeded ${reviewRows.length} reviews, ${watchlistRows.length} watchlist, ${listRows.length} list row(s)`);

      const browser = await chromium.launch();
      let shots = [];
      let deterministicFindings = [];
      try {
        const matrix = await captureMatrix({ browser, session, baseUrl: args.baseUrl, outDir });
        shots.push(...matrix.shots);
        deterministicFindings.push(...matrix.findings);

        const signIn = await captureSignInModal({ browser, baseUrl: args.baseUrl, outDir });
        shots.push(...signIn.shots);
        deterministicFindings.push(...signIn.findings);

        const iosSim = await captureIosDateWheelSim({ browser, session, baseUrl: args.baseUrl, outDir });
        shots.push(...iosSim.shots);
        deterministicFindings.push(...iosSim.findings);
      } finally {
        await browser.close();
      }
      console.error(`[ux-walkthrough] captured ${shots.length} screenshot(s), ${deterministicFindings.length} deterministic finding(s) (dead-control/probe/ios-quirk)`);
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ runId, baseUrl: args.baseUrl, shots }, null, 2));

      if (!args.skipReview) {
        const panel = await runReviewPanel(shots);
        const allFailed = panel.every(p => p.error);
        if (allFailed) exitCode = 2;

        const deduped = dedupeFindings(panel);
        const deterministicAsDeduped = deterministicFindings.map(f => ({
          summary: f.summary, screenshot: f.screenshot, severity: f.severity,
          models: [`ux-walkthrough:${f.tag}`], agreementCount: 2, deterministic: true,
        }));
        const allFindings = mergeFindingSources(deduped, deterministicAsDeduped);
        const existingTitles = await existingCardTitles();
        const respondingCount = panel.filter(p => !p.error).length;
        const filed = args.noFile ? [] : await fileNotionCards(allFindings, existingTitles, respondingCount);

        writeFileSync(join(outDir, 'review.json'), JSON.stringify({ panel, deduped, deterministicFindings, filed }, null, 2));
        console.error(`[ux-walkthrough] ${deduped.length} model finding(s), ${deterministicFindings.length} deterministic finding(s), ${filed.length} filed to Notion`);
        console.log('━'.repeat(60));
        console.log(`UX WALKTHROUGH — ${shots.length} screenshots, ${deduped.length} model findings, ${deterministicFindings.length} deterministic findings, ${filed.length} filed`);
        for (const f of deduped) {
          console.log(`  [model ${f.agreementCount}/3 ${f.severity}] ${f.summary}`);
        }
        for (const f of deterministicFindings) {
          console.log(`  [${f.tag} ${f.severity}] ${f.summary}`);
        }
        console.log('━'.repeat(60));
      }
    }
  } catch (err) {
    console.error(`[ux-walkthrough] FATAL: ${err?.stack || err}`);
    exitCode = 1;
  } finally {
    if (!args.keep) {
      try {
        // Reuse the session minted above (still valid — the run takes ~2min,
        // tokens live ~1h) instead of re-minting a second one right before
        // teardown, which just adds an avoidable network-failure point.
        const token = session?.access_token || (await mintSession(serviceKey, user.email)).access_token;
        await cleanup(token, user.id, seeded);
      } catch (err) {
        console.error(`[ux-walkthrough] cleanup REST pass failed (continuing to delete auth user — FK cascades cover it): ${err.message}`);
      }
      await deleteUser(serviceKey, user.id);
      console.error(`[ux-walkthrough] cleaned up synthetic user ${user.email}`);
    } else {
      console.error(`[ux-walkthrough] --keep set: leaving synthetic user ${user.email} (${user.id}) in place`);
    }
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error(`[ux-walkthrough] UNCAUGHT: ${err?.stack || err}`);
  process.exit(1);
});
