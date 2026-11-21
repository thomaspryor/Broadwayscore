---
name: feedback_client_bundle_fs_import_leak
description: Never import Node.js built-ins (like `fs`) into modules consumed by client components.
type: feedback
originSessionId: 0f27767b-bc53-4ef7-86b6-6ebbfedf8e30
draftedAt: 2026-07-26
---

# Never import Node.js built-ins (like `fs`) into modules consumed by client components.

**Why:** A `'use client'` component in Next.js cannot import from modules that use Node.js built-ins like `fs`, `path`, or `os`. During build, these pollute the client bundle and cause a build failure. In this session, `SocialPulseCard.tsx` (a client component) was importing `MIN_OPINION_SAMPLE` from `data-social-pulse.ts`, which contains `import fs from 'fs'` for reading data files. This would have silently broken the build.

**How to apply:** When a constant or utility function is needed by both client and server code, or by any client-facing component, extract it into a dependency-free module (no Node imports). In this case, `src/lib/social-pulse-display.ts` was created as a shared module with zero dependencies, allowing both `SocialPulseCard.tsx` and `TrendingShowCard.tsx` to import the sentinel value safely. Audit any module that a client component imports transitively; if it uses `fs`, `child_process`, or other Node APIs, move the shared parts to a clean utility file first.
