---
name: Sanity public datasets still gate reads
description: Even when a Sanity dataset is set to Public visibility, anonymous reads return [] on newer projects (Growth Trial 2026-04). Use a server-only Viewer token (SANITY_API_READ_TOKEN, no NEXT_PUBLIC_ prefix) — that's the standard production pattern anyway.
type: feedback
originSessionId: d02b062b-53e1-40c2-b795-7fd233158fb5
archived: true
---
When wiring a Sanity-backed Next.js route, expect to need a Viewer token even if the dataset visibility is set to Public. Verified empirically against the BWSC project (fp1ft8k8) on 2026-04-25:

- aclMode confirmed `public` via management API
- Anonymous query (`https://{projectId}.api.sanity.io/v2024-10-01/data/query/{dataset}?query=...`) returned `[]`
- Same query with Bearer token returned all 4 docs

**Why:** Likely a Sanity policy change for newer/Growth-tier projects, or a separate Access-tab role gating that's not exposed in the simple Public/Private dataset toggle.

**How to apply:** When setting up a new Sanity-backed route:
1. Create a Viewer-role API token at sanity.io/manage → API → Tokens
2. Set `SANITY_API_READ_TOKEN` (no NEXT_PUBLIC_ prefix — server-only) in Vercel env vars (all 3 environments)
3. Pass `token: process.env.SANITY_API_READ_TOKEN` to `createClient` in src/sanity/client.ts
4. Don't waste time on the Public/Private dataset toggle — it doesn't fix this

**Don't use the Editor migration token in the runtime client.** It works but has unnecessary write permissions. Create a dedicated Viewer token after migration completes; delete the Editor token.

References:
- Initial setup: src/sanity/client.ts (commit aab37899e5)
- Discovery: PR #281 work session 2026-04-25
