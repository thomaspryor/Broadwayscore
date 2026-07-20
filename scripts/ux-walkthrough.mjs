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
// CLI:
//   --base-url <url>      defaults to https://demo.broadwayscorecard.com
//   --skip-review         seed + screenshot only, skip the LLM panel
//   --keep                skip cleanup (debugging only — leaves synthetic rows)
//   --out <dir>           screenshot/run dir (defaults to .claude/ux-walkthrough/<runId>/)
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
  const args = { baseUrl: 'https://demo.broadwayscorecard.com', skipReview: false, keep: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--skip-review') args.skipReview = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--out') args.out = argv[++i];
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
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function captureMatrix({ browser, session, baseUrl, outDir }) {
  const shots = [];
  for (const vp of VIEWPORTS) {
    await withPage(browser, session, vp, async (page) => {
      // ── my-shows: diary, grid + list ──
      await page.goto(`${baseUrl}/my-shows?tab=diary`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      shots.push({ name: `${vp.label}__diary_grid`, file: await shoot(page, outDir, `${vp.label}__diary_grid`) });

      const listToggle = page.locator('[aria-label="List view"]:visible').first();
      if (await listToggle.count() > 0) {
        await listToggle.click().catch(() => {});
        await page.waitForTimeout(500);
        shots.push({ name: `${vp.label}__diary_list`, file: await shoot(page, outDir, `${vp.label}__diary_list`) });
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
        shots.push({ name: `${vp.label}__rating_editor`, file: await shoot(page, outDir, `${vp.label}__rating_editor`) });
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
        shots.push({ name: `${vp.label}__delete_confirm`, file: await shoot(page, outDir, `${vp.label}__delete_confirm`) });
        const noBtn = page.getByText('No', { exact: true }).first();
        if (await noBtn.count() > 0) await noBtn.click().catch(() => {});
      }

      // ── my-shows: watchlist, grid + list ──
      await page.goto(`${baseUrl}/my-shows?tab=watchlist`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      shots.push({ name: `${vp.label}__watchlist_grid`, file: await shoot(page, outDir, `${vp.label}__watchlist_grid`) });

      if (vp.label === 'desktop') {
        // Grid hover state — chromium-only, real mouse hover over the first card.
        const firstCard = page.locator('[data-testid="my-shows-content"] a').first();
        if (await firstCard.count() > 0) {
          await firstCard.hover().catch(() => {});
          await page.waitForTimeout(300);
          shots.push({ name: `${vp.label}__watchlist_grid_hover`, file: await shoot(page, outDir, `${vp.label}__watchlist_grid_hover`) });
        }
      }

      const wListToggle = page.locator('[aria-label="List view"]:visible').first();
      if (await wListToggle.count() > 0) {
        await wListToggle.click().catch(() => {});
        await page.waitForTimeout(500);
        shots.push({ name: `${vp.label}__watchlist_list`, file: await shoot(page, outDir, `${vp.label}__watchlist_list`) });
      }

      // ── my-shows: lists tab ──
      await page.goto(`${baseUrl}/my-shows?tab=lists`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1200);
      shots.push({ name: `${vp.label}__lists_tab`, file: await shoot(page, outDir, `${vp.label}__lists_tab`) });

      // ── show page (rated + watchlisted show) ──
      await page.goto(`${baseUrl}/show/hamilton`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      shots.push({ name: `${vp.label}__show_hero_rated`, file: await shoot(page, outDir, `${vp.label}__show_hero_rated`) });

      // ── browse / homepage, signed-in ──
      await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500);
      shots.push({ name: `${vp.label}__homepage_signed_in`, file: await shoot(page, outDir, `${vp.label}__homepage_signed_in`) });
    });
  }
  return shots;
}

// ── Multi-model review panel ────────────────────────────────────────────────
const RUBRIC = `You are reviewing screenshots of a signed-in Broadway show-tracking web app (Broadwayscorecard). A user rates/reviews shows they've seen, keeps a watchlist with planned dates, and can share public lists.

Screenshots are labeled <viewport>__<surface>, e.g. "mobile__diary_grid" or "desktop__rating_editor". Viewports: mobile=390px, desktop=1440px.

Review across these dimensions:
1. HIERARCHY — is the most important info (show title, rating, action) the most visually prominent? Is anything buried that shouldn't be, or loud that shouldn't be (e.g. a date more prominent than the show title)?
2. CONSISTENCY ACROSS VIEWS/BREAKPOINTS — do star sizes, icons, spacing match between grid and list views, and between mobile and desktop? Cross-surface parity issues (e.g. an icon present in grid but missing in list) belong here.
3. AFFORDANCE CLARITY — do interactive elements look tappable/clickable? Is a destructive action (delete) clearly different from a safe one, and does its confirm step read as an obvious "are you sure," not just a color change?
4. FEEDBACK AFTER ACTION — after adding/rating/removing a show, is there visible confirmation, and does the item land somewhere sensible (not buried mid-list with no signal it moved)?
5. DEAD ENDS — any screen where a signed-in user has no obvious next action?
6. 12PX FLOOR — any text that looks smaller than ~12px, especially on mobile.
7. DESIGN TOKENS — hardcoded-looking colors that don't match the app's dark score-card aesthetic (unexpected zinc/slate grays, off-brand reds/greens).

Return ONLY a JSON object: {"findings": [{"summary": "...", "screenshot": "<label of the most relevant screenshot>", "severity": "high"|"medium"|"low"}]}. Max 5 findings. Be specific — quote what you see, don't speculate. If you see nothing worth flagging in a dimension, skip it. No markdown fencing, no commentary.`;

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

// Cap total images sent to each model — full 2-viewport x ~10-surface matrix
// is enough context without blowing token/latency budgets. Prioritize the
// distinct-surface set over duplicating both viewports of everything.
function pickReviewImages(shots, max = 16) {
  return shots.slice(0, max);
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
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1500, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90000),
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

async function existingCardTitles() {
  try {
    const out = execFileSync('node', ['scripts/notion-brain.js', 'search', '--text', 'ux-audit', '--limit', '50'], { encoding: 'utf8' });
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

async function fileNotionCards(deduped, existingTitles) {
  const filed = [];
  for (const f of deduped) {
    if (f.agreementCount < 2) continue; // only 2-of-3+ agreement gets filed
    const title = titleFor(f);
    const dupe = existingTitles.some(t => similarity(t, title) >= 0.6);
    if (dupe) {
      console.error(`[ux-walkthrough] skip (existing card match): ${title}`);
      continue;
    }
    const notes = `## Problem\n${f.summary}\n\n## Evidence\nFlagged by ${f.agreementCount} of 3 review models (${f.models.join(', ')}) in the nightly signed-in UX walkthrough. Reference screenshot: ${f.screenshot}.\n\n## Suggested approach\nReproduce on demo.broadwayscorecard.com signed in, compare grid/list + mobile/desktop, fix per design-system tokens (memory/design-system.md).\n\n## Acceptance criteria\nFix verified in the next nightly walkthrough run (no repeat finding) + /visual-qa pass.`;
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
  const user = await makeUser(serviceKey, 'a');
  console.error(`[ux-walkthrough] minted synthetic user ${user.email}`);

  let exitCode = 0;
  let seeded = [];
  try {
    const session = await mintSession(serviceKey, user.email);
    const token = session.access_token;

    // Mirror AuthContext.ensureProfile — reviews/watchlist/lists FK to profiles(id).
    await rest(token, 'POST', 'profiles', { id: user.id, display_name: 'UX Walkthrough Test' }, 'return=representation,resolution=merge-duplicates');

    const [reviewRows, watchlistRows, listRows] = await Promise.all([
      seedReviews(token, user.id), seedWatchlist(token, user.id), seedPublicList(token, user.id),
    ]);
    seeded = [...reviewRows, ...watchlistRows, ...listRows];
    console.error(`[ux-walkthrough] seeded ${reviewRows.length} reviews, ${watchlistRows.length} watchlist, ${listRows.length} list row(s)`);

    const browser = await chromium.launch();
    let shots;
    try {
      shots = await captureMatrix({ browser, session, baseUrl: args.baseUrl, outDir });
    } finally {
      await browser.close();
    }
    console.error(`[ux-walkthrough] captured ${shots.length} screenshot(s)`);
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ runId, baseUrl: args.baseUrl, shots }, null, 2));

    if (!args.skipReview) {
      const panel = await runReviewPanel(shots);
      const allFailed = panel.every(p => p.error);
      if (allFailed) exitCode = 2;

      const deduped = dedupeFindings(panel);
      const existingTitles = await existingCardTitles();
      const filed = await fileNotionCards(deduped, existingTitles);

      writeFileSync(join(outDir, 'review.json'), JSON.stringify({ panel, deduped, filed }, null, 2));
      console.error(`[ux-walkthrough] ${deduped.length} deduped finding(s), ${filed.length} filed to Notion`);
      console.log('━'.repeat(60));
      console.log(`UX WALKTHROUGH — ${shots.length} screenshots, ${deduped.length} findings, ${filed.length} filed`);
      for (const f of deduped) {
        console.log(`  [${f.agreementCount}/3 ${f.severity}] ${f.summary}`);
      }
      console.log('━'.repeat(60));
    }
  } catch (err) {
    console.error(`[ux-walkthrough] FATAL: ${err?.stack || err}`);
    exitCode = 1;
  } finally {
    if (!args.keep) {
      try {
        const session = await mintSession(serviceKey, user.email);
        await cleanup(session.access_token, user.id, seeded);
      } catch (err) {
        console.error(`[ux-walkthrough] cleanup REST pass failed (continuing to delete auth user): ${err.message}`);
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
