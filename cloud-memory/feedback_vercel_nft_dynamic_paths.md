---
name: feedback_vercel_nft_dynamic_paths
description: "process.cwd()+'data/'+variable in server code causes NFT to include entire data/ tree (590MB git packs + audit logs), blowing past Vercel's 250MB function limit"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b0f88094-bea0-4077-8b88-7d581ce225bc
---

**Rule**: Never use `process.cwd() + 'data/' + dynamicFilename` in any server-rendered page or API route. Use static `import` declarations or `path.join(__dirname, '..', 'data', specificFile)` instead.

**Why**: Next.js Node File Tracer (NFT) sees `process.cwd()` + a variable path and includes the ENTIRE project directory as potential runtime dependencies. For `data/`, this means `.git/objects/pack/*.pack` (590MB), `data/audit/*.jsonl` (100MB+ each), `data/broadway.db` (34MB), `data/llm-scoring-runs.json` (42MB), etc. — inflating a single function from ~58MB to 4578MB, crashing Vercel's 250MB per-function limit.

**How to apply**:
- When writing server code that reads from `data/`: use `import foo from '../../data/foo.json'` (static import) — NFT resolves to the specific file only
- If file may not exist: wrap static import in try/catch or use `require()` with a literal path string (not a variable)
- The `outputFileTracingExcludes` in `next.config.js experimental` is a belt-and-suspenders guard but does NOT fix dynamic paths — the root fix must be in the source code
- The symptom: Vercel deploy fails with "A Serverless Function has exceeded the unzipped maximum size of 250 MB" and one specific `.rsc.func` has thousands more files than expected

**Fix applied 2026-05-17**: `loadMarketData(filename)` in `src/lib/data-tony-nominees.ts` was changed from `fs.readFileSync(path.join(process.cwd(), 'data', filename))` to static imports (`import polymarketRawData from '../../data/tony-polymarket-odds.json'`). Nominees RSC function went from 4578MB to 58MB.

**Related**: `findActorSlug()` in the same file still uses `process.cwd() + 'data/cast/' + showId + '.json'` — this traces all cast files (~11MB) but doesn't exceed the limit as cast files are small. Watch if limit approaches 250MB again.
