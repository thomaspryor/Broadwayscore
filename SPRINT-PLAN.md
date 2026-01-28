# Community Ratings — Sprint Plan (v2, post-review)

> **Branch:** `staging-community` (dedicated feature branch — `staging` is reserved for quick design fixes)
> **Deployment:** Vercel preview URL from `staging-community` branch
> **Constraint:** Must preserve `output: 'export'` — all Supabase interaction is client-side only
> **Review applied:** Sub-agent review caught 8 critical issues; all incorporated below

---

## Architecture Decisions (Locked In)

| Decision | Rationale |
|----------|-----------|
| Use `staging-community` branch | `staging` is used for quick design fixes. `staging-community` is a dedicated long-running feature branch. Vercel will auto-create a preview URL for it. |
| Regular SQL view, not materialized view | Materialized views require manual refresh (pg_cron or edge function). A regular view auto-updates and is fine for low traffic at launch. |
| No `shows_seen_count` trigger | Compute client-side from ratings array. Denormalize later if needed. |
| No DB-level rate limiting in MVP | Unique constraint `(user_id, show_id, date_attended)` prevents duplicates. Client-side debounce prevents double-click. Real rate limiting is post-MVP. |
| Defer public profiles to post-MVP | `/u/username` is a social feature with no value at zero users. Keep My Scorecard (private) only. |
| Shared tier label utility | Extract `getTierLabel(score)` from show page's `getSentimentLabel` into `src/lib/scoring-labels.ts` to prevent label drift between critic display and rating widget. |
| Server component shell for client pages | `my-scorecard/page.tsx` is a server component with static heading/skeleton, importing a `'use client'` content component. Matches existing codebase pattern. |
| Render review text with React auto-escaping | Use `{reviewText}` not `dangerouslySetInnerHTML`. This eliminates need for HTML stripping. |

---

## Sprint 0: Infrastructure Setup

**Goal:** Supabase project exists, auth providers configured, env vars in Vercel, `staging-community` branch created. No code changes — purely operational. Everything downstream depends on this.

**Demo:** Visit Supabase dashboard → project exists → Google OAuth configured → magic link configured. Vercel dashboard → env vars set for `staging-community` preview.

### Tickets

#### 0.1 — Create staging-community branch
- **Do:** `git checkout main && git pull origin main && git checkout -b staging-community && git push origin staging-community`
- **Validation:** Branch exists on GitHub. Vercel creates a preview deployment URL for it (e.g., `broadwayscore-git-staging-community-*.vercel.app`).
- **Files:** None (git only)

#### 0.2 — Create Supabase project and configure auth
- **Do:**
  1. Create a new Supabase project at supabase.com
  2. Enable **Google OAuth** provider in Authentication → Providers:
     - Create OAuth client in Google Cloud Console
     - Set authorized redirect URI: `https://<supabase-project>.supabase.co/auth/v1/callback`
     - Copy Client ID and Client Secret into Supabase dashboard
  3. Enable **Magic Link** in Authentication → Providers → Email:
     - Enable "Magic Link" sign-in
     - Disable password-based sign-in
  4. Configure redirect URLs in Authentication → URL Configuration:
     - Site URL: `https://broadwayscorecard.com`
     - Additional redirect URLs: `https://broadwayscorecard.com/**`, `https://broadwayscore-git-staging-*.vercel.app/**`, `http://localhost:3000/**`
  5. Note the project URL and anon key from Settings → API
- **Validation:** Supabase dashboard shows project active. Auth → Providers shows Google and Magic Link enabled. URL configuration lists all redirect patterns.
- **Files:** None (Supabase dashboard only)

#### 0.3 — Add Supabase env vars to Vercel
- **Do:**
  1. In Vercel project settings → Environment Variables:
     - `NEXT_PUBLIC_SUPABASE_URL` = Supabase project URL (all environments)
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = Supabase anon key (all environments)
  2. In GitHub repository → Settings → Secrets:
     - `SUPABASE_SERVICE_ROLE_KEY` = Supabase service role key (for future GitHub Actions)
- **Validation:** Vercel shows both `NEXT_PUBLIC_` vars configured. GitHub shows `SUPABASE_SERVICE_ROLE_KEY` secret.
- **Files:** None (dashboard config only)

#### 0.4 — Run database schema migration
- **Do:** In Supabase SQL Editor, run the schema SQL (created in Sprint 1 ticket 1.8). This sets up profiles, ratings, view, triggers, and RLS.
- **Validation:** Supabase Table Editor shows `profiles` and `ratings` tables. `community_scores` view exists. RLS is enabled on both tables.
- **Depends on:** 1.9 (the SQL file must be written first — Sprint 0 and Sprint 1 interleave here)
- **Files:** None (Supabase SQL Editor only)

### Sprint 0 Validation Checklist
- [ ] Staging branch exists on GitHub
- [ ] Vercel preview URL generated for `staging-community` branch
- [ ] Supabase project active with Google OAuth + Magic Link enabled
- [ ] Redirect URLs configured for production, `staging-community` preview, and localhost
- [ ] `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel
- [ ] `SUPABASE_SERVICE_ROLE_KEY` in GitHub Secrets
- [ ] Database schema applied (after ticket 1.8)

---

## Sprint 1: Auth Foundation

**Goal:** A user can sign in with Google or magic link, see their auth state in the header, and sign out. Auth is a complete vertical slice — clicking "Sign In" triggers Google OAuth directly (no modal yet). The build passes and all existing tests remain green.

**Demo:** Open `staging-community` preview URL → click "Sign In" → redirected to Google → authorize → redirected back → see username in header dropdown → click "Sign Out" → back to "Sign In" button.

### Tickets

#### 1.1 — Install Supabase SDK
- **Do:** Add `@supabase/supabase-js` to `dependencies` in `package.json`. Run `npm install`.
- **Validation:** `npm install` exits 0. `npm run build` exits 0. `npm run test:data` exits 0. `package.json` lists `@supabase/supabase-js` in dependencies.
- **Files:** `package.json`, `package-lock.json`

#### 1.2 — Create Supabase client singleton
- **Do:** Create `src/lib/supabase.ts`. Export `getSupabaseClient()` that lazily creates a Supabase browser client using `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. If either env var is missing, return `null` (graceful degradation — build never fails without Supabase).
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. File exports exactly one function.
- **Files:** `src/lib/supabase.ts`

#### 1.3 — Create database TypeScript types
- **Do:** Create `src/types/database.ts` with interfaces: `Profile` (id, username, display_name, avatar_url, bio, created_at, updated_at), `Rating` (id, user_id, show_id, score, review_text, date_attended, created_at, updated_at), `CommunityScoreRow` (show_id, unique_raters, total_ratings, avg_score). Pure types, no runtime code.
- **Validation:** `npx tsc --noEmit` exits 0. Interfaces are importable from other `.ts`/`.tsx` files.
- **Files:** `src/types/database.ts`

#### 1.4 — Extract shared tier label utility
- **Do:** Create `src/lib/scoring-labels.ts`. Extract the tier label logic from `getSentimentLabel` in `src/app/show/[slug]/page.tsx` into a shared function:
  ```ts
  export function getTierLabel(score: number): { label: string; colorClass: string }
  ```
  Thresholds: Must-See (85+), Recommended (75-84), Worth Seeing (65-74), Skippable (55-64), Stay Away (<55). Update the show page's `getSentimentLabel` to call this shared function (no behavior change, just deduplication).
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. Show page renders identically (no visual change). `npm run test:e2e` passes.
- **Files:** `src/lib/scoring-labels.ts`, `src/app/show/[slug]/page.tsx`

#### 1.5 — Set up Vitest for unit testing
- **Do:**
  1. Install: `npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom` (Note: `jsdom` already in devDependencies)
  2. Create `vitest.config.ts` at project root:
     ```ts
     import { defineConfig } from 'vitest/config';
     import path from 'path';
     export default defineConfig({
       test: {
         environment: 'jsdom',
         globals: true,
         setupFiles: ['./tests/unit/setup.ts'],
       },
       resolve: {
         alias: { '@': path.resolve(__dirname, './src') },
       },
     });
     ```
  3. Create `tests/unit/setup.ts`:
     ```ts
     import '@testing-library/jest-dom';
     ```
  4. Add to `package.json` scripts: `"test:unit": "vitest run"`, update `"test"` to `"npm run test:data && npm run test:unit && npm run test:e2e"`
  5. Write initial unit tests in `tests/unit/scoring-labels.test.ts`:
     ```ts
     import { getTierLabel } from '@/lib/scoring-labels';
     describe('getTierLabel', () => {
       test('returns Must-See for 85+', () => { expect(getTierLabel(85).label).toBe('Must-See'); });
       test('returns Must-See for 100', () => { expect(getTierLabel(100).label).toBe('Must-See'); });
       test('returns Recommended for 75-84', () => { expect(getTierLabel(75).label).toBe('Recommended'); });
       test('returns Worth Seeing for 65-74', () => { expect(getTierLabel(65).label).toBe('Worth Seeing'); });
       test('returns Skippable for 55-64', () => { expect(getTierLabel(55).label).toBe('Skippable'); });
       test('returns Stay Away for <55', () => { expect(getTierLabel(54).label).toBe('Stay Away'); });
       test('returns Stay Away for 0', () => { expect(getTierLabel(0).label).toBe('Stay Away'); });
       test('boundary: 84 is Recommended not Must-See', () => { expect(getTierLabel(84).label).toBe('Recommended'); });
     });
     ```
  6. Write `tests/unit/supabase.test.ts`:
     ```ts
     import { getSupabaseClient } from '@/lib/supabase';
     describe('getSupabaseClient', () => {
       test('returns null when env vars are missing', () => {
         delete process.env.NEXT_PUBLIC_SUPABASE_URL;
         delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
         expect(getSupabaseClient()).toBeNull();
       });
     });
     ```
- **Validation:** `npx vitest run` exits 0. All unit tests pass. `npm run test` runs data + unit + E2E tests.
- **Files:** `vitest.config.ts`, `tests/unit/setup.ts`, `tests/unit/scoring-labels.test.ts`, `tests/unit/supabase.test.ts`, `package.json` (scripts)

#### 1.6 — Create AuthContext and AuthProvider
- **Do:** Create `src/contexts/AuthContext.tsx` (`'use client'`). Exports `AuthProvider` component and `AuthContext`. Provides: `user` (Supabase User | null), `profile` (Profile | null), `loading` (boolean), `signInWithGoogle()`, `signInWithMagicLink(email: string)`, `signOut()`.
  - Uses `onAuthStateChange` listener to track sign-in/sign-out
  - On `SIGNED_IN`: fetches profile from `profiles` table
  - `signInWithGoogle()` calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } })` — this ensures redirect back to the same page
  - Stores `pendingRedirectPath` in `sessionStorage` before OAuth redirect
  - On mount, checks `sessionStorage` for pending path and restores it
  - If `getSupabaseClient()` returns null: all values default (user=null, loading=false), sign-in functions are no-ops that log a warning
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. When no Supabase env vars: component renders children, user is null, no errors in console.
- **Files:** `src/contexts/AuthContext.tsx`

#### 1.7 — Create useAuth hook
- **Do:** Create `src/hooks/useAuth.ts`. Calls `useContext(AuthContext)`. If context is undefined (used outside provider), throws descriptive error: "useAuth must be used within an AuthProvider".
- **Validation:** `npx tsc --noEmit` exits 0. Import compiles without error.
- **Files:** `src/hooks/useAuth.ts`

#### 1.8 — Create UserMenu component
- **Do:** Create `src/components/UserMenu.tsx` (`'use client'`).
  - **Logged out:** "Sign In" button styled as `nav-link` (matches existing header links). Clicking calls `signInWithGoogle()` directly (no modal in Sprint 1 — modal comes in Sprint 3).
  - **Logged in:** Avatar circle (first letter of username as fallback) with click-to-toggle dropdown. Dropdown contains: "My Scorecard" link (→ `/my-scorecard`), divider, "Sign Out" button. Uses click-outside-to-close pattern from `HeaderSearch.tsx`.
  - **Loading:** Shows a subtle animated dot or nothing (don't flash "Sign In" then switch to avatar).
- **Validation:** `npm run build` exits 0. Component renders "Sign In" when logged out with no console errors. Dropdown opens/closes on click. Click-outside closes dropdown.
- **Files:** `src/components/UserMenu.tsx`

#### 1.9 — Create SQL schema file
- **Do:** Create `supabase/migrations/001_initial_schema.sql` containing:
  - `profiles` table: id (UUID FK to auth.users, PK), username (TEXT UNIQUE NOT NULL), display_name, avatar_url, bio (CHECK 500 chars), created_at, updated_at
  - `ratings` table: id (UUID PK), user_id (FK profiles), show_id (TEXT NOT NULL), score (INT CHECK 0-100), review_text (CHECK 500 chars), date_attended (DATE DEFAULT CURRENT_DATE), created_at, updated_at, UNIQUE(user_id, show_id, date_attended)
  - `community_scores` **regular view** (NOT materialized — auto-updates):
    ```sql
    CREATE VIEW public.community_scores AS
    SELECT show_id, COUNT(DISTINCT user_id) AS unique_raters,
           COUNT(*) AS total_ratings,
           ROUND(AVG(user_avg)::numeric, 1) AS avg_score
    FROM (SELECT user_id, show_id, AVG(score) AS user_avg
          FROM public.ratings GROUP BY user_id, show_id) user_averages
    GROUP BY show_id;
    ```
  - Indexes on ratings(show_id), ratings(user_id)
  - Unique index on profiles(lower(username))
  - Auto-create profile trigger: on `auth.users` insert, create profile with auto-generated username (`'theatergoer_' || floor(random() * 9000 + 1000)::text`)
  - `updated_at` trigger for both tables
  - RLS policies:
    - profiles: SELECT for all, UPDATE for owner only
    - ratings: SELECT for all, INSERT/UPDATE/DELETE for owner only
- **Validation:** SQL file parses without syntax errors (verify with a SQL linter or manual review). File is well-commented explaining each section. Run in Sprint 0 ticket 0.4.
- **Files:** `supabase/migrations/001_initial_schema.sql`

#### 1.10 — Create ClientProviders wrapper
- **Do:** Create `src/components/ClientProviders.tsx` (`'use client'`). Wraps children with `<AuthProvider>`. Single boundary between server layout and client auth state.
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. Component renders children unchanged.
- **Files:** `src/components/ClientProviders.tsx`

#### 1.11 — Integrate ClientProviders and UserMenu into layout
- **Do:** Modify `src/app/layout.tsx`:
  1. Import `ClientProviders` and `UserMenu`
  2. Wrap body contents (everything inside `<body>`) with `<ClientProviders>`
  3. Add `<UserMenu />` in header nav, after the desktop nav links div, before `<HeaderSearch>`
  4. Keep existing server-side `getSearchShows()` — it runs at build time, unaffected by client provider
- **Validation:** `npm run build` exits 0. `npm run test:data` exits 0. `npm run test:e2e` exits 0 (all existing E2E tests pass — "Sign In" is additive). Homepage loads in browser. All show pages load. No console errors. "Sign In" text is visible in header on desktop.
- **Files:** `src/app/layout.tsx`

### Sprint 1 Validation Checklist
- [ ] `npm run build` exits 0 with `output: 'export'`
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:unit` exits 0 (tier label + supabase client unit tests pass)
- [ ] `npm run test:e2e` exits 0 (all existing tests green)
- [ ] `npx tsc --noEmit` exits 0
- [ ] "Sign In" visible in header on desktop
- [ ] Clicking "Sign In" triggers Google OAuth flow (when Supabase configured)
- [ ] After Google auth, username appears in header dropdown
- [ ] "Sign Out" in dropdown returns to "Sign In" state
- [ ] When Supabase env vars are absent: app works identically to before (no Sign In button visible or it's inert)
- [ ] No console errors on homepage or show pages
- [ ] SQL schema file exists and is well-commented

---

## Sprint 2: Rating Widget UI

**Goal:** An interactive rating widget appears on every show detail page. The slider, tier labels, date picker, and optional review textarea all work. The Save button exists but is a no-op. No auth required to interact with the widget.

**Note:** This sprint can start in **parallel** with Sprint 1 tickets 1.5-1.10. The RatingWidget component is a pure UI component with no Supabase or auth dependencies — it takes `isLoggedIn` as a prop. Only ticket 2.4 (adding to show page) needs Sprint 1 complete because it uses the `useAuth` hook.

**Demo:** Navigate to any show page → see "Rate This Show" section → drag slider → tier label updates in real-time → change date → type optional review → Save button shows correct text.

### Tickets

#### 2.1 — Create RatingWidget component
- **Do:** Create `src/components/RatingWidget.tsx` (`'use client'`). Complete component with all sub-parts:
  - **Slider:** 0-100 range input. Default position: 75. Large score number display updates as slider moves.
  - **Tier label:** Uses shared `getTierLabel()` from `src/lib/scoring-labels.ts`. Updates dynamically. Uses existing score color classes (`text-score-must-see`, etc.).
  - **Scale guide:** Always-visible inline guide. Current tier row highlighted as slider moves. Shows all 5 tiers with score ranges.
  - **Date attended:** "When did you see it?" Defaults to today. Formatted display (e.g., "Jan 27, 2026"). "Change" link toggles `<input type="date">`.
  - **Optional review:** "Add a review (optional)" collapsed link. Click expands `<textarea>` with `maxLength={500}`. Live character counter ("142/500").
  - **Save button:** Calls `onSave` prop with `{ score, dateAttended, reviewText }`. Text varies: "Save Rating" (logged in), "Sign in to save your rating" (logged out). Loading spinner state. "Saved!" success state with auto-dismiss. Disabled state during save.
  - **Props:** `showId: string`, `isLoggedIn: boolean`, `onSave: (data) => Promise<void>`, `existingRating?: { score, dateAttended, reviewText }` (pre-populates for editing), `saving?: boolean`, `saved?: boolean`
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. Render the component standalone: slider moves and updates score display. Tier label changes at boundaries (54→55: "Stay Away"→"Skippable", 64→65: "Skippable"→"Worth Seeing", 74→75: "Worth Seeing"→"Recommended", 84→85: "Recommended"→"Must-See"). Date defaults to today. Review textarea expands/collapses. Character counter shows correct count. Save button text matches `isLoggedIn` prop.
- **Files:** `src/components/RatingWidget.tsx`

#### 2.2 — Style range slider for dark theme
- **Do:** Add custom CSS in `src/app/globals.css` for `.rating-slider`:
  - Dark track (`bg-surface-overlay`) with subtle border
  - Brand-colored thumb (`#d4a574`) — 20px diameter desktop, enlarged for mobile
  - Thumb touch target: 44px minimum on mobile (per existing mobile touch target convention)
  - `-webkit-appearance: none` for cross-browser consistency
  - Track fill color changes based on current tier (JS applies dynamic class)
  - Smooth thumb shadow on hover/active
  - Respects `prefers-reduced-motion` (no transitions when reduced motion preferred)
- **Validation:** `npm run build` exits 0. Slider thumb is visible on dark background. Thumb is grabbable on mobile (44px+ touch target verifiable via browser dev tools). Track and thumb colors follow design system.
- **Files:** `src/app/globals.css`

#### 2.3 — Add RatingWidget to show detail page
- **Do:** Create a small `'use client'` wrapper component `RatingWidgetSection` inline in or alongside the show page. It:
  - Uses `useAuth()` to get `user` (logged in or not)
  - Renders `<RatingWidget>` with `isLoggedIn={!!user}` and `onSave` as a no-op async function (logs to console)
  - Wrapped in an error boundary (simple try/catch in render, or Sprint 6's ErrorBoundary)
  - Section heading: "Rate This Show"
  - Placed after Audience Buzz section (or after Critic Reviews if no audience buzz data)
  - Shows for all statuses (open, closed, previews) — users can log historical viewings
  - Modify `src/app/show/[slug]/page.tsx` to import and render `RatingWidgetSection` passing `showId={show.id}`
- **Validation:** `npm run build` exits 0. `npm run test:e2e` exits 0 (all existing show page tests pass). Widget appears on at least one show page in browser. Slider is interactive. No console errors.
- **Files:** `src/app/show/[slug]/page.tsx` (or a new `src/components/RatingWidgetSection.tsx`)

### Sprint 2 Validation Checklist
- [ ] `npm run build` exits 0
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:e2e` exits 0
- [ ] Rating widget visible on all show detail pages
- [ ] Slider is interactive, score display updates in real-time
- [ ] Tier label changes at correct threshold boundaries (test: 54, 55, 64, 65, 74, 75, 84, 85)
- [ ] Scale guide visible, current tier highlighted
- [ ] Date defaults to today, "Change" toggles date picker
- [ ] Optional review textarea expands/collapses with live character counter
- [ ] Save button shows "Sign in to save your rating" when logged out
- [ ] Save button shows "Save Rating" when logged in
- [ ] No console errors on any show page

---

## Sprint 3: Auth-Gated Save Flow

**Goal:** The "rate first, auth after" flow works end-to-end. Logged-out users rate → save → auth modal → sign in → auto-save. Logged-in users save immediately. Multiple ratings per show (different dates) supported.

**Demo:** Visit show page logged out → adjust slider to 88 → click Save → auth modal appears with score preview → sign in with Google → modal closes → "Saved!" → rating persists in Supabase. Repeat for magic link flow.

### Tickets

#### 3.1 — Create AuthModal component
- **Do:** Create `src/components/AuthModal.tsx` (`'use client'`). Modal overlay:
  - **Header:** "Save your rating" (not "Sign up" or "Create account")
  - **Rating preview:** Score badge (using tier color), tier label, date attended — so user knows their input is preserved
  - **Google button:** Prominent, brand-styled. Calls `signInWithGoogle()`.
  - **Divider:** "or continue with email"
  - **Email input:** Text field + "Send link" button. Calls `signInWithMagicLink(email)`. After sending: show "Check your email!" confirmation replacing the form.
  - **Footer text:** "We'll create your account automatically"
  - **Close:** X button, click-outside, Escape key all close. Body scroll locked when open.
  - **Props:** `isOpen: boolean`, `onClose: () => void`, `pendingRating: { score: number, dateAttended: string, reviewText: string }`, `onAuthComplete: () => void`
  - Uses `useAuth()` for sign-in functions
  - Uses click-outside pattern matching `HeaderSearch.tsx`
- **Validation:** `npm run build` exits 0. `npx tsc --noEmit` exits 0. Modal renders when `isOpen=true`. Not visible when `isOpen=false`. Score preview displays correct score and tier label. Google button is clickable. Email input accepts text. Close button, click-outside, and Escape all set `isOpen=false` (via `onClose`). Body scroll is locked when modal is open.
- **Files:** `src/components/AuthModal.tsx`

#### 3.2 — Create useRating hook
- **Do:** Create `src/hooks/useRating.ts`. Custom hook accepting `showId: string`:
  - **State:** `ratings: Rating[]`, `isLoading: boolean`, `error: string | null`
  - **On mount (if logged in):** Fetches user's ratings for this showId from Supabase `ratings` table, ordered by `date_attended DESC`
  - **`submitRating(data: { score, dateAttended, reviewText })`:** Inserts into `ratings` table. Returns `{ success: boolean, error?: string }`. On success, refetches ratings. Client-side debounce: disable button for 2 seconds after submission.
  - **`updateRating(ratingId: string, data)`:** Updates existing rating row.
  - **`deleteRating(ratingId: string)`:** Deletes rating row. Refetches.
  - **Graceful degradation:** If `getSupabaseClient()` returns null, all operations return `{ success: false, error: 'Ratings not available' }`. No throws.
  - **Error handling:** Catches Supabase errors, returns user-friendly message. Unique constraint violation → "You've already rated this show for that date. Choose a different date or update your existing rating."
  - Uses `useAuth()` for `user.id`
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. When not logged in: returns `{ ratings: [], isLoading: false, error: null }`. `submitRating` returns object with `success` boolean (not void, not throw).
- **Files:** `src/hooks/useRating.ts`

#### 3.3 — Wire RatingWidget to useRating and AuthModal
- **Do:** Update `RatingWidgetSection` to connect everything:
  - Import and use `useRating(showId)` for ratings data and submit function
  - Import and render `AuthModal` (initially closed)
  - `useState` for `pendingRating` (preserved across auth flow)
  - **Save flow (logged in):** Call `submitRating()` → show "Saved!" state on widget → clear after 3 seconds
  - **Save flow (logged out):** Store `{ score, dateAttended, reviewText }` in `pendingRating` state → open AuthModal → `onAuthComplete` callback triggers `submitRating(pendingRating)` → close modal → show "Saved!"
  - **Existing ratings display:** If user has rated this show, show most recent rating below the widget: "You rated this show [score] on [date]". Link: "View all your ratings" → `/my-scorecard`.
  - **Rate again:** If already rated, show "Rate another viewing" button that resets the widget to defaults.
  - **Pre-populate on edit:** If `existingRating` passed (future use), slider/date/review pre-fill.
- **Validation:** `npm run build` exits 0. When logged out and Save clicked: `AuthModal` opens with correct score preview. After auth completes: rating saves automatically, modal closes, "Saved!" appears. When logged in and Save clicked: saves immediately, shows "Saved!". After rating: "You rated this show" message appears with correct score.
- **Files:** `src/components/RatingWidgetSection.tsx` (or inline in show page)

#### 3.4 — Handle Google OAuth redirect preservation
- **Do:** Update `src/contexts/AuthContext.tsx`:
  - Before calling `signInWithOAuth()`, store in `sessionStorage`:
    - `pendingRatingData`: JSON string of `{ score, dateAttended, reviewText, showId }`
    - `pendingRedirectPath`: `window.location.pathname`
  - `signInWithOAuth()` uses `redirectTo: window.location.origin + window.location.pathname` so user returns to the same show page
  - On `onAuthStateChange` `SIGNED_IN` event: check `sessionStorage` for `pendingRatingData`. If present, emit via a React state flag `hasPendingRating: boolean` (exposed in context).
  - `RatingWidgetSection` watches `hasPendingRating` and auto-submits the stored rating, then clears sessionStorage.
  - Also add `clearPendingRating()` to context API.
- **Validation:** `npm run build` exits 0. After Google OAuth: user lands on the same show page (not homepage). `sessionStorage` contains pending rating data before redirect. After auth completes, pending rating is detected and auto-saved.
- **Files:** `src/contexts/AuthContext.tsx`, `src/components/RatingWidgetSection.tsx`

#### 3.5 — Handle magic link email flow
- **Do:** Update `AuthModal.tsx`:
  - After `signInWithMagicLink()` succeeds: replace form with "Check your email! Click the link we sent to [email] to save your rating." message.
  - Show a "Resend" button (disabled for 60 seconds).
  - Magic link opens new tab. Original tab's `onAuthStateChange` fires `SIGNED_IN`.
  - `RatingWidgetSection` detects sign-in, finds pending rating still in React state (not sessionStorage — magic link doesn't redirect), auto-saves it.
  - Edge case: user closes modal before clicking magic link → pending rating stays in React state → user clicks Save again → modal reopens.
- **Validation:** `npm run build` exits 0. After sending magic link: "Check your email" UI shows with correct email address. "Resend" button is disabled initially. If auth completes from another tab: original tab detects it, auto-saves pending rating.
- **Files:** `src/components/AuthModal.tsx`

#### 3.6 — Add E2E test for rating widget presence
- **Do:** Add test to `tests/e2e/show-pages.spec.ts`:
  ```ts
  test('show page has rating widget', async ({ page }) => {
    // Navigate to a known show page
    await page.goto('/show/hamilton-2015');
    // Verify "Rate This Show" section exists
    await expect(page.getByText('Rate This Show')).toBeVisible();
    // Verify slider exists
    await expect(page.locator('input[type="range"]')).toBeVisible();
    // Verify save button exists
    await expect(page.getByRole('button', { name: /save|sign in/i })).toBeVisible();
  });
  ```
  - Tests static rendering only (no auth flow — would need Supabase test instance)
- **Validation:** `npm run test:e2e` exits 0. New test passes. All existing tests still pass.
- **Files:** `tests/e2e/show-pages.spec.ts`

### Sprint 3 Validation Checklist
- [ ] `npm run build` exits 0
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:e2e` exits 0 (including new test)
- [ ] Logged-out flow: rate → save → auth modal opens → score preview visible → sign in → auto-save → "Saved!" → stay on page
- [ ] Logged-in flow: rate → save → immediate "Saved!" confirmation
- [ ] Multiple ratings: rate show → rate same show with different date → both saved
- [ ] Duplicate date: rate show for same date → clear error message about duplicate
- [ ] Google OAuth: redirects back to same show page, pending rating auto-saves
- [ ] Magic link: "Check your email" UI → auth in other tab → original tab detects and auto-saves
- [ ] "You rated this show [score] on [date]" appears after rating
- [ ] No console errors throughout any flow

---

## Sprint 4: Community Score Display

**Goal:** Show pages display a "Community Score" card with aggregated average and rating count. Blue color scheme distinguishes from critic scores. "BETA" label. Empty state prompts rating.

**Note:** This sprint needs only Sprint 1 complete (Supabase client exists). It can run in **parallel** with Sprint 3.

**Demo:** Visit a show with ratings → blue "Community Score" card shows average and count → visit show with no ratings → "Be the first to rate!" prompt.

### Tickets

#### 4.1 — Create useCommunityScore hook
- **Do:** Create `src/hooks/useCommunityScore.ts`. Custom hook accepting `showId: string`:
  - **State:** `avgScore: number | null`, `uniqueRaters: number`, `totalRatings: number`, `isLoading: boolean`
  - **On mount:** Queries `community_scores` view filtered by `show_id`. If query errors (e.g., view doesn't exist because migration wasn't run), returns defaults and logs warning to console.
  - **Graceful degradation:** If `getSupabaseClient()` returns null, returns `{ avgScore: null, uniqueRaters: 0, totalRatings: 0, isLoading: false }`.
  - **No refetch:** Caches result in state. Does not re-query on re-render (only on mount).
- **Validation:** `npx tsc --noEmit` exits 0. `npm run build` exits 0. When no Supabase: returns defaults immediately. When Supabase configured but no ratings: returns `avgScore: null, uniqueRaters: 0`.
- **Files:** `src/hooks/useCommunityScore.ts`

#### 4.2 — Add community score styles to globals.css
- **Do:** Add `.score-community` class:
  ```css
  .score-community {
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    color: white;
    box-shadow: 0 0 16px rgba(59, 130, 246, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  ```
  Blue gradient with blue glow — visually distinct from gold (must-see), green (great), teal (good), amber (tepid), red (skip).
- **Validation:** `npm run build` exits 0. `.score-community` produces a visible blue badge on dark background (verify in browser).
- **Files:** `src/app/globals.css`

#### 4.3 — Create CommunityScore display component
- **Do:** Create `src/components/CommunityScore.tsx` (`'use client'`):
  - **Header:** "Community Score" with `BETA` badge (small uppercase pill, `bg-blue-500/20 text-blue-400`)
  - **Score badge:** Blue `.score-community` class, shows rounded integer score
  - **Tier label:** Uses shared `getTierLabel()` from `scoring-labels.ts`, displayed in blue
  - **Count:** "Based on N ratings from M members"
  - **Loading:** Pulse-animated skeleton matching card dimensions (`animate-pulse bg-surface-overlay`)
  - **Empty state:** "Be the first to rate this show!" with visual cue (arrow or highlight) pointing toward the rating widget section
  - Uses `useCommunityScore(showId)` internally
  - Props: `showId: string`
- **Validation:** `npm run build` exits 0. `npx tsc --noEmit` exits 0. Loading skeleton renders on initial load. Empty state shows when no ratings. Score + count render when data available. Blue badge is visually distinct from existing critic score badges.
- **Files:** `src/components/CommunityScore.tsx`

#### 4.4 — Add CommunityScore to show detail page
- **Do:** Modify `src/app/show/[slug]/page.tsx`:
  - Import `CommunityScore`
  - Place between Audience Buzz section and Rating Widget section
  - Pass `showId={show.id}`
  - Show for all statuses (open, closed, previews)
- **Validation:** `npm run build` exits 0. `npm run test:e2e` exits 0. Community Score section visible on show pages in browser. Positioned between Audience Buzz and Rate This Show.
- **Files:** `src/app/show/[slug]/page.tsx`

#### 4.5 — Add E2E test for community score section
- **Do:** Add test to `tests/e2e/show-pages.spec.ts`:
  ```ts
  test('show page has community score section', async ({ page }) => {
    await page.goto('/show/hamilton-2015');
    await expect(page.getByText('Community Score')).toBeVisible();
    await expect(page.getByText('BETA')).toBeVisible();
    // Either score is shown or "Be the first to rate"
    const hasScore = await page.getByText(/Based on \d+ rating/).isVisible().catch(() => false);
    const hasEmpty = await page.getByText(/Be the first to rate/).isVisible().catch(() => false);
    expect(hasScore || hasEmpty).toBe(true);
  });
  ```
- **Validation:** `npm run test:e2e` exits 0. New test passes. All existing tests pass.
- **Files:** `tests/e2e/show-pages.spec.ts`

### Sprint 4 Validation Checklist
- [ ] `npm run build` exits 0
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:e2e` exits 0 (including new test)
- [ ] Community Score card visible on show pages
- [ ] Blue badge is visually distinct from critic score colors
- [ ] "BETA" label displayed
- [ ] Empty state: "Be the first to rate this show!"
- [ ] With ratings: shows average score + count + tier label
- [ ] Loading skeleton displays before data loads
- [ ] No console errors

---

## Sprint 5: My Scorecard Page

**Goal:** Logged-in users can view all their ratings on a personal dashboard page. Stats include total shows rated and average score.

**Note:** Public profiles (`/u/username`) are deferred to post-MVP per review feedback — no value at zero users. My Scorecard provides the core "digital playbill collection" experience.

**Demo:** Sign in → click avatar dropdown → "My Scorecard" → see stats row + all ratings sorted by date → click show title → navigate to show page → come back.

### Tickets

#### 5.1 — Create My Scorecard page (server shell + client content)
- **Do:** Create `src/app/my-scorecard/page.tsx` as a server component with static metadata and a thin shell:
  ```tsx
  export const metadata = { title: 'My Scorecard' };
  export default function MyScorecardPage() {
    return <MyScorecardContent />;
  }
  ```
  Create `src/components/MyScorecardContent.tsx` (`'use client'`):
  - **Auth gate:** If `user` is null and `loading` is false, show sign-in prompt: "Sign in to start tracking your Broadway experiences" with Google sign-in button.
  - **Stats row:** Total shows rated (computed from ratings array length with unique showIds), Average score (mean of all scores), Member since (profile.created_at formatted).
  - **Ratings list:** All user ratings sorted by `date_attended` DESC. Each row: show title (link to `/show/{slug}` — requires mapping showId to slug from shows.json), score badge (using tier color + label), date attended, review text snippet (if any, truncated to 100 chars with "..." link).
  - **Delete:** Each rating has a "Delete" button (small, text-style). Click removes rating immediately (optimistic UI), shows "Undo" toast for 5 seconds. If undo clicked: re-inserts. If timeout: deletion is permanent.
  - **Empty state:** "You haven't rated any shows yet." with link to homepage: "Browse shows to get started →"
  - **Loading:** Full-page skeleton with pulsing stat cards and list rows.
  - Fetches all user ratings from Supabase: `ratings` table WHERE `user_id = user.id`, ordered by `date_attended DESC`.
  - Uses `useAuth()` for user/profile data.
- **Validation:** `npm run build` exits 0. `npx tsc --noEmit` exits 0. Page loads without errors. Auth gate shows sign-in prompt when logged out. Empty state shows when logged in but no ratings. Stats compute correctly (verified by comparing against known test data). Delete removes rating with undo option.
- **Files:** `src/app/my-scorecard/page.tsx`, `src/components/MyScorecardContent.tsx`

#### 5.2 — Update UserMenu dropdown with My Scorecard link
- **Do:** Update `src/components/UserMenu.tsx`:
  - "My Scorecard" link points to `/my-scorecard`
  - Remove placeholder "Settings" link (not needed for MVP)
  - Keep "Sign Out" button
- **Validation:** `npm run build` exits 0. Dropdown link navigates to `/my-scorecard`. No dead links.
- **Files:** `src/components/UserMenu.tsx`

#### 5.3 — Add E2E test for My Scorecard page
- **Do:** Create `tests/e2e/community-ratings.spec.ts` (new file):
  ```ts
  test('my scorecard page loads without errors', async ({ page }) => {
    await page.goto('/my-scorecard');
    await expect(page).not.toHaveTitle(/404/);
    // Should show either sign-in prompt or scorecard content
    const hasSignIn = await page.getByText(/sign in/i).isVisible().catch(() => false);
    const hasScorecard = await page.getByText(/my scorecard/i).isVisible().catch(() => false);
    expect(hasSignIn || hasScorecard).toBe(true);
  });
  ```
  Also add: rating widget present test, community score present test, mobile viewport test.
- **Validation:** `npm run test:e2e` exits 0. All new tests pass. All existing tests pass.
- **Files:** `tests/e2e/community-ratings.spec.ts`

### Sprint 5 Validation Checklist
- [ ] `npm run build` exits 0
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:e2e` exits 0 (including new tests)
- [ ] My Scorecard page loads without errors
- [ ] Auth gate: sign-in prompt shown when logged out
- [ ] Empty state: message + link shown when no ratings
- [ ] With ratings: stats row + sorted ratings list
- [ ] Show titles link to correct show pages
- [ ] Delete rating works with undo
- [ ] UserMenu "My Scorecard" link works
- [ ] No console errors

---

## Sprint 6: Error Handling, Polish & Preview Deploy

**Goal:** Feature is production-ready. Error states handled gracefully. Edge cases covered. All tests pass. Deployed to `staging-community` preview for user review.

**Demo:** Full end-to-end walkthrough. Also: disconnect network → error message (not crash). Also: Supabase down → show pages still render (just no community features).

### Tickets

#### 6.1 — Create AuthErrorBoundary
- **Do:** Create `src/components/AuthErrorBoundary.tsx` (class component — React error boundaries require class components):
  - Wraps auth/rating/community components
  - On error: renders fallback UI: "Community ratings are temporarily unavailable. The rest of this page works fine."
  - Logs caught error to `console.error`
  - Does NOT crash the show page — all static content (critics, box office, etc.) renders normally
- **Validation:** `npm run build` exits 0. If RatingWidget throws (simulate by temporarily adding `throw new Error('test')`): error boundary catches it, fallback UI shows, rest of page renders. Remove the simulated throw after testing.
- **Files:** `src/components/AuthErrorBoundary.tsx`

#### 6.2 — Wrap community components in error boundary
- **Do:** Update `src/app/show/[slug]/page.tsx`:
  - Wrap `<RatingWidgetSection>` in `<AuthErrorBoundary>`
  - Wrap `<CommunityScore>` in `<AuthErrorBoundary>`
  - Each wrapped independently so one failing doesn't hide the other
- **Validation:** `npm run build` exits 0. Both components render normally. If one fails, the other still shows.
- **Files:** `src/app/show/[slug]/page.tsx`

#### 6.3 — Add connection error handling to all hooks
- **Do:** Update `useRating.ts`, `useCommunityScore.ts`, `AuthContext.tsx`:
  - Wrap all Supabase calls in try/catch
  - Network error: set `error` state to "Couldn't load ratings. Check your connection."
  - Timeout: set `error` state to "Taking too long. Try refreshing."
  - Auth context: if `onAuthStateChange` subscription fails, log warning, proceed with null user
  - All error states are strings (not Error objects) for easy rendering
  - No `Promise` rejections escape to uncaught handler
- **Validation:** `npm run build` exits 0. No uncaught promise rejections in console under normal operation. Error strings are user-friendly (no technical jargon).
- **Files:** `src/hooks/useRating.ts`, `src/hooks/useCommunityScore.ts`, `src/contexts/AuthContext.tsx`

#### 6.4 — Audit and finalize loading/empty states
- **Do:** Review every new component and ensure:
  - `CommunityScore`: skeleton → score OR empty state (no blank flash)
  - `RatingWidget`: immediate render (no loading needed — it's local state)
  - `RatingWidgetSection`: subtle loading while checking existing ratings (show widget immediately, show "checking existing ratings..." briefly, then settle)
  - `MyScorecardContent`: full-page skeleton → content OR empty state
  - `UserMenu`: don't flash "Sign In" then switch to avatar — show nothing during loading, then show correct state
  - All skeletons use `animate-pulse` with `bg-surface-overlay` (matches existing codebase pattern)
- **Validation:** `npm run build` exits 0. No "flash of wrong content" on any component. Loading skeletons are visible and aesthetically consistent.
- **Files:** Multiple component files (minor tweaks)

#### 6.5 — Enforce review text max length client-side
- **Do:** Ensure `RatingWidget.tsx` textarea has `maxLength={500}` attribute. Ensure `useRating.ts` trims whitespace before submitting. React auto-escaping handles XSS (no `dangerouslySetInnerHTML` anywhere for user content).
- **Validation:** `npm run build` exits 0. Typing 501 characters in textarea: input stops at 500. Leading/trailing whitespace is trimmed on submit. Search codebase for `dangerouslySetInnerHTML` — must NOT appear near any user-generated content.
- **Files:** `src/components/RatingWidget.tsx`, `src/hooks/useRating.ts`

#### 6.6 — Comprehensive E2E test suite
- **Do:** Expand `tests/e2e/community-ratings.spec.ts`:
  ```ts
  // Rating widget tests
  test('rating widget has interactive slider', async ({ page }) => {
    await page.goto('/show/hamilton-2015');
    const slider = page.locator('input[type="range"]');
    await expect(slider).toBeVisible();
    // Verify slider has correct attributes
    await expect(slider).toHaveAttribute('min', '0');
    await expect(slider).toHaveAttribute('max', '100');
  });

  test('rating widget tier label is visible', async ({ page }) => {
    await page.goto('/show/hamilton-2015');
    // At least one tier label should be visible
    const tiers = ['Must-See', 'Recommended', 'Worth Seeing', 'Skippable', 'Stay Away'];
    let found = false;
    for (const tier of tiers) {
      if (await page.getByText(tier).isVisible().catch(() => false)) {
        found = true; break;
      }
    }
    expect(found).toBe(true);
  });

  // Community score tests
  test('community score section present on show pages', async ({ page }) => {
    await page.goto('/show/hamilton-2015');
    await expect(page.getByText('Community Score')).toBeVisible();
  });

  // Profile tests
  test('my scorecard page loads', async ({ page }) => {
    await page.goto('/my-scorecard');
    await expect(page).not.toHaveTitle(/404/);
  });

  // Mobile tests
  test('rating widget works on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/show/hamilton-2015');
    await expect(page.locator('input[type="range"]')).toBeVisible();
  });

  // No errors
  test('no console errors on show page with community features', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('/show/hamilton-2015');
    await page.waitForLoadState('networkidle');
    // Filter known non-critical errors (favicon, analytics)
    const critical = errors.filter(e => !e.includes('favicon') && !e.includes('analytics'));
    expect(critical.length).toBe(0);
  });
  ```
- **Validation:** `npm run test:e2e` exits 0. All new tests pass. All existing tests pass.
- **Files:** `tests/e2e/community-ratings.spec.ts`

#### 6.7 — Full validation pass
- **Do:** Run complete validation:
  1. `npm run build` — static export succeeds
  2. `npm run test:data` — data validation passes
  3. `npm run test:e2e` — all E2E tests pass (existing + new)
  4. `npx tsc --noEmit` — no TypeScript errors
  5. `npm run lint` — no new lint warnings
  6. Manual: check bundle size hasn't grown excessively (Supabase JS adds ~40KB gzipped — verify in build output)
  7. Manual: verify `output: 'export'` in next.config.js is still present
  8. Manual: search for `dangerouslySetInnerHTML` near user content — must find zero instances
- **Validation:** All 8 checks pass. Zero regressions.
- **Files:** None (validation only)

#### 6.8 — Push staging-community branch for Vercel preview
- **Do:** `git push origin staging-community`. Vercel auto-creates preview URL. Share URL with user.
- **Validation:** Vercel deployment succeeds. Preview URL is accessible. All features work in browser at the preview URL.
- **Files:** None (git only)

### Sprint 6 Validation Checklist
- [ ] `npm run build` exits 0
- [ ] `npm run test:data` exits 0
- [ ] `npm run test:e2e` exits 0 (all tests)
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm run lint` exits 0
- [ ] Error boundary catches component errors without crashing page
- [ ] Network errors show user-friendly message
- [ ] No uncaught promise rejections
- [ ] All loading skeletons render consistently
- [ ] Review text limited to 500 chars, whitespace trimmed
- [ ] No `dangerouslySetInnerHTML` near user content
- [ ] Mobile: all new components work at 375px width
- [ ] Vercel preview deploys and works end-to-end
- [ ] `output: 'export'` still in next.config.js

---

## File Inventory (All New/Modified Files)

### New Files (19)
| File | Sprint | Purpose |
|------|--------|---------|
| `src/lib/supabase.ts` | 1 | Supabase client singleton |
| `src/lib/scoring-labels.ts` | 1 | Shared tier label utility |
| `src/types/database.ts` | 1 | Database TypeScript types |
| `vitest.config.ts` | 1 | Vitest configuration |
| `tests/unit/setup.ts` | 1 | Unit test setup file |
| `tests/unit/scoring-labels.test.ts` | 1 | Tier label unit tests |
| `tests/unit/supabase.test.ts` | 1 | Supabase client unit tests |
| `src/contexts/AuthContext.tsx` | 1 | Auth state provider |
| `src/hooks/useAuth.ts` | 1 | Auth convenience hook |
| `src/components/UserMenu.tsx` | 1 | Header auth UI |
| `src/components/ClientProviders.tsx` | 1 | Client-side provider wrapper |
| `supabase/migrations/001_initial_schema.sql` | 1 | Database schema |
| `src/components/RatingWidget.tsx` | 2 | Rating slider + form |
| `src/components/RatingWidgetSection.tsx` | 2+3 | Wiring layer (auth + rating hook + widget) |
| `src/components/AuthModal.tsx` | 3 | Auth overlay modal |
| `src/hooks/useRating.ts` | 3 | Rating CRUD hook |
| `src/hooks/useCommunityScore.ts` | 4 | Community score fetcher |
| `src/components/CommunityScore.tsx` | 4 | Community score display |
| `src/app/my-scorecard/page.tsx` | 5 | My Scorecard page shell |
| `src/components/MyScorecardContent.tsx` | 5 | My Scorecard client content |
| `src/components/AuthErrorBoundary.tsx` | 6 | Error boundary |
| `tests/e2e/community-ratings.spec.ts` | 5+6 | E2E test suite |

### Modified Files (4)
| File | Sprint | Changes |
|------|--------|---------|
| `package.json` | 1 | Add `@supabase/supabase-js`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`; add `test:unit` script |
| `src/app/layout.tsx` | 1 | Wrap with ClientProviders, add UserMenu |
| `src/app/show/[slug]/page.tsx` | 1, 2, 4, 6 | Extract tier labels, add RatingWidgetSection, CommunityScore, error boundaries |
| `src/app/globals.css` | 2, 4 | Slider styles, community score badge |

### Test Files
| File | Sprint | Changes |
|------|--------|---------|
| `tests/e2e/show-pages.spec.ts` | 3, 4 | Add rating widget + community score presence tests |
| `tests/e2e/community-ratings.spec.ts` | 5, 6 | New comprehensive test suite |

---

## Corrected Dependency Chain

```
Sprint 0 (Infrastructure — manual setup, no code)
  ├── 0.1 create staging-community branch
  ├── 0.2 create Supabase project + configure auth
  ├── 0.3 add env vars to Vercel + GitHub
  └── 0.4 run SQL migration (after ticket 1.8 written)

Sprint 1 (Auth Foundation — code)
  ├── 1.1 install SDK
  ├── 1.2 supabase client (needs 1.1)
  ├── 1.3 types (independent)
  ├── 1.4 shared tier labels (independent)
  ├── 1.5 vitest setup + unit tests (needs 1.2, 1.4)
  ├── 1.6 auth context (needs 1.2, 1.3)
  ├── 1.7 useAuth hook (needs 1.6)
  ├── 1.8 UserMenu (needs 1.7) — Sign In triggers Google OAuth directly
  ├── 1.9 SQL schema file (independent — applied in Sprint 0.4)
  ├── 1.10 ClientProviders (needs 1.6)
  └── 1.11 layout integration (needs 1.8, 1.10)

Sprint 2 (Rating Widget UI) — can START in parallel with Sprint 1
  ├── 2.1 RatingWidget component (needs only 1.4 for tier labels)
  ├── 2.2 slider CSS styles (needs 2.1)
  └── 2.3 add to show page (needs 2.1, 2.2, AND Sprint 1 complete for useAuth)

Sprint 3 (Auth-Gated Save) — needs Sprints 1 + 2 complete
  ├── 3.1 AuthModal (needs 1.7 for useAuth)
  ├── 3.2 useRating hook (needs 1.2, 1.3, 1.7)
  ├── 3.3 wire everything (needs 3.1, 3.2, 2.3)
  ├── 3.4 Google OAuth redirect (needs 3.3)
  ├── 3.5 magic link flow (needs 3.3)
  └── 3.6 E2E test (needs 3.3)

Sprint 4 (Community Score) — needs Sprint 1 only, PARALLEL with Sprint 3
  ├── 4.1 useCommunityScore hook (needs 1.2, 1.3)
  ├── 4.2 community score CSS (independent)
  ├── 4.3 CommunityScore component (needs 4.1, 4.2, 1.4)
  ├── 4.4 add to show page (needs 4.3)
  └── 4.5 E2E test (needs 4.4)

Sprint 5 (My Scorecard) — needs Sprint 3 complete (ratings exist to display)
  ├── 5.1 My Scorecard page (needs 1.7, 3.2)
  ├── 5.2 UserMenu link update (needs 5.1)
  └── 5.3 E2E test (needs 5.1)

Sprint 6 (Polish) — needs Sprints 3 + 4 + 5 complete
  ├── 6.1 error boundary (independent)
  ├── 6.2 wrap components in error boundary (needs 6.1)
  ├── 6.3 connection error handling (needs 3.2, 4.1, 1.6)
  ├── 6.4 loading/empty states audit (needs all components)
  ├── 6.5 review text enforcement (needs 2.1, 3.2)
  ├── 6.6 comprehensive E2E tests (needs all above)
  ├── 6.7 full validation (needs all above)
  └── 6.8 push staging-community for preview (needs 6.7)
```

### Parallelization Opportunities
```
Week 1: Sprint 0 + Sprint 1 (1.1-1.4, 1.8 can be done first)
         Sprint 2.1 + 2.2 can start once 1.4 is done
Week 2: Sprint 1 (1.5-1.10) + Sprint 2.3
         Sprint 4 can start once Sprint 1 is complete
Week 3: Sprint 3 + Sprint 4 (in parallel)
Week 4: Sprint 5 + Sprint 6
```

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| `output: 'export'` breaks with auth | All Supabase calls are client-side only. No server components fetch from Supabase. Auth context checks for `typeof window !== 'undefined'`. |
| Supabase env vars missing in build | `getSupabaseClient()` returns null. All hooks return defaults. UI shows no community features. Build never fails. |
| Google OAuth redirect loses page context | `signInWithOAuth({ redirectTo: window.location.origin + window.location.pathname })` + `sessionStorage` for pending rating data. |
| OAuth redirect URL not whitelisted | Sprint 0 ticket 0.2 explicitly configures `https://broadwayscorecard.com/**` and `staging-community` preview patterns in Supabase dashboard. |
| Community score view is stale | Regular SQL view (not materialized) — auto-updates on every query. No refresh mechanism needed. |
| Bundle size increase | `@supabase/supabase-js` ~40KB gzipped. Acceptable. Can lazy-load in future if needed. |
| Existing E2E tests break | Every sprint validates `npm run test:e2e`. New components are additive. Error boundary prevents cascading failures. |
| Tier label inconsistency | Shared `getTierLabel()` in `scoring-labels.ts` used by both critic display and rating widget. Single source of truth. |
| User content XSS | React auto-escaping via `{text}` rendering. No `dangerouslySetInnerHTML` for user content. DB constraint enforces 500 char limit. |

---

## Post-MVP Backlog (Not in These Sprints)

| Feature | Why Deferred |
|---------|-------------|
| Public profiles (`/u/username`) | No value at zero users — social feature needs critical mass |
| DB-level rate limiting (20/hr) | Unique constraint prevents duplicates. Client debounce prevents double-click. Real abuse unlikely at launch. |
| `shows_seen_count` denormalized trigger | Compute client-side from ratings array. Optimize later if slow. |
| Unit tests for hooks (useRating, useCommunityScore) | Requires React Testing Library + Supabase mocking. Pure utility tests are in Sprint 1; hook tests are post-MVP scope. |
| Supabase lazy loading | Load `@supabase/supabase-js` only when user interacts with auth/rating. Reduces bundle for read-only visitors. |
| Custom magic link email template | Default Supabase `@supabase.io` sender works for MVP. Brand later. |
| Blend Community Score into Audience Buzz | Wait for data quality proof before mixing into the weighted formula. |

---

Use subagents liberally!
