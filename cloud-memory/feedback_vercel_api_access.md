---
name: feedback-vercel-api-access
description: User confirmed Claude has Vercel API access via VERCEL_TOKEN — no need to ask user to set env vars manually
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb4711d-b2fd-4824-a30c-440ee0feee95
---

Use the Vercel API directly to manage env vars, rather than telling the user to do it in Vercel settings.

**Why:** VERCEL_TOKEN is in the project `.env`. User pointed this out when Claude told them to manually add `tony-predictions` to `NEXT_PUBLIC_FEATURES`.

**How to apply:**
- Project ID for broadwayscore: `prj_wmBnDUrCQCwabIAYPbnMiIP3wg15`
- Get all env vars: `GET /v10/projects/{projectId}/env`
- Get decrypted value: `GET /v10/projects/{projectId}/env/{envId}` 
- Update env var: `PATCH /v10/projects/{projectId}/env/{envId}` with `{ "value": "..." }`
- After updating an env var, trigger a redeploy via `gh workflow run "Deploy to Vercel" # FORCE-DEPLOY`

Env var naming follows camelCase (`tonyPredictions`, not `tony-predictions`) consistent with `feature-flags.ts`.
