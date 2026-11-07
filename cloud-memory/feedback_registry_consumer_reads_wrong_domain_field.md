---
name: feedback_registry_consumer_reads_wrong_domain_field
description: "outlet-registry alternate-domain field is `domainAliases` (50 outlets); consumers reading `domains`/`alternateDomains` silently miss them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0695b843-cb11-45db-af36-8ff6d6ea855d
---

The canonical alternate-domain field in `data/outlet-registry.json` is **`domainAliases`** (~50 outlets, e.g. `huffpost → huffingtonpost.com`, `guardian → guardian.co.uk`). The keys `domains` and `alternateDomains` survive on **1 outlet each** — historical drift, not the real field.

`scripts/audit-show-review-gap.js:getKnownDomainMap()` was building its domain→outletId map from `domain` + `domains` + `alternateDomains` and **ignoring `domainAliases`**, so already-registered alternate domains read as "unknown" and got provisional-onboarded as duplicate outlets (card 386637c5, 2026-06-21). `scripts/lib/outlet-canonicalize.js:buildDomainMap()` reads `domainAliases` correctly — the two consumers had diverged. Fixed: gap audit now reads `domainAliases` first.

Same fix added `registrableHost()` to the gap audit's `hostOf()`: strip `amp./m./mobile.` mirror prefixes and collapse section subdomains (`theater.nytimes.com → nytimes.com`) to the registrable domain before the lookup — but **exempt blog platforms** (`pub.substack.com` must stay whole so `provisionalOutletIdFromHost` keeps the per-publication slug). Mirrors `PROVISIONAL_BLOG_PLATFORMS` / `PROVISIONAL_MULTIPART_SUFFIXES` in `outlet-canonicalize.js`.

**Why:** A registry that holds the data correctly is useless if the consumer greps the wrong field name. The failure is silent — no error, just real outlets quietly duplicated under provisional slugs. Registry holds *registrable* domains; subdomain/mirror variants are a normalization concern, not new registry rows (don't add `theater.nytimes.com` as a domainAlias — that's the duplicate-entry bloat).

**How to apply:** When a script maps registry domains, read `domainAliases` (the canonical field), not `domains`/`alternateDomains`. Before adding a host to the registry, check whether it's just a subdomain/mirror of an existing entry — if so, fix host normalization, not the data. Cross-check new domain-map code against `outlet-canonicalize.js:buildDomainMap()` so the two stay in sync. Related: [[feedback_outlet_registry_dual_repo.md]], [[feedback_dual_repo_data_files.md]].
