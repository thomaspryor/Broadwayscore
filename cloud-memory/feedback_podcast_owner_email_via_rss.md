---
name: feedback_podcast_owner_email_via_rss
description: "Public podcasts almost always expose owner email in the RSS feed via <itunes:owner> — check the feed before declaring \"no email found\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8bf5bc2b-a780-4506-b042-c4b66363ba85
---

When asked to find contact email for a podcaster, **fetch the show's RSS feed first** — Apple Podcasts requires `<itunes:owner><itunes:email>` to be populated, and this propagates to every podcast directory. Most podcast Substacks/sites publish the RSS at `/feed`.

**Why:** Found Matt Koplik (Broadway Breakdown) at `bwaybreakdown@gmail.com` via `curl bwaybreakdown.substack.com/feed | grep itunes:email` in 30 seconds — after wasting two web searches and three WebFetch calls on Substack About / BPN profile / Listen Notes that all said "no email listed." The RSS feed had it the whole time.

**How to apply:** Before recommending Substack DM / Instagram / Discord as the only contact channel:

```bash
curl -sL "https://PODCAST-DOMAIN/feed" --max-time 10 \
  | grep -oE "[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" | sort -u
```

Also works on Apple Podcasts feed URLs (lookup via iTunes Search API) and any podcast hosted on Buzzsprout/Anchor/Spreaker/Libsyn. Owner email is mandatory metadata.

**Limit:** Won't work for shows that use a podcast-network feed (BPN, Earwolf) — those use the network's email. Try the show's own site first.
