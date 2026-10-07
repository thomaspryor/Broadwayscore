---
name: feedback_tls_fingerprinting
description: Use fetch() not https.get() for scraping CDN-protected sites in CI
type: feedback
archived: true
---

Always use `fetch()` (Node 18+ / undici) instead of `https.get()` or `https.request()` when scraping CDN-protected sites like Reddit and Broadway.com.

**Why:** GitHub Actions IPs get bot-detected via TLS fingerprinting. `https.get()` uses OpenSSL's TLS fingerprint, which CDNs and bot-detection systems (Cloudflare, Fastly, Reddit) block with 403 or HTML responses. `fetch()` uses undici's TLS fingerprint (different cipher suite ordering, different extension ordering), which these systems allow. This affected both `reddit-api.js` (Reddit's CDN) and `scrape-broadway-com-audience.js` (Broadway.com) — both returned HTML/403 in CI but worked locally because local IPs aren't flagged.

**How to apply:** When adding any new scraper that targets a site with bot-detection (anything behind Cloudflare, Fastly, or with aggressive User-Agent filtering), use `fetch()` by default. Use `AbortController` for timeout: `const controller = new AbortController(); setTimeout(() => controller.abort(), 15000);`. Redirects are handled automatically with `redirect: 'follow'`.
