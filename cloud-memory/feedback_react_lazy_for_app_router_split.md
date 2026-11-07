---
name: react-lazy-for-app-router-split
description: "In Next.js 14 App Router, use React.lazy() inside a 'use client' Loader for real code-splitting; next/dynamic() from a server component is a no-op for First Load JS reduction"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ef7d5c2a-b230-4128-87dd-f8c2f3429af7
---

For Next.js 14 App Router bundle splitting, `next/dynamic()` called from a server component is a no-op — it does NOT reduce First Load JS. The only way to create a real client-bundle split boundary in App Router is `React.lazy(() => import('./Foo'))` inside a `'use client'` component, wrapped in `<Suspense>`.

**Why:** RSC architecture already strips server-only components from the client bundle; what determines First Load JS is the boundary between server → client. `next/dynamic()` in a server component just inlines into the same client chunk as the parent. `React.lazy()` in a client component creates a separate chunk.

**How to apply:** When a page hits a bundle size cap, identify the heaviest client components and move them behind a 2-file pattern: `Foo.tsx` ('use client', heavy imports) + `FooLoader.tsx` ('use client', wraps `lazy(() => import('./Foo'))` in `<ErrorBoundary><Suspense fallback={null}>`). Server page imports only the Loader. Pre-compute any private-data lookups server-side and pass as serializable props — client component can't import private data modules.

**Evidence:** `/show/[slug]` First Load JS reduced 332kB → 253kB (24%) on 2026-05-20 via this pattern. See commit 35f4393629 + 1fb566232f. Files: `src/components/show-page/ShowPageBelowFold.tsx` + `ShowPageBelowFoldLoader.tsx`.

**Watch out:** Components dominated by shared chunk dependencies (already in the 88kB shared bundle) contribute only their own unique code to the split chunk — VideoReviewsShelf + AudienceBuzzCard only saved ~1kB when moved. Below-fold split wins come from components with unique heavy deps (charts, complex forms, large feature surfaces).
