---
name: nft-excludes-vs-runtime-reads
description: Adding a path to next.config.js outputFileTracingExcludes silently breaks any runtime fs.* read of that path; CI guard catches it
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9d5850f7-f0bc-4c43-a7a0-f5b3afd7f912
---

Never add a path to `outputFileTracingExcludes` in `next.config.js` without first auditing `src/`/`app/` for any code that reads from that path at runtime (`fs.readdirSync`, `fs.readFileSync`, `fs.existsSync`, `require(dynamicVar)`, anything using `process.cwd()`-derived paths).

**Why:** Commit e2154a1b23 (May 2026) added `data/cast/**` to the excludes as a "belt-and-suspenders" guard for the Tony nominees NFT fix. But `src/lib/data-actors.ts` and `src/lib/data-cast-obc.ts` BOTH still read `data/cast/` dynamically via `fs.readdirSync(process.cwd() + '/data/cast')`. In Vercel's serverless bundle, the directory was missing → empty actor map → every `/cast/[slug]` returned 404, and `/show/[slug]` rendered without cast schema/UI after ISR revalidate. Locally everything worked because the directory existed on disk; tests + tsc + `next build` did not catch it.

**How to apply:**
- Before adding/extending `outputFileTracingExcludes`, grep `src/ app/` for the path: `grep -rn "data/cast" src/ app/`. Any dynamic fs.* or `require(var)` referencing that prefix is a blocker — refactor to a static-required prebuilt manifest first (pattern: `scripts/build-cast-manifest.js` + `import x from '../../data/cast-manifest.json'`).
- CI guard `scripts/audit-nft-excluded-runtime-reads.js` runs in `test.yml` (`typescript-check` job) and fails on the conflict statically. If it flags a false positive (a script-only file that never imports into src/app), narrow the offending file scope rather than weakening the guard.
- Webpack inlines static `import x from '../../data/foo.json'` and static `require('literal-string')` — those are safe and the audit ignores them.
- See [[vercel_nft_dynamic_paths]] for the original NFT pruning issue this all stems from.
