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

import { createClient } from '@supabase/supabase-js';

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

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

/** Create a confirmed test user and return {id, email}. */
async function makeUser(tag) {
  const email = `ugc-roundtrip+${tag}-${Date.now()}@broadwayscorecard-test.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: `Roundtrip Test ${tag}`, roundtripTest: true },
  });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  return { id: data.user.id, email };
}

/** Mint a real access token for an existing user — no password / OAuth needed. */
async function mintToken(email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw new Error(`generateLink: ${linkErr.message}`);
  const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: sess, error: verErr } = await anonClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (verErr) throw new Error(`verifyOtp: ${verErr.message}`);
  if (!sess.session?.access_token) throw new Error('verifyOtp returned no access_token');
  return sess.session.access_token;
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

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  try {
    const tokenA = await mintToken(userA.email);
    const tokenB = await mintToken(userB.email);
    check('sign-in: minted a real user session (no OAuth popup)', !!tokenA);

    // ── REVIEW: insert → read back → cross-user isolation → update → delete ──
    const ins = await rest('POST', 'reviews', tokenA, {
      user_id: userA.id, show_id: SHOW_ID, rating: 4.5,
      review_text: 'round-trip note', date_seen: '2024-11-15',
    });
    const reviewId = Array.isArray(ins.json) ? ins.json[0]?.id : ins.json?.id;
    check('rating: saves via authenticated REST insert', ins.status === 201 && !!reviewId, `HTTP ${ins.status}`);
    check('rating: stored value is correct', Array.isArray(ins.json) && ins.json[0]?.rating === 4.5,
      `rating=${Array.isArray(ins.json) ? ins.json[0]?.rating : '?'}`);

    const readA = await rest('GET', `reviews?show_id=eq.${SHOW_ID}&select=*`, tokenA);
    check('rating: owner reads it back (persists)',
      readA.ok && Array.isArray(readA.json) && readA.json.some(r => r.id === reviewId));

    const readB = await rest('GET', `reviews?id=eq.${reviewId}&select=*`, tokenB);
    check('rating: RLS hides it from a different user',
      readB.ok && Array.isArray(readB.json) && readB.json.length === 0,
      `userB saw ${Array.isArray(readB.json) ? readB.json.length : '?'} rows`);

    const stealB = await rest('PATCH', `reviews?id=eq.${reviewId}`, tokenB, { rating: 1.0 });
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
    }

    // ── DELETE (rating) ──
    const del = await rest('DELETE', `reviews?id=eq.${reviewId}&user_id=eq.${userA.id}`, tokenA, null, 'return=minimal');
    check('rating: owner can delete', del.ok, `HTTP ${del.status}`);
    const gone = await rest('GET', `reviews?id=eq.${reviewId}&select=id`, tokenA);
    check('rating: delete persists', Array.isArray(gone.json) && gone.json.length === 0);
  } finally {
    // Always remove test users — cascades to their reviews/watchlist/lists.
    for (const u of [userA, userB]) {
      try { await admin.auth.admin.deleteUser(u.id); } catch (e) { console.warn(`cleanup ${u.email}: ${e.message}`); }
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
  console.error(`❌ Round-trip aborted: ${e.message}`);
  console.error(e.stack?.split('\n').slice(1, 4).join('\n') || '');
  process.exit(1);
});
