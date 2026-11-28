---
name: feedback_public_reachability_needs_external_vantage
description: A curl from the host never proves a URL is publicly reachable — split-horizon DNS resolves it internally; use dig @8.8.8.8 plus curl --resolve and a third-party fetcher
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5d3ef1b1-4a27-49cc-92aa-993b1ad8f54f
  modified: 2026-08-15T12:56:04.791Z
---

`curl https://host/endpoint` run **on the machine that serves it** proves nothing
about whether the internet can reach it. Three consecutive sessions (2026-08-13
to 2026-08-15) reported "the endpoint is live, POST returns 401, so webhooks are
arriving" for a Tailscale Funnel URL. Every one of those curls resolved to the
**tailnet** address `100.100.178.115` via the local resolver, while
`dig @8.8.8.8` returned the public ingress IPs — which accepted TCP and then
dropped the TLS handshake. The endpoint had never been publicly reachable, and
the wrong root cause (webhook path) survived two full sessions because of it.

**Why:** MagicDNS, `/etc/hosts`, VPN split-horizon DNS, and container networks
all resolve the same hostname differently inside and outside the host. A
same-host curl tests the inside path exclusively.

**How to apply:** before claiming any URL is publicly reachable — a tunnel, a
webhook receiver, a newly deployed function — prove it from outside:
1. `dig +short @8.8.8.8 <host>` and compare against the local resolver. Different
   answers mean your local curl was never the public path.
2. `curl --resolve <host>:443:<public-ip> https://<host>/...` to force the public
   route.
3. Confirm with a vantage that isn't this machine at all (`r.jina.ai/<url>`,
   `api.codetabs.com/v1/proxy?quest=<url>`, ScrapingBee).
Agreement across at least two external vantages is the bar. A 401/403 from
outside is good news (something is listening and authenticating); HTTP `000` or
a TLS handshake that dies after ClientHello means nothing is routing to you.

Related: [[feedback_prod_curl_vercel_checkpoint]],
[[feedback_live_api_contract_test]], [[feedback_verify_bug_claim_before_fixing]].
