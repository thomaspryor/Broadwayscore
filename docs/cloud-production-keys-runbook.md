# Production API keys in a cloud session

Moved out of `.claude/CLOUD.md` (BRO-7315). The text is unchanged.

The environment has PostHog, Sentry and Supabase keys (read+write): `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` (us.posthog.com), `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`, `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_` key; the `apikey` header), `SUPABASE_ACCESS_TOKEN` (Management API, project-scoped) + `SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Scraper, Resend, Bing, Impact, Formspree keys are set; no GA4 or Anthropic key. `node scripts/cloud-run-script.js [--review-texts] [--timeout=MIN] scripts/<x>.js [args...]` dispatches `run-script.yml`, runs the script as on origin/main with read keys, and prints its sealed output. Without `gh`, use `mcp__github__actions_run_trigger` (`script`, `args_json`, `pubkey_b64` from `generateKeyPair()` in `scripts/lib/sealed-output.js`, `request_id`) and `open()` the sealed block from `get_job_logs`. Paywalled: `scripts/fetch-page-probe.js`. Land scripts first. Data changes use `execute-approved-fix.yml` or their own workflows. Withheld: VERCEL_TOKEN, logins, cookies.

