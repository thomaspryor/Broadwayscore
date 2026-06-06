---
name: Visual verify before push
description: SUPERSEDED by [[local-preview-before-push]] — same rule, now mechanically enforced by hooks (verify-edits.sh is_ui_edit + pre-push-visual-gate.sh) instead of advisory
archived: true
type: feedback
originSessionId: 89a611cf-8c76-4361-89a4-5b6776e4a8c8
---

**SUPERSEDED 2026-05-24** — see [[local-preview-before-push]] and `.claude/skills/visual-qa/skill.md`. The gate now blocks Stop and push automatically when UI files change without a fresh verdict.

Original content below for history:

Every UI change must be visually verified on a running dev server (or live site) before committing. TypeScript passing and lint passing tell you nothing about whether the page looks correct.

**Why:** Session on 2026-04-12 shipped 4 broken logo iterations in a row — wrong image file (screenshot used as logo), background color mismatch, shield cropped too tight, logo displayed too small. Each time Claude said "done" without actually looking at the result on a real page. The user had to catch every issue.

**How to apply:**
1. After ANY edit to a file that renders visible HTML (pages, components, layout), start/use a dev server
2. Take a Playwright screenshot at the viewport size users will see (390px mobile, 1440px desktop)
3. Actually LOOK at the screenshot before committing — is it what you expected?
4. For images: verify the image file itself (Read it) AND verify how it renders on the page (screenshot)
5. `npx tsc --noEmit` is necessary but NOT sufficient for UI changes
6. Never tell the user "it's done" or "it looks good" until you've seen it rendered

This is not optional. The verification gate hook should treat UI file edits differently from logic-only edits.
