---
name: claude-seo-toolkit
description: "claude-seo skill suite installed 2026-07-19 — where it lives, how to run audits, which specialists were useful for BWSC"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6eb9c393-2198-46be-9ec9-c25bd499550f
  modified: 2026-07-19T23:54:17.107Z
---

claude-seo v2.2.0 (AgriciDaniel/claude-seo, ~9.4K stars) installed 2026-07-19 into `~/.claude/skills/seo*` (30+ sub-skills: seo-audit, seo-sxo, seo-geo, seo-backlinks, seo-content, seo-schema, seo-google, ...) + subagent types (seo-sxo, seo-geo, etc. available in the Agent tool's registry after install). Python venv: `~/.claude/skills/seo/.venv/bin/python3`; scripts at `~/.claude/skills/seo/scripts/` (render_page.py, commoncrawl_graph.py, backlinks_auth.py --check).

Most useful specialists for BWSC (2026-07-19 audit): **seo-sxo** (reads SERPs backwards — proved "[show] broadway" is a ticketing-intent SERP no aggregator can win, while "[show] reviews" is winnable via verdict-first layout), **seo-geo**, **seo-backlinks** (Common Crawl graph: BWSC not in crawl at all as of cc-2026-jan-mar). No Moz/Bing/DataForSEO keys configured — free tiers only.

Full audit report: `~/Documents/claude-outputs/broadwayscorecard-audit/FULL-AUDIT-REPORT.md`. GSC access recipe: [[gsc-api-auth]]. Per-outlet review pages plan: `~/Documents/claude-outputs/plan-per-outlet-review-pages-2026-07-19.md`.
