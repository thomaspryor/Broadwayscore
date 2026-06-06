---
name: seo-platforms-verified-2026-05
description: "Two SEO platforms named in the project's DA playbook are dead/scammy as of 2026-05 — use the verified replacements. Re-check before any future DA push."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6576f6b1-f5cf-46d7-892d-af5f39756f94
---

## Rule

Before recommending any "fast win" SEO/PR signup from the project DA playbook (`memory/seo-domain-authority-guide.md`), check status. Two platforms in the original (April 2026) playbook are not safe to use:

- **HARO (helpareporter.com)** — Cision shut down the Connectively rebrand on 2024-12-09. Featured.com bought the brand and runs the new newsletter. Telling the user "sign up for HARO" sends them to a domain that no longer hosts a signup. Use **Featured.com** or **Source of Sources (sourceofsources.com)** instead.
- **Feedspot** — widespread reports (Trustpilot, BBB, blogger forums) that it scrapes RSS feeds without permission, retains content after deletion, sells blogger contact info to spam outreach companies, and runs deceptive "Top 15" badge upsells. The directory listing is not a legitimate DA play; the cost is content theft and inbox spam.

**Why:** the user remembered Feedspot felt off when they tried it before. They asked me to verify the plan before re-pitching it. Verification turned up both platforms as failed — confirming their instinct. Re-pitching a known-broken stack burns trust.

**How to apply:**
- If a session involves the DA / SEO playbook, **WebSearch each platform name + "shut down" or "scam"** before pitching it. SEO platforms turn over fast.
- The verified-real 2026-05 stack: SOS (free), Featured.com (free), Qwoted (free tier), X #JournoRequest/#PRRequest saved search, Wikipedia COI-disclosed Talk proposals.
- CSP probe (2026-05-25) on 5 major Broadway producer sites (Hamilton, Wicked, MJ, Book of Mormon, Maybe Happy Ending) returned no `Content-Security-Policy` or `X-Frame-Options` headers — iframe embed widgets are not network-blocked on producer sites, contrary to my initial worry. Re-probe before building any embed widget; producer site infra changes.

Related: [[seo-domain-authority-guide]] (playbook itself).
