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

## 8. Migrate the existing markdown reviews into Sanity

The 4 reviews currently in `content/reviews/*.md` need to be migrated into Sanity. One-shot script:

1. **Create an Editor API token** in Sanity:
   - sanity.io/manage → your project → **API → Tokens → Add API token**
   - Name: `migrate-reviews`
   - Permissions: **Editor** (read+write)
   - Copy the token (starts with `sk...`)

2. **Run the migration locally:**
   ```bash
   export SANITY_API_WRITE_TOKEN=skXXX...
   export NEXT_PUBLIC_SANITY_PROJECT_ID=fp1ft8k8
   export NEXT_PUBLIC_SANITY_DATASET=production
   node scripts/migrate-reviews-to-sanity.js --dry-run    # preview
   node scripts/migrate-reviews-to-sanity.js              # for real
   ```

3. **Verify in Studio** at https://broadwayscorecard.com/studio. Confirm 4 Show Reviews appear (Cats, Edward, High Spirits, Spelling Bee).

4. **Flip the source-of-truth flag** in Vercel:
   ```bash
   cd /Users/tompryor/Broadwayscore
   vercel env add USE_SANITY_REVIEWS production --value true --yes
   vercel env add USE_SANITY_REVIEWS preview --value true --yes
   vercel env add USE_SANITY_REVIEWS development --value true --yes
   ```
   Re-deploy. `/reviews` now reads from Sanity.

5. **Delete the API token** in Sanity once migration is verified. The blog reads with no token (public dataset, published-only).

6. **Keep `content/reviews/*.md` as backup** for one release cycle, then delete them.

## 9. Known cosmetic follow-up

`/studio` currently uses a `position: fixed` overlay to hide the BWSC site chrome. The idiomatic fix is a Next.js route group with its own root layout. Small refactor — do it when there's time.
