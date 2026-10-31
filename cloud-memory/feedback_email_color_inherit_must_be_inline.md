---
name: email-color-inherit-must-be-inline
description: Gmail dark-mode strips color:inherit from <style>-defined classes; inline color:inherit survives — link resets in email HTML must stay inline
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff57183e-fbb4-4221-95c3-65b00720d107
---

In email HTML, `color:inherit` MUST stay inline on `<a>` tags. Do NOT move it into a `<style>`-block class definition (even when extracting other repeated styles for byte savings).

**Why:** Gmail's dark-mode rewriter resolves class-applied `color:inherit` to default browser link blue rather than the parent's intended color. Inline `style="color:inherit"` survives the rewrite untouched. Discovered 2026-05-25 during the newsletter HTML diet: `.lnk{color:inherit;text-decoration:none}` looked identical in code but rendered every show-title link blue in Gmail. Reverting just the `.lnk` class back to inline fixed it; other classes (.mp, .gp, .cardbg, .tdec, .showttl carrying only padding/sizing/font-weight) were safe to keep.

**How to apply:** When optimizing email HTML for size, structural CSS (padding, border-radius, font-size, font-weight, letter-spacing) can move to `<style>` classes. ANY rule containing `color:inherit` must stay inline. Likely also true for `background:inherit` and `color: <var>` patterns Gmail rewrites in dark mode — when in doubt, keep color-related styles inline.

Related: see [[email-broadcast-rules]] for other email-pipeline rules.
