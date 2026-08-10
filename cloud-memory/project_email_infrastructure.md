---
name: Broadwayscorecard.com email infrastructure
description: Inbox + sender setup for the broadwayscorecard.com domain — what receives mail, what sends, and which is which.
type: project
originSessionId: 9d75ef47-5f92-405c-bf33-25906fd54eab
archived: true
---
**Inbound (receiving) — ImprovMX paid plan ($9 one-time, paid 2026-04-11):**
- 8 aliases all forward to `thomas.pryor@gmail.com`: `hi@`, `press@`, `contact@`, `alerts@`, `noreply@`, `healthcheck@`, `tom@`, + 1 more. Dashboard at app.improvmx.com (sign in with Google).
- `hi@` is also configured in Gmail Settings → Accounts and Import → "Send mail as" with SMTP relay `smtp.improvmx.com:465`, so Gmail can reply from the address.
- Verified active 2026-04-25 (all aliases green in dashboard).

**Health-check gotcha:** Sending FROM `updates@broadwayscorecard.com` (Resend) TO `hi@broadwayscorecard.com` (ImprovMX) **bounces** at ImprovMX as same-domain anti-loop protection. This is NOT a forwarding failure — external senders work fine. To genuinely health-check, use ImprovMX's per-alias "TEST" button in the dashboard, or send from any external address (personal Gmail, etc.).

**TikTok (and likely Instagram/Meta) silently block signups to ImprovMX domains.** Verification email is never sent — confirmed 2026-04-25 by Gmail-wide search returning zero. For social-media signups that reject ImprovMX, fall back to: (a) phone signup, (b) `thomas.pryor@gmail.com` then change later, or (c) Google Workspace ($7/mo) for a real mailbox.

**API key location:** Not in env, GitHub secrets, keychain, or .env files. Available via app.improvmx.com → "API Keys" tab. Future sessions can save as `IMPROVMX_API_KEY` for programmatic monitoring.

**Outbound (Resend, send-only):**
- `updates@broadwayscorecard.com` — opening-night broadcasts, brand-mention emails. Used in `scripts/send-opening-night-broadcast.js` and `scripts/lib/brand-mention-email.js`.
- `alerts@broadwayscorecard.com` — Discord/alert-style notifications (`scripts/lib/discord-notify.js`).
- These are domain-verified Resend senders only. They do NOT receive — bounces/replies go nowhere unless also added as ImprovMX aliases.
- **Reply-To (added 2026-08-10):** every audience-facing send now sets `reply_to: hi@broadwayscorecard.com` via `buildReplyToAddress()` in `scripts/lib/email-templates.js` (weekly round-up broadcast + test send, opening-night broadcast + preview, follow notifications, feedback thank-yous). Before this, replies to the weekly went to `updates@` and bounced — which is why the owner had never seen a single reader reply. Guard test: `scripts/lib/email-templates-headline.test.mjs`.

**Why:** `hi@` was set up via ImprovMX as the cheap path to a working inbox without paying for Google Workspace/Fastmail. Resend handles transactional/broadcast outbound separately because it needs a verified domain for deliverability, not an inbox.

**How to apply:**
- For social media account signups (Twitter/X, LinkedIn, TikTok, Buffer, etc.) use `hi@broadwayscorecard.com` — verification codes will arrive in Tom's Gmail.
- Instagram/Facebook sometimes reject forwarding-service addresses; if signup bounces, fall back to `thomas.pryor@gmail.com` and change later.
- ImprovMX free tier has a daily forwarding cap (~25/day per alias) — fine for signups, would cap on high-volume inbound. If a use case needs reliable bulk inbound, upgrade ImprovMX or move to Workspace.
- Don't try to "receive" at `updates@` or `alerts@` — those are Resend-only. Add an ImprovMX alias if needed.
- If broadwayscorecard.com DNS is ever migrated, ImprovMX MX records and Resend SPF/DKIM/DMARC must both be preserved.
