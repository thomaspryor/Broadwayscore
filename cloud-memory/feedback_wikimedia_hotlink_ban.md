---
name: Wikimedia hotlink ban
description: "/commons/thumb/ hotlinks deprecated April 2026; theater images now local."
type: feedback
archived: true
---

Never hotlink Wikimedia Commons thumbnail URLs (/commons/thumb/). Wikimedia deprecated this in April 2026 — all such URLs return HTTP 429 permanently.

**Why:** Wikimedia changed their thumbnail serving policy. The error page (https://w.wiki/GHai) directs to a new API, but we don't need it — local copies are faster and more reliable.

**How to apply:** Theater images are served from `public/images/theaters/{slug}.jpg` (42 files). If adding new theaters or images from Wikimedia, download the image locally rather than hotlinking. The `getTheaterImageUrl()` function in both theater pages handles the path.
