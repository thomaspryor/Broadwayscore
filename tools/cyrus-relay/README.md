# Cyrus webhook relay

Linear can only deliver agent-session webhooks to a public URL. This Mac has no
usable inbound path, so nothing is exposed here: Linear POSTs to a small Vercel
project, and the Mac pulls the queue outbound.

    Linear ──POST──▶ https://cyrus-relay.vercel.app/api/linear-webhook
                        │  verifies linear-signature, encrypts, queues in Vercel Blob
                        ▼
                     Vercel Blob  (prefix q/, AES-256-GCM)
                        ▲
                        │  GET /api/drain  (Bearer CYRUS_RELAY_SECRET)
    Mac Studio ─────────┘
        └── scripts/cyrus-webhook-drain.js  ──POST──▶ http://127.0.0.1:3456/linear-webhook

## Why not a tunnel

- **Tailscale Funnel does not work here.** `toms-mac-studio.tailcc11.ts.net` is a
  node on the **classdojo.com** corporate tailnet. The funnel ingress
  (209.177.145.192/97) accepts TCP and then drops the TLS handshake — the node
  is never handed the connection, and its netmap `SelfNode.Hostinfo` carries no
  ingress flag. Verified unreachable from three independent external vantages.
  Beyond the breakage, exposing a public endpoint that runs Claude Code against
  a personal repo from an employer's tailnet is not something to route around.
- **Cloudflare named tunnels need a Cloudflare zone.** `broadwayscorecard.com`
  is on Vercel DNS (`ns1.vercel-dns.com`), and quick tunnels change hostname on
  every restart.

## Pieces

| Piece | Where |
| --- | --- |
| Relay functions | `tools/cyrus-relay/api/{linear-webhook,drain,health}.js` |
| Vercel project | `cyrus-relay` (team `thomaspryors-projects`), prod alias `cyrus-relay.vercel.app` |
| Queue storage | Vercel Blob store `cyrus-relay-queue` (`store_R127nbWWlYlJfDFd`) |
| Drain | `scripts/cyrus-webhook-drain.js`, launchd job `com.broadwayscore.cyrus-webhook-drain` |
| Secrets | `~/.cyrus/.env`: `CYRUS_RELAY_SECRET`, `LINEAR_WEBHOOK_SECRET` |

Deployment protection is **off** on this project — Linear must be able to POST
to it unauthenticated. Authenticity comes from the Linear signature, not from
Vercel's SSO gate.

## Operating it

    ./deploy.sh deploy              # redeploy the relay
    ./sync-webhook-secret.sh        # push ~/.cyrus/.env LINEAR_WEBHOOK_SECRET to Vercel
    node ../../scripts/cyrus-webhook-drain.js --once     # drain the queue once
    tail -f ~/.cyrus/webhook-drain.log                   # drain activity
    curl -s https://cyrus-relay.vercel.app/api/health    # relay sanity check

## Cyrus configuration this depends on

`~/.cyrus/.env` must contain:

    LINEAR_DIRECT_WEBHOOKS=true    # without it Cyrus runs in proxy mode and 401s
                                   # every real Linear delivery for want of a
                                   # bearer token Linear never sends
    WEBHOOK_IP_VALIDATION=false    # deliveries arrive from loopback, not Linear's IPs
    LINEAR_WEBHOOK_SECRET=...      # the OAuth app's webhook signing secret

`LINEAR_WEBHOOK_SECRET` must match the signing secret shown on the Cyrus OAuth
application page in Linear. To set it, use

    tools/cyrus-relay/apply-webhook-secret.sh <secret>

which rewrites `~/.cyrus/.env`, pushes the value to Vercel, redeploys the relay,
restarts Cyrus and round-trips a signed payload to prove both ends agree. Set it
by hand and the relay and Cyrus will disagree, and every delivery 401s.

`~/.cyrus/config.json` must leave the single repository entry with **no**
`routingLabels`, `teamKeys` or `projectKeys`. With any of them set, an issue that
does not carry the label falls through to "Which repository should I work in for
this issue?" and the session sits in `awaitingInput` — which reads exactly like
Cyrus being broken. With none of them set the repo becomes the workspace
catch-all and routes automatically (`RepositoryRouter.js:179-190`). Re-add them
only when a second repository is configured.
