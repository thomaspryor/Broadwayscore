# Blog / Sanity CMS — setup & contractor onboarding

## 1. Create the Sanity project (one-time, ~3 minutes)

1. Go to https://www.sanity.io/manage and sign in with Google (use your BWSC Google account).
2. Click **Create new project**.
3. Name: `Broadway Scorecard — Editorial`.
4. Project template: **Clean project with no predefined schemas** (we ship our own schema in `src/sanity/schemas/post.ts`).
5. Dataset: accept the default name `production` (public access is fine — no secrets live in the dataset).
6. Copy the **Project ID** (8-character hex) from the project dashboard.

## 2. Add the Sanity project ID to Vercel env vars

```bash
# From the repo root:
vercel env add NEXT_PUBLIC_SANITY_PROJECT_ID production
# paste the project ID when prompted

vercel env add NEXT_PUBLIC_SANITY_DATASET production
# enter: production

# Also add for Preview so branches work:
vercel env add NEXT_PUBLIC_SANITY_PROJECT_ID preview
vercel env add NEXT_PUBLIC_SANITY_DATASET preview
```

And locally in `.env.local` (copy from `.env.sanity.example`):

```
NEXT_PUBLIC_SANITY_PROJECT_ID=<your-project-id>
NEXT_PUBLIC_SANITY_DATASET=production
NEXT_PUBLIC_SANITY_API_VERSION=2024-10-01
```

## 3. Whitelist the production domain in Sanity CORS

https://www.sanity.io/manage → your project → **API → CORS origins** → Add:

- `https://broadwayscorecard.com` (check *Allow credentials*)
- `https://*.vercel.app` (for preview deployments — no credentials)
- `http://localhost:3000` (for local dev — check *Allow credentials*)

## 4. Invite the contractor

https://www.sanity.io/manage → your project → **Members → Invite members**:

1. Enter the contractor's email.
2. Role: **Editor** (can create/edit/publish content, cannot invite others or change project settings).
3. They receive an email with a login link. They log in at **https://broadwayscorecard.com/studio** with Google/email.

### To revoke

Same Members page → click the three dots next to their email → **Remove from project**. Their Studio access and API token are invalidated immediately.

## 5. How publishing works

- Contractor logs into `/studio`, creates a post, fills in title, slug, excerpt, hero image, body, and `publishedAt`.
- Hits **Publish**.
- The next request to `/blog` on broadwayscorecard.com picks up the new post within 60 seconds (ISR `revalidate = 60`).
- For instant publishing, add a Sanity webhook: **API → Webhooks → Create webhook** pointing to your Vercel deploy-hook URL (optional, not required for v1).

## 6. Local development

```bash
npm install     # (already run — next-sanity, @sanity/vision, sanity, @portabletext/react)
npm run dev
```

Open:
- http://localhost:3000/blog — blog index
- http://localhost:3000/blog/[slug] — individual posts
- http://localhost:3000/studio — the Studio (log in with the email that owns the Sanity project)

## 7. Schema changes

Edit `src/sanity/schemas/post.ts` — add fields via `defineField`. Deploy as usual; Sanity Studio picks up the new schema on next load.

## 8. Known cosmetic follow-up

`/studio` currently uses a `position: fixed` overlay to hide the BWSC site chrome. The idiomatic fix is a Next.js route group with its own root layout. Small refactor — do it when there's time.
