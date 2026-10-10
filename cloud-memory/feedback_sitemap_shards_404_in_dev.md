---
name: sitemap-shards-404-in-dev
description: "generateSitemaps() shards (/sitemap/N.xml) 404 in next dev even for a valid index — verify via direct execution against data-core.ts, not curl against the dev server"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 32421e12-2f8d-48cb-9b86-654343e82cbb
  modified: 2026-08-14T03:13:08.711Z
---

`src/app/sitemap.ts` uses `generateSitemaps()` to produce sharded sitemaps at `/sitemap/N.xml` (per `scripts/seo-utils.js` and `scripts/check-seo-health.js` — the canonical URL pattern, `robots.txt` lists all shards). These routes return 404 when hit via `curl` against a running `next dev` server, even for a shard index (`0`) that's valid in production — the static-export sitemap generation only runs at build/export time, not in dev.

**Why it matters:** after editing `buildTheatersShard()` (or any other shard builder) in `sitemap.ts`, curling `http://localhost:3000/sitemap/N.xml` to verify the change will always 404 regardless of whether the fix is correct — this is not a signal the fix is broken.

**How to apply:** verify sitemap-builder changes by directly executing the underlying data function instead of hitting the HTTP route. `tsx` (already a devDependency) can import `.ts` files directly:
```bash
npx tsx -e "
import { getAllOffBroadwayTheaterSlugs } from './src/lib/data-core';
console.log(getAllOffBroadwayTheaterSlugs().length);
"
```
run from the repo root so relative imports resolve. This is real execution against real data (not a type check), satisfying the verification bar without needing a full `next build`.
