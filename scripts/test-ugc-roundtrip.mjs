#!/usr/bin/env node
/**
 * Authenticated UGC round-trip test.
 *
 * Answers the question OAuth UI tests can't: after a real sign-in, does a
 * rating/watchlist/list actually save to Supabase, stay private to its owner
 * (RLS), and persist? It mints a REAL user session (service-role → magic-link
 * → verify, no OAuth popup needed) and drives the exact REST calls the app's
 * supabase-rest.ts makes, against the LIVE production Supabase project.
 *
 * Everything except the Google/Apple popup itself is exercised: real JWT, real
 * RLS policies, real PostgREST writes, real persistence, real cross-user
 * isolation. The OAuth handshake is the provider's concern, not our data layer.
 *
 * Requires (all already GitHub secrets, used by fantasy-weekly.yml):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:  node scripts/test-ugc-roundtrip.mjs
 * Exit: 0 all green, 1 any failure. Test users are always deleted (finally).
 */

// Raw fetch only — no @supabase/supabase-js. Its createClient() eagerly builds
// a Realtime WebSocket client, which throws on Node <22 ("native WebSocket not
// found"), and we need none of it: every call here is a GoTrue admin/verify or
// a PostgREST request, all plain HTTP. Node 18+ has global fetch.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const SHOW_ID = 'hamilton-2015'; // stable, always-present show
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
}

/** GoTrue admin call with the service-role key. */
async function adminFetch(method, path, body) {
  const res = await fetch(`${URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

/** Create a confirmed test user and return {id, email}. */
async function makeUser(tag) {
  const email = `ugc-roundtrip+${tag}-${Date.now()}@broadwayscorecard-test.invalid`;
  const r = await adminFetch('POST', 'admin/users', {
    email, email_confirm: true,
    user_metadata: { full_name: `Roundtrip Test ${tag}`, roundtripTest: true },
  });
  if (!r.ok || !r.json?.id) throw new Error(`createUser(${tag}): HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return { id: r.json.id, email };
}

/** Mint a real access token for an existing user — no password / OAuth needed. */
async function mintToken(email) {
  const link = await adminFetch('POST', 'admin/generate_link', { type: 'magiclink', email });
  // GoTrue returns the token either top-level or under .properties depending on version.
  const hashed = link.json?.hashed_token ?? link.json?.properties?.hashed_token;
  if (!link.ok || !hashed) throw new Error(`generateLink: HTTP ${link.status} ${link.text.slice(0, 200)}`);
  const res = await fetch(`${URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`verify: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

async function deleteUser(id) {
  await adminFetch('DELETE', `admin/users/${id}`);
}

// Best-effort startup sweep for synthetic users a PRIOR run failed to clean
// up (workflow timeout, runner OOM, cancellation — none of which reach the
// `finally` block in main()). Only touches @broadwayscorecard-test.invalid
// accounts older than 1h (safely past any run's duration), so it can't
// collide with a genuinely concurrent run. Never throws. Same gap + fix as
// scripts/ux-walkthrough.mjs's sweepOrphanedTestUsers (2026-07-20).
async function sweepOrphanedTestUsers() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    let page = 1;
    let swept = 0;
    for (;;) {
      const r = await adminFetch('GET', `admin/users?page=${page}&per_page=200`);
      const users = r.json?.users;
      if (!r.ok || !Array.isArray(users) || users.length === 0) break;
      for (const u of users) {
        if (!u.email?.endsWith('@broadwayscorecard-test.invalid')) continue;
        if (new Date(u.created_at).getTime() >= cutoff) continue;
        await deleteUser(u.id).catch(() => {});
        swept++;
      }
      if (users.length < 200) break;
      page++;
    }
    if (swept > 0) console.log(`swept ${swept} orphaned @broadwayscorecard-test.invalid user(s) from prior run(s)`);
  } catch (err) {
    console.warn(`orphan sweep failed (non-fatal): ${err.message}`);
  }
}

/** One PostgREST call with a user JWT — mirrors supabase-rest.ts exactly. */
async function rest(method, path, token, body, prefer = 'return=representation') {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
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
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log(`UGC authenticated round-trip → ${URL}\n`);

  await sweepOrphanedTestUsers();

  // Preflight: is the project even reachable? A network failure here (not an
  // HTTP error) means the URL is dead/wrong — a hard NOT-ready signal, since the
  // live site talks to this exact host for auth.
  try {
    const health = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: ANON } });
    console.log(`preflight /auth/v1/health → HTTP ${health.status}`);
  } catch (e) {
    const code = e.cause?.code || '';
    // Host doesn't resolve → the configured project is gone/renamed. If we have a
    // management token, list the account's REAL projects so the fix is obvious.
    if (code === 'ENOTFOUND' && process.env.SUPABASE_ACCESS_TOKEN) {
      try {
        const r = await fetch('https://api.supabase.com/v1/projects', {
          headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` },
        });
        const list = await r.json();
        console.error('── Live Supabase projects on this account (Management API) ──');
        const configuredRef = URL ? new global.URL(URL).hostname.split('.')[0] : '';
        let hint = '   The configured ref is not in this account → update NEXT_PUBLIC_SUPABASE_URL/ANON_KEY.';
        for (const p of Array.isArray(list) ? list : []) {
          console.error(`   ref=${p.id}  name=${p.name}  status=${p.status}  region=${p.region}`);
          if (p.id === configuredRef) {
            hint = p.status === 'ACTIVE_HEALTHY'
              ? '   Project is ACTIVE but still unreachable — transient DNS/outage, retry shortly.'
              : `   Project is ${p.status} (paused). Restore it: run the "Restore Supabase Project" workflow.`;
          }
        }
        console.error(hint);
      } catch (mgmtErr) {
        console.error(`   (could not list projects: ${mgmtErr.message})`);
      }
    }
    throw new Error(`cannot reach ${URL} — ${code} ${e.cause?.message || e.message}`.trim());
  }

  // Auth-config check: does OAuth actually work on the domains friends use? The
  // data layer can be perfect but if the demo/prod domain isn't in the redirect
  // allowlist (or Google/Apple aren't enabled), the sign-in popup fails silently.
  // Informational (doesn't fail the run) — surfaces config gaps the round-trip
  // otherwise can't see.
  const projectRef = process.env.SUPABASE_PROJECT_REF || (URL ? new global.URL(URL).hostname.split('.')[0] : '');
  if (process.env.SUPABASE_ACCESS_TOKEN && projectRef) {
    try {
      const cfg = await (await fetch(
        `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
        { headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } },
      )).json();
      const allow = cfg.uri_allow_list || '';
      const providers = ['google', 'apple'].filter(p => cfg[`external_${p}_enabled`]);
      console.log(`auth config: site_url=${cfg.site_url} | providers=[${providers.join(',') || 'NONE'}]`);
      console.log(`auth redirect allowlist: ${allow || '(empty)'}`);
      for (const host of ['broadwayscorecard.com', 'demo.broadwayscorecard.com']) {
        const ok = allow.includes(host);
        console.log(`  ${ok ? '✓' : '⚠'} ${host} ${ok ? 'in' : 'NOT in'} redirect allowlist${ok ? '' : ' → OAuth sign-in will fail on this domain'}`);
      }
      if (!providers.includes('google') || !providers.includes('apple')) {
        console.log('  ⚠ Google and/or Apple OAuth not enabled — the only sign-in methods.');
      }
    } catch (e) { console.log(`(auth-config check skipped: ${e.message})`); }

    // Drive the REAL OAuth authorize endpoint for each provider and confirm the
    // provider ACCEPTS our app (redirects to its own sign-in) instead of erroring
    // on a misconfig (redirect_uri_mismatch / invalid_client / disabled provider).
    // This is the automatable slice of "does the Google/Apple button work" — it
    // exercises the provider-side client config without completing a real login
    // (which needs a human credential + defeating bot-detection). Informational.
    const redirectTo = 'https://demo.broadwayscorecard.com/auth/callback';
    for (const [p, okHost] of [['google', 'accounts.google.com'], ['apple', 'appleid.apple.com']]) {
      try {
        const authUrl = `${URL}/auth/v1/authorize?provider=${p}&redirect_to=${encodeURIComponent(redirectTo)}`;
        const res = await fetch(authUrl, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const finalUrl = res.url || '';
        const body = (await res.text()).slice(0, 4000).toLowerCase();
        const reachedProvider = finalUrl.includes(okHost);
        const err = /redirect_uri_mismatch|invalid_client|unauthorized_client|error=|access blocked|400\. that.?s an error/.test(finalUrl + ' ' + body);
        const ok = reachedProvider && !err;
        console.log(`  ${ok ? '✓' : '⚠'} ${p} OAuth: ${ok ? `reaches ${okHost} (client config accepted)` : `did NOT cleanly reach ${okHost} → ${finalUrl.slice(0, 90)}`}`);
      } catch (e) { console.log(`  (${p} OAuth probe skipped: ${e.message})`); }
    }
    console.log('');
  }

  // Track every user we create so the finally cleans up even if creation of the
  // SECOND user throws (otherwise the first would orphan in auth.users and
  // accumulate across failed runs).
  const created = [];
  try {
    const userA = await makeUser('a'); created.push(userA);
    const userB = await makeUser('b'); created.push(userB);
    const tokenA = await mintToken(userA.email);
    const tokenB = await mintToken(userB.email);
    check('sign-in: minted a real user session (no OAuth popup)', !!tokenA);

    // Mirror what the app does on first sign-in (AuthContext.ensureProfile):
    // upsert a profiles row. reviews/watchlist/lists.user_id all FK to
    // profiles(id), so writes fail without it. Exercises the profiles INSERT
    // RLS policy (WITH CHECK auth.uid() = id) via the user's own token.
    for (const [u, tok] of [[userA, tokenA], [userB, tokenB]]) {
      const pr = await rest('POST', 'profiles', tok,
        { id: u.id, display_name: 'Roundtrip Test' }, 'return=representation,resolution=merge-duplicates');
      if (u === userA) check('sign-in: profile row created (ensureProfile)', pr.ok, `HTTP ${pr.status} ${pr.text.slice(0, 120)}`);
    }

    // ── REVIEW: insert → read back → cross-user isolation → update → delete ──
    const ins = await rest('POST', 'reviews', tokenA, {
      user_id: userA.id, show_id: SHOW_ID, rating: 4.5,
      review_text: 'round-trip note', date_seen: '2024-11-15',
    });
    const reviewId = Array.isArray(ins.json) ? ins.json[0]?.id : ins.json?.id;
    check('rating: saves via authenticated REST insert', ins.status === 201 && !!reviewId, `HTTP ${ins.status} ${ins.ok ? '' : ins.text.slice(0, 160)}`);
    check('rating: stored value is correct', Array.isArray(ins.json) && ins.json[0]?.rating === 4.5,
      `rating=${Array.isArray(ins.json) ? ins.json[0]?.rating : '?'}`);

    const readA = await rest('GET', `reviews?show_id=eq.${SHOW_ID}&select=*`, tokenA);
    check('rating: owner reads it back (persists)',
      readA.ok && Array.isArray(readA.json) && readA.json.some(r => r.id === reviewId));

    const readB = await rest('GET', `reviews?id=eq.${reviewId}&select=*`, tokenB);
    check('rating: RLS hides it from a different user',
      readB.ok && Array.isArray(readB.json) && readB.json.length === 0,
      `userB saw ${Array.isArray(readB.json) ? readB.json.length : '?'} rows`);

    // userB tries to overwrite userA's review; RLS UPDATE (auth.uid()=user_id)
    // matches 0 rows so this is a silent no-op — verified by re-reading as A.
    await rest('PATCH', `reviews?id=eq.${reviewId}`, tokenB, { rating: 1.0 });
    const stillMine = await rest('GET', `reviews?id=eq.${reviewId}&select=rating`, tokenA);
    check('rating: RLS blocks another user from editing it',
      Array.isArray(stillMine.json) && stillMine.json[0]?.rating === 4.5,
      `after userB PATCH, rating=${Array.isArray(stillMine.json) ? stillMine.json[0]?.rating : '?'}`);

    const upd = await rest('PATCH', `reviews?id=eq.${reviewId}&user_id=eq.${userA.id}`, tokenA, {
      rating: 5.0, review_text: 'edited note',
    });
    check('rating: owner can edit', Array.isArray(upd.json) && upd.json[0]?.rating === 5.0);

    // ── WATCHLIST ──
    const wIns = await rest('POST', 'watchlist', tokenA, { user_id: userA.id, show_id: SHOW_ID });
    check('watchlist: add saves', wIns.status === 201);
    const wRead = await rest('GET', `watchlist?show_id=eq.${SHOW_ID}&select=*`, tokenA);
    check('watchlist: reads back', wRead.ok && Array.isArray(wRead.json) && wRead.json.length >= 1);
    const wReadB = await rest('GET', `watchlist?show_id=eq.${SHOW_ID}&select=*`, tokenB);
    check('watchlist: RLS isolates it', Array.isArray(wReadB.json) && wReadB.json.length === 0);

    // ── LISTS ──
    const lIns = await rest('POST', 'lists', tokenA, { user_id: userA.id, name: 'Round-trip list' });
    const listId = Array.isArray(lIns.json) ? lIns.json[0]?.id : null;
    check('lists: create saves', lIns.status === 201 && !!listId);
    if (listId) {
      const liIns = await rest('POST', 'list_items', tokenA, { list_id: listId, show_id: SHOW_ID, position: 1000 });
      check('lists: add show to list saves', liIns.status === 201);

      // ── PUBLIC SHARING: private by default, then visible to ANON once shared ──
      const anonBefore = await rest('GET', `lists?id=eq.${listId}&select=id`, ANON);
      check('lists: private list hidden from anonymous', Array.isArray(anonBefore.json) && anonBefore.json.length === 0,
        `anon saw ${Array.isArray(anonBefore.json) ? anonBefore.json.length : '?'} rows`);

      const slug = `rt-${listId.slice(0, 8)}`;
      const pub = await rest('PATCH', `lists?id=eq.${listId}&user_id=eq.${userA.id}`, tokenA,
        { is_public: true, share_slug: slug });
      check('lists: owner can make public (share)', Array.isArray(pub.json) && pub.json[0]?.is_public === true);

      // The share page reads by slug with the anon key — exactly this call.
      const anonList = await rest('GET', `lists?share_slug=eq.${slug}&select=id,name,is_public`, ANON);
      check('lists: shared list visible to anonymous via slug',
        anonList.ok && Array.isArray(anonList.json) && anonList.json.length === 1);
      const anonItems = await rest('GET', `list_items?list_id=eq.${listId}&select=show_id`, ANON);
      check('lists: shared list ITEMS visible to anonymous',
        anonItems.ok && Array.isArray(anonItems.json) && anonItems.json.length >= 1);
      const anonProfile = await rest('GET', `profiles?id=eq.${userA.id}&select=display_name`, ANON);
      check('lists: sharer display name visible to anonymous (public-list owner policy)',
        anonProfile.ok && Array.isArray(anonProfile.json) && anonProfile.json.length === 1);

      // Un-share → hidden again (the "make private" escape hatch actually hides it).
      await rest('PATCH', `lists?id=eq.${listId}&user_id=eq.${userA.id}`, tokenA, { is_public: false });
      const anonAfter = await rest('GET', `lists?share_slug=eq.${slug}&select=id`, ANON);
      check('lists: made private again → hidden from anonymous', Array.isArray(anonAfter.json) && anonAfter.json.length === 0);
    }

    // ── DELETE (rating) ──
    const del = await rest('DELETE', `reviews?id=eq.${reviewId}&user_id=eq.${userA.id}`, tokenA, null, 'return=minimal');
    check('rating: owner can delete', del.ok, `HTTP ${del.status}`);
    const gone = await rest('GET', `reviews?id=eq.${reviewId}&select=id`, tokenA);
    check('rating: delete persists', Array.isArray(gone.json) && gone.json.length === 0);
  } finally {
    // Always remove every user we created — cascades to their reviews/watchlist/lists.
    for (const u of created) {
      try { await deleteUser(u.id); } catch (e) { console.warn(`cleanup ${u.email}: ${e.message}`); }
    }
  }

  console.log(results.join('\n'));
  console.log('');
  if (failed) {
    console.error(`❌ ${failed} check(s) FAILED — the signed-in round-trip is broken. NOT ready for users.`);
    process.exit(1);
  }
  console.log(`✅ All ${results.length} checks passed — sign-in → save → persist → RLS isolation all work.`);
}

main().catch(e => {
  // A thrown error here (e.g. createUser/generateLink) usually means the project
  // itself is unreachable or auth is misconfigured — a hard NOT-ready signal.
  const cause = e.cause ? ` [cause: ${e.cause.code || ''} ${e.cause.message || ''}]` : '';
  console.error(`❌ Round-trip aborted: ${e.message}${cause}`);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n') || '');
  process.exit(1);
});
