---
name: TB uses CamelCase URL slugs
description: "Talkin' Broadway uses CamelCase slugs (MeteorShower2017); try 4 variants."
type: feedback
archived: true
---

Talkin' Broadway URLs use CamelCase slugs with lowercase articles in middle position: `MeteorShower2017.html`, `OnceUponaOneMoreTime.html`, `ADollsHouse.html`. Year format varies (4-digit, 2-digit, or omitted). Roman numerals stay uppercase (`KingCharlesIII`).

**Why:** The poller was generating all-lowercase slugs (`meteorshower2017`), which never matched TB's actual URLs. Every TB URL construction was wrong.

**How to apply:** When constructing TB URLs, use the CamelCase generator in `opening-night-poller.js` (lines ~278-290). Try 4 variants: CamelCase+4yr, CamelCase+2yr, CamelCase (no year), lowercase+4yr. Be careful with Roman numeral detection — use strict pattern, not broad character class (words like "Did", "Ill" are not Roman numerals).
