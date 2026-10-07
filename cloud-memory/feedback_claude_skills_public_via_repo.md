---
name: claude-skills-public-via-repo
description: ".claude/skills committed to the public repo are auto-indexed by skill catalogs (claudskills.com); redact operational detail, keep mechanism; prevention is the pre-push guard not this note"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 84a13561-ff45-4f50-83fc-009846ea7e5a
---

The web repo (thomaspryor/Broadwayscore) is PUBLIC and `.claude/` (skills, CLAUDE.md, hooks, settings.json, CLOUD.md) is committed — intentionally, because cloud Claude Code sessions bootstrap from committed `.claude/CLOUD.md` + skills. Side effect: catalog sites like claudskills.com scrape public GitHub for `.claude/skills/**/skill.md` and index them. The brand-mention monitor flags these as "mentions." Incident: 2026-06-16, `verify-opening-night` skill indexed.

**Why:** Expected behavior of a public repo, not a leak — but operational scraping detail (paywall hosts, cookie names, anti-bot tactics) becomes publicly searchable. Nothing un-publishes what's already committed (git history + catalog caches persist); redaction only shrinks the future surface.

**How to apply:**
- Never put named paywall hosts, exact cookie names, or "how we bypass X" framing in a committed skill/gotchas/cloud-memory file. Move identifiers to a gitignored file (e.g. `scraper-reference/references/cookies.md`, ignored at `.gitignore:167`); keep the *mechanism* committed so cloud sessions still work.
- **This note is NOT the prevention** — it's advisory and only fires if recalled. The enforcing control is the pre-push guard `.claude/hooks/check-skill-redaction.sh`, which blocks `git push` if any string in the gitignored denylist `.claude/skills/.redaction-denylist.txt` reappears in committed `.claude/skills/**` or `cloud-memory/**`. Add new sensitive strings to that denylist when you redact something. Limitation: the hook is local-only (protects Claude sessions on this machine); it does not protect manual pushes from other machines or cloud sessions.
- Going private is NOT a cheap fix: ~928 GHA runs/24h → ~$400-640/mo on private Actions billing vs free unlimited on public.
- `scripts/lib/cookie-loader.js` `COOKIE_DOMAIN_MAP` is load-bearing at CI runtime (~10 scripts) — do NOT gitignore/move it to hide the outlet list; that breaks all paywalled scraping. It's a low-narrative routing table.
- Rewrite history only if a *live credential* leaked (none here; all `*_COOKIES` are `secrets.X`). See [[feedback_private_repos]].
