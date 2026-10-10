---
name: actions-cache-no-save-on-hit
description: GitHub actions/cache@v4 skips the save step when restore hits the primary key — cache mutations between deploys silently never persist
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a31f4cef-d4fa-40ec-bd4d-c390619e6577
---

`actions/cache@v4` treats the cache as immutable once restored. If the **restore** step finds an EXACT match on the primary key, the post-step at end of job logs "Cache hit occurred on the primary key... not saving cache" and SKIPS the save entirely. Any new content written to the cached path during the job is lost.

**When this bites:** Any workflow that uses a cache to persist content that MUTATES between runs — incremental build caches, content-hash gates, fingerprint files, etc.

**Why:** Verified empirically on 2026-05-24 while debugging the per-show hash gate in `scripts/generate-mobile-show-details.js`. The script wrote `data/cache/mobile-show-details/last-hash.json` on each run, but every subsequent deploy started with the stale pre-existing cache because the save step was skipped. Symptom: `cache=cold` or `cache=global-invalidate` in logs despite globalHash matching across runs.

**How to apply:**
Use a unique primary key per run (e.g. `${{ github.run_id }}`) so the primary key NEVER matches on restore. The restore falls through to `restore-keys` (a prefix-based fallback) to find the most recent matching cache. Save always happens because primary key didn't match.

```yaml
- uses: actions/cache@v4
  with:
    path: |
      .next/cache
      data/cache
    key: nextjs-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-${{ github.run_id }}
    restore-keys: |
      nextjs-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-
      nextjs-cache-${{ runner.os }}-
```

GHA auto-evicts old cache entries via LRU when the 10GB-per-repo cap is reached. At normal deploy frequency (50-100/day, ~200MB caches), eviction happens but the recent caches survive.

**Alternative:** Split into `actions/cache/restore@v4` + `actions/cache/save@v4` and use `lookup-only` / always-save semantics. Less ergonomic; the unique-key pattern is simpler.

See: https://github.com/actions/cache#cache-version

Live fix: `.github/workflows/vercel-deploy.yml` "Cache Next.js build + prebuild artifacts" step (commit 528f3ff31d, 2026-05-24).
