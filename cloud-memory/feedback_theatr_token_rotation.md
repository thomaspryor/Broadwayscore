---
name: Theatr token rotation safety
description: Never authenticate with Theatr without persisting the rotated refresh token — tokens burn on use
type: feedback
archived: true
---

Never call the Theatr auth endpoint (`/v1/auth/access-tokens`) without saving the returned `refreshToken` to the GitHub secret or a committed file. Theatr rotates the refresh token on every use — the old one is immediately invalidated.

**Why:** A test workflow authenticated to inspect the API response but didn't persist the new refresh token. This burned both the local and GH secret tokens, requiring a painful mitmproxy intercept to recover.

**How to apply:**
- Never create throwaway/test workflows that call Theatr auth
- Any code that authenticates with Theatr MUST save `data.content.refreshToken` (to temp file AND update GH secret if in CI)
- If you need to test the Theatr API, use the existing `scrape-theatr-audience.js` which handles token rotation correctly
- The `fetch-show-images-auto.js` Theatr integration already saves to `data/theatr-refresh-token.tmp` — the workflow should update the GH secret from this file after the step completes
