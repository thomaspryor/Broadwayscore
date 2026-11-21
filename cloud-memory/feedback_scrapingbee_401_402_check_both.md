---
name: feedback_scrapingbee_401_402_check_both
description: "ScrapingBee 401/402 doesn't tell you key-vs-credits; read the JSON message body and check usage; project has multiple SB accounts"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 29f089c4-7922-4ae6-9938-5fe644aece01
---

A ScrapingBee 401/402 means an auth/billing problem but does NOT tell you which one: 401 can be an invalid/expired key ("Invalid api key: ...") OR a depleted account, and this project has **more than one SB key/account**. Don't trust the error label.

**Why:** On 2026-06-21 a stale CI `SCRAPINGBEE_API_KEY` secret (last set Feb 19) on a depleted account returned 401, which the code labeled "credits exhausted (401)". That label sent debugging toward topping up credits and creating a Reddit OAuth app (the app-creation reCAPTCHA loops in Brave AND iPhone Safari — a known dead end). The real fix was repointing the secret to a *different* funded `.env` key. The user separately topped up the *old* account, confusing which fix mattered.

**How to apply:**
- On any SB failure, read SB's JSON `message` body (`{"message":"Invalid api key: ..."}` vs a credits message) — don't infer from status alone. `reddit-api.js` now echoes it.
- Verify the specific key with `curl "https://app.scrapingbee.com/api/v1/usage?api_key=$KEY"` → `max_api_credit` / `used_api_credit`. Confirm the GitHub secret's key matches a funded account; a secret can be stale (months old) pointing at the wrong/empty account.
- Reddit is the canary: SB is its ONLY working proxy because Bright Data can't access reddit.com ("not available for immediate access mode in accordance with robots.txt") and Reddit edge-blocks all non-browser clients (even residential curl gets a 189KB "network security" block; only a real browser or SB stealth/premium passes). A stale SB key surfaces on Reddit first.
- See [[feedback_sb_credit_budget.md]], [[feedback_brightdata_zone_migration.md]], [[feedback_cloudflare_bypass_hierarchy.md]].
