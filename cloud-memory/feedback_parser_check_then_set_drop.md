---
name: Parser-based check-then-set is a silent-drop trap
description: "Parser before/after write = silent-drop trap; add raw-bytes fallback."
type: feedback
originSessionId: b3d048da-fea2-44a2-a75f-b167435ce8fc
archived: true
---
Check-then-set patterns that use the same parser for the "before" and "after" checks can silently drop data when the parser has a bug or hits an edge case. Always add a raw-bytes substring fallback or an independent verification path.

**Why:** On 2026-04-10 a post-ship code review on the email-worker Gmail label coordination (`~/.claude-email-worker/poll.py`) found this exact pattern. Flow was:

1. `before_labels = get_gmail_labels(msg)` — parse X-GM-LABELS
2. If label in before_labels → "lost race", skip
3. STORE +X-GM-LABELS label (idempotent, always succeeds)
4. `after_labels = get_gmail_labels(msg)` — parse again
5. If label NOT in after_labels → "verify failed", skip

The silent-drop bug: if the parser ever returned `[]` (edge case in the X-GM-LABELS regex — labels containing `)`, multi-line server responses, imaplib tuple framing), step 5 would conclude "label not stamped, abort" and `continue`. But step 3 already succeeded, so the label was on the message. That message was now invisible to all future polls (the search filter excludes labeled messages) but had never been processed. Permanent black hole, zero log output, undetectable without a separate audit.

**The fix pattern:** introduce a `has_X()` wrapper that tries the parser first and falls back to a raw-bytes substring search. The parser gives you nice semantics; the raw-bytes check makes sure a parser bug can never cause a false negative on "is it there?".

```python
def has_gmail_label(imap, msg_id, label):
    labels, raw = get_gmail_labels(imap, msg_id)  # returns (parsed, raw_text)
    if label in labels:
        return True
    # Substring fallback — catches parser misses
    if f'"{label}"' in raw:
        return True
    if re.search(rf'(?<![A-Za-z0-9_\-]){re.escape(label)}(?![A-Za-z0-9_\-])', raw):
        return True
    return False
```

Verified with 5 unit tests including synthetic parse-busted responses where the parser returns garbage but the substring fallback still finds the label. See `~/.claude-email-worker/poll.py` `has_gmail_label()` and `memory/email-worker-coordination.md` "parser-failure black hole" section for the worked example.

**How to apply:**
- Whenever you have a check-then-set pattern backed by a parser (IMAP labels, XML attributes, JSON fields where keys may collide, HTTP headers with unusual framing, etc.), ask: "if my parser returns empty, does the downstream code conclude 'not present' or 'unknown'?"
- If it concludes "not present" and the upstream write was already idempotent and succeeded, you have a silent-drop bug.
- Fix by adding a raw-bytes or independent-fetch fallback for presence checks.
- Watch for the inverse pattern too: parser that returns a value on failure (e.g., `get(...) or default`) can cause silent OVER-claim instead of silent drop.
- Word-boundary check in the substring fallback so `label` doesn't false-match `label-v2`.
