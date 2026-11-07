---
name: supabase-freetier-pause
description: "Supabase free-tier projects auto-pause after ~7 days idle — host NXDOMAINs and ALL sign-in/read/write breaks; diagnose via Management API status, restore via workflow"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6687e1e0-8979-43b9-9502-a7b861e34e1b
---

The UGC Supabase project (`broadway-scorecard`, ref `tcbkoevwfemkicrwpypb`) is on the **free tier, which auto-pauses after ~7 days of inactivity**. When paused (status `INACTIVE`) Supabase tears down the compute AND the DNS record, so `<ref>.supabase.co` returns **NXDOMAIN from everywhere** — not just a 503. Every sign-in, read, and write in the app silently fails; the site looks up but auth is dead.

**Symptom → diagnosis:** "fetch failed / ENOTFOUND `<ref>.supabase.co`" from CI or local, while `api.supabase.com` (Management API) still resolves. Don't conclude "wrong URL / deleted project" — list projects via the Management API first:
`GET https://api.supabase.com/v1/projects` with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` → check the project's `status`. `INACTIVE` = paused (data intact), not gone.

**Fix:** run the `Restore Supabase Project` workflow (`scripts/restore-supabase-project.mjs`) — POSTs `/v1/projects/{ref}/restore`, waits for `ACTIVE_HEALTHY` (~4 min). Data survives a pause.

**How to apply:**
- Sign-in / UGC "not working" reports → check project status FIRST (paused is the likeliest cause after an idle stretch), before touching code.
- `test-ugc-roundtrip.yml` runs daily and after every demo deploy; it now fails loud (critical email) on pause AND its daily writes double as a keep-alive that prevents idle-pause as long as it runs. Don't disable it.
- The local dev sandbox on this machine cannot resolve `*.supabase.co` at all (NXDOMAIN even via 8.8.8.8) — Supabase round-trips must be verified in CI, not locally. [[feedback_css_contain_traps_fixed_modals.md]] pattern: live-verify, don't trust green local fixtures.
- Real launch fix (money decision, user's call): Supabase Pro ($25/mo) never idle-pauses.
