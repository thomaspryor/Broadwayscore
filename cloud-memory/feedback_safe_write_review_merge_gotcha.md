---
name: safeWriteReview merge silently restores deleted fields
description: delete fresh.field followed by safeWriteReview keeps the field — the merge step re-adds anything not in newData from disk. Use null instead.
type: feedback
originSessionId: 19e9a4c9-6a48-4941-b7c5-5933c15eb760
archived: true
---
`safeWriteReview(filePath, data)` defaults to `merge: true` and at line 202-208
of `scripts/lib/review-write-guard.js` does:

```js
if (merge) {
  for (const [key, val] of Object.entries(existing)) {
    if (newData[key] === undefined) newData[key] = val;
  }
}
```

It re-reads the file off disk and merges in any field that is `undefined`
in your in-memory `newData`. So:

```js
const fresh = JSON.parse(fs.readFileSync(p, 'utf8'));
delete fresh.nonReviewType;            // marks it undefined
safeWriteReview(p, fresh);             // merge re-adds it from disk
```

silently puts the field back. There is no warning.

**Why:** the merge step is there to protect against narrow patches that
forget to repeat untouched fields. But it also defeats explicit deletes.

**How to apply:**
- To remove a field via safeWriteReview, set it to `null` (or another
  sentinel), don't `delete`. Schema-wise null counts as "present".
- If a downstream consumer can't handle null, pass `{ merge: false }`
  — but that requires you to include every field you want to preserve,
  including the entire PROTECTED_FIELDS set.
- Hit during the isNonReview reclassify-audit sweep on 2026-04-26
  (Notion 34e637c5-416f-8144). The sweep ran twice — first pass appeared
  to clear 13 flags but `nonReviewType` survived; second pass with `null`
  succeeded.
