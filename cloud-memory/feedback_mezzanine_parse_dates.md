---
name: Mezzanine Parse date objects
description: Mezzanine API openedAt is a Parse Date object, not a string; always extract .iso
type: feedback
originSessionId: 0f0d3e56-8294-4a70-bd77-dc0c7d00966d
archived: true
---
Mezzanine (theaterdiary.com) Parse API returns `openedAt` as `{__type:'Date', iso:'2022-09-17T04:00:00.000Z'}`, NOT as a plain string. The `diary-shows.json` fallback path writes plain ISO strings instead, so the field shape is inconsistent across records in `data/mezzanine-image-cache.json`.

**Why:** In April 2026 this caused 256 productions across 100+ titles (5 DoaS, 3 Sunset, 3 Beetlejuice, 5 Gypsy, etc.) to share the same image. The pre-fix code did `parseInt(String(p.openedAt).substring(0,4))` which returned NaN for Parse Date objects, killing the year-distance tiebreaker. Selection fell through to `isBroadway`/`ratingsCount` tiebreakers which are identical for all productions of one title — the first candidate in the cache won deterministically.

**How to apply:** Any code that reads Mezzanine records must handle both shapes. Use the `extractMezzYear()` helper in `scripts/fetch-show-images-auto.js` or equivalent:

```js
function extractMezzYear(openedAt) {
  if (!openedAt) return 0;
  if (typeof openedAt === 'object' && openedAt.iso) {
    return parseInt(String(openedAt.iso).substring(0, 4)) || 0;
  }
  if (typeof openedAt === 'string') {
    return parseInt(openedAt.substring(0, 4)) || 0;
  }
  return 0;
}
```

Also: when picking by year proximity, year distance must be the PRIMARY signal, not a tiebreaker. The original code put `isBroadway` first, which meant that when year parsing broke, the first Broadway candidate won for every production of a given title.

To detect regression of this class: `node scripts/audit-duplicate-images.js` — scans for byte-identical images across multi-production base groups. Run after any change to image-fetching code.
