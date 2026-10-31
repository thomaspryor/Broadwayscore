---
name: Flag Tech Scorecard carry-over changes
description: A generic web fix on Broadway Scorecard (performance, SEO, structured data, accessibility, security headers, shared card/badge/header UI, framework upgrade) also belongs on thetechscorecard.com; flag it with a PORT-TECH line or the port-tech Linear label so the weekly porting routine finds it.
type: feedback
---
Tech Scorecard (thetechscorecard.com, repo `thomaspryor/tech-scorecard`) is built on this site's layout and scoring method. The owner wants general improvements made here to reach it too, reliably (BRO-5980, 2026-10-22).

**How to apply:** when a change is a generic web improvement, not Broadway data, pipeline, tooling or a show-only feature, mark it in one of two ways:

- a commit message line starting `PORT-TECH: <what to carry over, one line>`
- the `port-tech` label on the Linear card

Examples that qualify: page-weight or payload budgets, font/image loading, title/canonical/Open Graph/sitemap/robots rules, JSON-LD policy fixes, focus rings, 44px touch targets, layout at 320-414px, contrast, response headers, Next.js/React upgrades, fixes to ScoreBadge, list/mini cards, tier chip, header or footer.

**Why:** a weekly routine (prompt and rules in tech-scorecard `docs/PORTING.md`) reviews the past week's landings and Done cards and ports what applies. It also scans unflagged commits, but flags are how nothing gets missed. CLAUDE.md has no room for this note (byte cap).
