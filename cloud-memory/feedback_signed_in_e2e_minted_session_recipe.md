---
name: feedback_signed_in_e2e_minted_session_recipe
description: "How to drive a real signed-in browser session in Playwright against this project's Supabase auth (no mock, no fixture) — unblocks task"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 433eb555-9470-4f83-831a-9e4b47790f04
---

For a genuine signed-in E2E pass (not the `?mock=1` fixture, which skips all real Supabase calls), mint a real session and inject it into `localStorage` under the client's actual storage key.

**Recipe (used successfully 2026-07-14 to verify card 174 end-to-end):**
1. Sign up a throwaway user via the public auth endpoint (no service-role key needed):
   `curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/signup" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -d '{"email":"claude-e2e-<ts>@example.com","password":"TestPass123!"}'` — this project auto-confirms email, so the response already contains a usable `access_token`/`refresh_token`.
2. Build the session object supabase-js v2 expects: `{access_token, token_type, expires_in, expires_at: now+expires_in, refresh_token, user}` (the raw signup response fields, plus a computed `expires_at`).
3. Find the client's `storageKey` (`src/lib/supabase.ts` — this project uses `'bsc_auth'`, NOT the default `sb-<ref>-auth-token`).
4. In Playwright, before/after navigating: `page.evaluate((s) => localStorage.setItem('bsc_auth', JSON.stringify(s)), session)`, then `page.reload()`.
5. If the feature is gated by `featureFlags.userAccounts` (or any `NEXT_PUBLIC_FEATURES`-gated flag), start the dev server with `NEXT_PUBLIC_FEATURES="userAccounts"` — the flag has to be baked in at `next dev` start, setting it later has no effect.

**Why:** the app never exposes a password-login UI in dev for this to click through, and the existing mock mode (`isMockMode`) intentionally short-circuits every Supabase-dependent effect, so it can't exercise real writes/RLS/edge-function auth. This recipe hits real infra: real JWT, real RLS policies, real edge function auth — the same signed-in E2E gap task #93 named. Not yet turned into a reusable test helper — this was done ad hoc via curl + `browser_run_code_unsafe`. Worth extracting into a `scripts/e2e/mint-session.js` + Playwright fixture if signed-in E2E work recurs.

See [[feedback_playwright_evaluate_click_hydration.md]] for other Playwright-in-this-repo gotchas.
