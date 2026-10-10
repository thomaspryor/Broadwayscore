---
name: rss-discovery titleMatchesShow has latent curly-apostrophe bug
description: scripts/lib/rss-discovery.js line 188 normalize regex `/['']/g` looks like curly→ASCII fold but the chars between the brackets are both U+0027 (verified via xxd). Headlines containing &#8217; / U+2019 don't fold and word-boundary match fails.
type: feedback
originSessionId: daa181c6-4a0a-48e5-b11b-3b74229ebe61
archived: true
---
`scripts/lib/rss-discovery.js`, around line 188:

```js
const normalize = t => t.toLowerCase().replace(/['']/g, "'").replace(/[^a-z0-9' ]/g, '').trim();
```

This LOOKS like it folds curly quotes (U+2018/U+2019) → ASCII U+0027, but the bytes between the brackets are both U+0027 (verified 2026-04-29 via `xxd`). So curly apostrophes survive normalize, then get stripped by the second regex (apostrophe is in the allowed class, but only ASCII U+0027). Net effect: any headline with `&#8217;` (e.g. TheaterMania's "Joe Turner&#8217;s Come and Gone") fails titleMatchesShow against a show title with U+0027.

**Why:** Caught while building TM/OMC discovery libs (Parallel Session 3, 2026-04-29). My libs work around it by folding curly→ASCII in their own decodeEntities helpers (`scripts/lib/theatermania-discovery.js`, `scripts/lib/omc-discovery.js`).

**How to apply:**
- If you build a new discovery lib that calls titleMatchesShow, fold curly punctuation to ASCII BEFORE calling. Reference: theatermania-discovery.js's decodeEntities replaces &#8216;/&#8217;/U+2018/U+2019 with U+0027.
- Don't "just fix" rss-discovery.js line 188 without auditing — 13+ feeds in ALL_FEEDS use this normalize. Some may rely on the broken behavior (curly apostrophes act as word-separators, not in-word characters). Validate against the corpus before flipping.
- The right fix is a corpus probe: how many existing matches would CHANGE (gain or lose) if curly→ASCII folded? Sample 25 newly-matching headlines and verify they're correct.

Filed under "things you'll regret 'cleaning up' without verifying."
