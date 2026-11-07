---
name: feedback_zero_mention_body_acceptance_too_leaky
description: Accepting a review body with ZERO show-title mentions (short-title case) is too leaky to ship; three ship-check passes each found a new false-accept class. Dropped it.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5069eb8a-8362-42e1-8109-2bc515299bd5
---

**Do NOT re-attempt "accept a 0-mention body for short titles" in
`validateContentMentionsShow` (scripts/lib/content-quality.js) without a
fundamentally stronger signal than <title> heuristics.** (2026-07-05)

Context: genuine reviews of one/two-word shows (Springwood @ Hampstead, etc.)
sometimes name the show ONLY in the headline and never in the body (0 mentions),
so they were dropped as `url_content_mismatch`. Tempting fix: extend the existing
long-title 0-mention acceptance (`titleLeadsWithShow`, gated to ≥4-word titles) to
short titles when the <title> leads with the show + body looks like a review.

Why it was DROPPED (not shipped): accepting a 0-mention body means the ONLY signal
that the page is the right show is the <title> + body-prose heuristics, and those
can always be gamed by an adjacent content type. Three adversarial ship-check passes
(Codex + Claude) each found a NEW false-accept class after the prior was patched:
1. Same-named FILM review ("Springwood", Ari Aster horror) — film prose hits the
   generic THEATER_KEYWORDS ('act','cast','scene','score' are film vocab).
2. Prefix collisions — raw startsWith let "Catskills" pass as "Cats", "Company of
   Wolves" pass as "Company"; bare `\bstars?\b` matched "X stars in...".
3. After fixing 1+2 (immediate review-marker-after-title, film/TV <title> exclusion,
   theatre-DISTINCTIVE body keyword): theatre LISTINGS pages ("Cats at Milton Keynes
   Theatre" + venue copy with 'matinee'/'interval') and filmed-theatre / NT-Live
   encore pages still passed.

The pattern (each patch reveals another leak) is the signal that the APPROACH is
wrong, not that one more marker is missing. 0-mention evidence is intrinsically weak.

Compounding: the target reviews (Springwood ArtsDesk/Standard/Theatrecat) ALSO hit
the no-byline strand (`--unknown`) and paywall — so even a recovered body is stranded
at the NEXT gate. Real-world yield ≈ 0 until the no-byline strand is fixed. See
[[feedback_pending_no_byline_strand_drain.md]].

What IS live and safe: the 1-mention relaxation (commit b200c24f83) — when the
<title> LEADS with the show and there is ≥1 body mention, drop the threshold to 1.
That fixed the real Sting/WhatsOnStage case (3706ch body, 1 mention). Requiring ≥1
mention is the floor that keeps the guard trustworthy.

If short-title 0-mention recovery is ever revisited, the only defensible signal is
OUT-OF-BAND: the discovery context already knows the outletId is a theatre-critic
outlet and the URL is a theatre-review URL — thread THAT into the guard, don't try to
re-derive "is this a theatre review of show X" from body text alone. Related:
[[feedback_content_quality_regex_fps.md]], [[feedback_url_content_mismatch_three_layers.md]].
