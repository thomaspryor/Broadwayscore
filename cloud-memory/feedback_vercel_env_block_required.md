---
name: vercel-build-env-block-required
description: "`vercel build` does NOT inline NEXT_PUBLIC_* from .vercel/.env.preview.local. Only the build step's env: block reaches Next.js. Writing to the env file is a no-op for NEXT_PUBLIC_ inlining."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 95a5d861-cfa7-43b7-91fb-711151fb4018
---

When `npx vercel build` runs in CI it logs: `WARNING! Build not running on Vercel. System environment variables will not be available.` and only honors env vars exposed via the workflow step's `env:` block. Writing `NEXT_PUBLIC_FEATURES=...` into `.vercel/.env.preview.local` is silently ignored for Next.js build-time string-literal inlining.

**Why this matters:** Next.js inlines `process.env.NEXT_PUBLIC_*` references at build time as literal strings (so `featureFlags.has('awards')` evaluates to true/false at build, not runtime). If the env var isn't in the build step's `env:` block, the resulting bundle has the empty string baked in — feature flags silently default to false.

**Correct pattern (mirrors how Sanity vars already work in vercel-demo.yml):**
```yaml
- name: Compute demo feature flag list
  id: demo-flags
  run: |
    ALL=$(node -e "…extract from feature-flags.ts…")
    echo "flags=$ALL" >> "$GITHUB_OUTPUT"

- name: Build (all features enabled)
  env:
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
    NEXT_PUBLIC_FEATURES: ${{ steps.demo-flags.outputs.flags }}  # <-- this is what reaches Next.js
  run: npx vercel build --token=$VERCEL_TOKEN
```

**Wrong pattern (what we tried first and lost an hour to):**
```yaml
- name: Set demo feature flags via .vercel/.env.preview.local  # NO-OP
  run: |
    echo "NEXT_PUBLIC_FEATURES=…" >> .vercel/.env.preview.local
```

**Why a second-opinion review missed this:** the leak-guard step at `vercel-deploy.yml:176` reads `NEXT_PUBLIC_FEATURES` from `.vercel/.env.production.local` via grep. That proves the FILE contains the var, NOT that `vercel build` inlines it into the bundle. Two different things. Pre-existing Sanity backfill at vercel-demo.yml:85-103 also writes the env file, but the Sanity vars ALSO live in the env: block of the build step — that's why they actually work.

**Diagnostic:** if a feature flag controlled by NEXT_PUBLIC_FEATURES isn't taking effect on demo despite the env-file write succeeding, grep the deployed JS bundle for the flag-list literal:
```bash
curl -sL https://demo.broadwayscorecard.com/_next/static/chunks/page-XXXX.js | grep -c "awardScoreV2"
# 0 = not inlined, env file alone isn't enough
```

Origin incident: 2026-05-17, broke the Awards Scorecard v2 demo. Fix shipped in commit ae9dece9a3.
