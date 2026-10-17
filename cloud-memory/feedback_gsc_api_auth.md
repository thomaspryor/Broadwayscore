---
name: gsc-api-auth
description: How to authenticate with Google Search Console API via gcloud ADC — required scopes and project setup
metadata: 
  node_type: memory
  type: reference
  originSessionId: 695e6a64-643e-4e48-9464-ae84f8a76dbf
---

Google Search Console API (`searchconsole.googleapis.com`) is accessible via gcloud ADC, but setup has 3 non-obvious gates that all must be satisfied:

**1. Auth scopes** — gcloud REJECTS `webmasters` scope alone; `cloud-platform` is required alongside:
```bash
gcloud auth application-default login \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters,openid,https://www.googleapis.com/auth/userinfo.email"
```

**2. API enabled on quota project** — even with the right scopes, the call returns "API has not been used in project X" until enabled:
```bash
gcloud services enable searchconsole.googleapis.com --project=cowriter-27499
```

**3. Quota project header** — every API call needs `X-Goog-User-Project: cowriter-27499` (ADC defaults don't propagate this for googleapis).

**Working call pattern:**
```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -s "https://searchconsole.googleapis.com/webmasters/v3/sites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Goog-User-Project: cowriter-27499"
```

**Properties owned (thomas.pryor@gmail.com):** `sc-domain:broadwayscorecard.com` (domain-level — covers all subdomains AND the operascorecard.com → broadwayscorecard.com redirect chain). No separate operascorecard.com GSC property needed.

**Sitemap submission:** `PUT /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}` → HTTP 204.

**URL Inspection:** `POST /v1/urlInspection/index:inspect` with body `{inspectionUrl, siteUrl}` → returns coverageState, googleCanonical, lastCrawlTime.

**No public Indexing API for general URLs** — `indexing.googleapis.com` is restricted to JobPosting/BroadcastEvent structured data. Sitemap discovery (~1-7 days) is the programmatic path. UI "Request Indexing" button has ~10-12/day quota.

**Shell paste gotcha:** zsh wraps long URLs across lines, breaking the `--scopes` flag. Always wrap multi-scope gcloud commands in a script file (e.g. `/tmp/gsc-auth.sh`) and run `bash /tmp/gsc-auth.sh`.
