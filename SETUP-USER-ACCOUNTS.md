# User Accounts Setup Guide

All code is built and deployed (feature-flagged OFF). Follow these steps to go live.

## Step 1: Create Supabase Project

1. Go to https://supabase.com → Start your project
2. Create a new project (free tier is fine)
3. Note your **Project URL** and **anon/public key** from Settings → API

## Step 2: Run Database Schema

1. In Supabase Dashboard → SQL Editor → New Query
2. Paste the contents of `supabase-schema.sql` (in repo root)
3. Click "Run" — creates tables, RLS policies, and triggers

## Step 3: Configure Google OAuth

1. **Google Cloud Console** (https://console.cloud.google.com):
   - Create OAuth 2.0 Client ID (Web application)
   - Add authorized redirect URI: `https://<YOUR-SUPABASE-PROJECT>.supabase.co/auth/v1/callback`
   - Note Client ID and Client Secret

2. **Supabase Dashboard** → Authentication → Providers → Google:
   - Enable Google provider
   - Paste Client ID and Client Secret
   - Save

## Step 4: Configure Auth Redirect URLs

In Supabase Dashboard → Authentication → URL Configuration:
- **Site URL**: `https://broadwayscorecard.com`
- **Redirect URLs** (add all):
  - `https://broadwayscorecard.com/auth/callback`
  - `https://demo.broadwayscorecard.com/auth/callback`
  - `http://localhost:3000/auth/callback` (for local dev)

## Step 5: Add Environment Variables to Vercel

1. Go to Vercel Dashboard → Project Settings → Environment Variables
2. Add (for Production + Preview + Development):
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon/public key

## Step 6: Enable Feature Flag

Add `userAccounts` to the `NEXT_PUBLIC_FEATURES` env var in Vercel:

Current value:
```
criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions
```

New value:
```
criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions,userAccounts
```

## Step 7: Deploy

Trigger a deploy to pick up the new env vars:
```bash
gh workflow run "Deploy to Vercel"
```

## Step 8: Demo Site

To show on demo.broadwayscorecard.com, also add `userAccounts` to the
`NEXT_PUBLIC_FEATURES` line in `.github/workflows/vercel-demo.yml` (line 55),
then trigger a demo deploy.

## What's Live

- Star ratings on every show page (rate 0.5-5 stars)
- Review diary with date seen + optional notes
- Watchlist (add shows you want to see)
- My Shows page (/my-shows) with diary + watchlist tabs
- Hamburger menu with sign in / avatar / my shows
- Sign in with Google (Apple coming later)
- All data is private (Phase 1)
- Feature flag OFF = zero visible changes
