---
name: feedback-tailwind-jit-arbitrary-restart
description: New Tailwind arbitrary classes (e.g. min-w-[760px]) added mid-dev-server are NOT picked up by hot-reload; CSS computes as default (0). Restart dev server to force a Tailwind rescan.
metadata:
  archived: true
  type: feedback
  originSessionId: dbb4711d-b2fd-4824-a30c-440ee0feee95
---

**Tailwind JIT scans source files at build start.** When the dev server is already
running and you add a new arbitrary value class (`min-w-[760px]`, `w-[52px]`,
`text-[10px]`, etc.) to the source, hot-reload re-renders the component but does
NOT trigger a Tailwind rescan. The CSS for the new class never gets generated,
so the rule effectively becomes a no-op — `min-w-[760px]` computes as `min-width: 0px`.

**Symptoms that look like other bugs:**
- Container width collapses to zero / viewport minimum
- Flex children with `flex-1 min-w-0` shrink to 0 because the parent's min-width
  didn't apply
- Title text rendered as `<h3>` shows up with `width: 0` and disappears

**How to spot it:** in DevTools or Playwright, the offending class appears on the
element's `className` but `getComputedStyle().minWidth` (or `width`, etc.) is the
default value, not what the class says.

**Why:** Add the change to the source. Restart the dev server (`kill $(lsof -ti:PORT)`
then re-launch). Hot-reload from that point onward will detect any *additional*
arbitrary values you add, but the initial restart is required after introducing
the FIRST instance of a new pattern.

**How to apply:**
- If you add ANY new arbitrary class during a session and the layout looks wrong,
  bounce the dev server before debugging further. Saved time vs chasing a fake
  layout bug.
- Tailwind v3 JIT behavior — verify with `getComputedStyle().minWidth === "0px"`
  alongside `className` containing `min-w-[Npx]`.
- Cost on 2026-05-21: ~10 min of diagnostic work assuming the title element had
  a layout bug, before realizing the new `min-w-[760px]` class wasn't generating
  CSS. Dev-server restart fixed it immediately.
