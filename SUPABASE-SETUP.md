# Supabase Setup Guide for Broadway Scorecard

## Current Status

- **Sprint 1 code is COMPLETE** on the `staging-community` branch
- All auth components, database types, and SQL migration are written and pushed
- The site works fine without Supabase configured (graceful degradation)
- **What's left:** Supabase project configuration (this guide) + Vercel env vars

---

## Step 1: Sign into Supabase

You already have a Supabase project created:
- **Org:** thomaspryor's Org
- **Project:** broadway-scorecard
- **Dashboard:** https://supabase.com/dashboard

Sign in with your GitHub account.

---

## Step 2: Enable Google OAuth Provider

1. In the Supabase dashboard, go to **Authentication** in the left sidebar
2. Under **CONFIGURATION**, click **Sign In / Providers**
3. Find **Google** in the list and expand it
4. Toggle it **ON**
5. You'll see fields for **Client ID** and **Client Secret** — you'll get these from Google (Step 3)
6. **Copy the "Redirect URL"** shown on this page (you'll need it for Google setup). It looks like:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`

---

## Step 3: Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use an existing one) — name it something like "Broadway Scorecard"
3. In the left sidebar, go to **APIs & Services > Credentials**
4. Click **+ CREATE CREDENTIALS** at the top, then **OAuth client ID**
5. If prompted to configure the OAuth consent screen first:
   - Choose **External** user type
   - App name: "Broadway Scorecard"
   - User support email: your email
   - Developer contact email: your email
   - Click through the rest (scopes, test users) — defaults are fine
   - Publish the app (move from Testing to Production)
6. Back on Create OAuth client ID:
   - Application type: **Web application**
   - Name: "Broadway Scorecard"
   - **Authorized redirect URIs:** Paste the Redirect URL you copied from Supabase in Step 2
   - Click **Create**
7. Copy the **Client ID** and **Client Secret**
8. Go back to Supabase (Step 2) and paste them into the Google provider settings
9. Click **Save**

---

## Step 4: Verify Email (Magic Link) is Enabled

1. In Supabase, go to **Authentication > Sign In / Providers**
2. Find **Email** — it should be enabled by default
3. Make sure **"Enable Email Signup"** is ON
4. Make sure **"Enable Magic Link"** is ON (this lets users sign in with just their email, no password)

---

## Step 5: Run the Database Migration

1. In Supabase, go to **SQL Editor** in the left sidebar
2. Click **+ New Query**
3. Copy the entire contents of `supabase/migrations/001_initial_schema.sql` from the repo
4. Paste it into the SQL editor
5. Click **Run** (or Ctrl+Enter)
6. You should see "Success. No rows returned" — that means the tables, triggers, and policies were created

To verify, go to **Table Editor** in the left sidebar. You should see:
- `profiles` table
- `ratings` table
- `community_scores` view

---

## Step 6: Add Environment Variables to Vercel

1. In Supabase, go to **Settings > API** (in the left sidebar under CONFIGURATION)
2. Copy the **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
3. Copy the **anon/public** key (the shorter one, NOT the service_role key)
4. Go to your [Vercel Dashboard](https://vercel.com) > broadway-scorecard project
5. Go to **Settings > Environment Variables**
6. Add these two variables:

| Name | Value | Environment |
|------|-------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase Project URL | All (Production, Preview, Development) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon/public key | All (Production, Preview, Development) |

7. Click **Save** for each

---

## Step 7: Test the Preview Deploy

After adding the env vars:
1. Go to Vercel and trigger a redeploy of the `staging-community` branch (or push any small change)
2. Open the preview URL
3. You should see a "Sign In" button in the header (top right)
4. Click it — it should redirect to Google sign-in
5. After signing in, you should see your avatar initial in the header

---

## Troubleshooting

**"Sign In" button doesn't appear:**
- Check that both env vars are set in Vercel and start with `NEXT_PUBLIC_`
- Redeploy after adding env vars

**Google sign-in fails:**
- Verify the Redirect URI in Google Cloud Console matches exactly what Supabase shows
- Make sure the OAuth consent screen is published (not in Testing mode)

**Magic link emails don't arrive:**
- Check Supabase Auth > Email Templates
- Check spam folder
- Supabase free tier has email rate limits (4 emails/hour)

**Database tables missing:**
- Re-run the SQL migration in Step 5
- Check the SQL Editor output for errors

---

## What Comes Next (After Setup)

Once Supabase is configured and the preview is working:
- **Sprint 2:** Rating widget, community score display, auth modal
- **Sprint 3:** My Scorecard page, profile pages
- See `SPRINT-PLAN.md` for the full roadmap

---

## Reference: Files on `staging-community` Branch

| File | Purpose |
|------|---------|
| `src/lib/supabase.ts` | Supabase client singleton |
| `src/types/database.ts` | TypeScript interfaces for DB tables |
| `src/contexts/AuthContext.tsx` | Auth state management (React Context) |
| `src/hooks/useAuth.ts` | Convenience hook for auth |
| `src/components/UserMenu.tsx` | Header sign-in button / avatar dropdown |
| `src/components/ClientProviders.tsx` | AuthProvider wrapper |
| `src/app/layout.tsx` | Modified: wraps body with ClientProviders, adds UserMenu |
| `src/lib/scoring-labels.ts` | Shared tier label utility |
| `supabase/migrations/001_initial_schema.sql` | Database schema (profiles, ratings, RLS) |
| `vitest.config.ts` | Unit test configuration |
| `tests/unit/` | 10 unit tests (all passing) |
