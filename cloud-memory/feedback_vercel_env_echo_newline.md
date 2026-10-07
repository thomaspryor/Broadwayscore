---
name: Vercel env vars — never use echo to pipe values
description: echo appends a trailing newline that gets stored in the env var; use printf instead
type: feedback
originSessionId: ba2676a0-1232-4de7-b090-d7af31195aa2
archived: true
---
Never use `echo "value" | vercel env add VAR production` — `echo` appends `\n` and Vercel stores it as part of the value. Comparisons against the raw value then fail silently (looks like auth is broken, but really the stored value has a hidden trailing newline).

Use `printf '%s' "$value" | vercel env add VAR production` instead.

**Why:** On the admin dashboard ship (Apr 10 2026), I used `echo` to pipe the `ADMIN_TOKEN` into Vercel. Auth kept 404ing on production even though the route was matched and the token looked correct. Pulled the env back with `vercel env pull` and found `ADMIN_TOKEN="dIatCPfM91FvMVJ8lwsrByAWiYnNqzJn\n"`. Cost 2 deploy cycles to diagnose.

**How to apply:**
- When piping any secret into `vercel env add`, always use `printf '%s'` (no trailing newline, no format interpretation).
- After setting, confirm with `vercel env pull .env.prod --environment=production` and check the dumped value has no trailing `\n`.
- If auth works locally but 404s on production and the route is clearly matched (`x-matched-path` header confirms), trailing-newline in env vars is a strong suspect.
- Applies to `ADMIN_TOKEN`, API tokens, cookie secrets, any value compared with strict equality.
