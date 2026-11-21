---
name: Next.js generateSitemaps route conflict
description: generateSitemaps() auto-registers /sitemap.xml — never add an explicit route.ts at the same path
type: feedback
originSessionId: d59d8829-4122-4b3b-9482-cb128b9d8588
archived: true
---
Never create `src/app/sitemap.xml/route.ts` when `src/app/sitemap.ts` uses `generateSitemaps()`.

**Why:** `generateSitemaps()` auto-registers `/sitemap.xml[[...__metadata_id__]]` (the root index) AND `/sitemap/[id].xml` (shards). An explicit `route.ts` at `/sitemap.xml` creates a "same specificity" conflict that crashes the dev server with: `Error: You cannot define a route with the same specificity as a optional catch-all route`. The build still works (static export ignores the conflict) but dev is broken.

**How to apply:** If you need custom sitemap index behavior (e.g., per-shard lastmod), you cannot use an explicit route handler at `/sitemap.xml`. Options: (1) accept the auto-generated index, (2) serve a custom index at a different path like `/sitemap_index.xml` and point robots.txt at it.
