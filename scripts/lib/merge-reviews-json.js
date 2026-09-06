'use strict';

// Array-of-reviews merge for data/reviews.json (BRO-76 follow-up, card #1834).
//
// Why this exists: reviews.json is the hottest multi-writer core-data file
// (20+ independently-scheduled workflows — rebuild-reviews, llm-ensemble-
// score, enrich-reviews-${run_id} x4/day, etc.), registered `status:
// 'deferred'` in core-data-merge-registry.js at BRO-76 time specifically
// because it is ALSO the central scoring-pipeline file (CLAUDE.md §3/§12) —
// a wrong array-union merge risks silent scoring corruption across the whole
// site, not just one file.
//
// scripts/rebuild-all-reviews.js is the primary writer of reviews.json — it
// fully REGENERATES the reviews array from whatever review-texts corpus is
// on disk at that moment, and every other script/workflow that touches a
// review only edits an individual data/review-texts/{showId}/*.json file
// and then triggers a rebuild. There is one deliberate exception:
// manual-review-direct.js edits reviews.json directly (clones the private
// core-data repo, patches or appends one record, commits, `git push origin
// main`) — bypassing push-core-data/action.yml entirely, so it gets neither
// this reconciliation nor action.yml's retry loop on ITS OWN push. It still
// interacts with this merge whenever a push-core-data job's rebase lands on
// top of (or gets rebased against) whatever manual-review-direct.js last
// committed — at that point this merge sees it as an ordinary `remote` (or
// `ours`) snapshot like any other. Notably it never stamps `_meta.lastUpdated`
// (verified: grep of the script, 2026-08-20), which is why manualEntry
// priority below is checked BEFORE the snapshot-recency signal — a manual
// correction sitting under a stale timestamp must never lose to a routine
// rebuild just because the rebuild's _meta looks newer.
//
// Note on "wrongProduction/isNonReview" flag preservation (BRO-76 follow-up
// card language): those flags live on data/review-texts/{showId}/*.json
// files and gate EXCLUSION from reviews.json upstream, inside
// rebuild-all-reviews.js's per-file loop — a flagged review never reaches
// this array, so there is no such field on a reviews.json record to
// preserve here (verified: grep of the field-name set across the full
// 19.9k-review corpus, 2026-08-20). The actual manual-correction signal
// THIS file carries is `manualEntry: true` (manual-review-direct.js /
// scripts/lib/manual-entry-merge.js) — a human correction written straight
// into reviews.json, which rebuild-all-reviews.js's own merge pass already
// re-preserves every single run precisely because the pipeline would
// otherwise regenerate over it. This merge gives it the same priority: a
// manualEntry review always wins a same-key conflict against a non-manual
// twin.
//
// Merge rules:
//   * shape: { _meta, reviews: [...] }
//   * identity: showId + outlet(lower/trim) + criticKey(criticName) — reuses
//     manual-entry-merge.js's criticKey() (punctuation/diacritic-insensitive)
//     rather than a plain lower/trim key (rebuild's own pass-2 dedup key),
//     because manual-entry-merge.js exists specifically to bridge byline
//     text drift between a human correction and the pipeline's scrape
//     ("R. Scott Reedy" vs "R Scott Reedy", confirmed live on
//     wonder-regional-2026) — a weaker key would treat both sides of exactly
//     that conflict as disjoint and union them into a visible duplicate-
//     critic scoring input instead of resolving the conflict. Verified
//     collision-free across the full production corpus (19,903 reviews).
//   * manual-entry URL rescue (separate, narrower pass, run AFTER the
//     primary-key merge below): a manualEntry review can also disagree with
//     its pipeline twin by an outright byline SWAP, not just formatting
//     drift (confirmed live on iceboy-regional-2026 — "Chris Jones" vs
//     "Christopher Borrelli" on the same Chicago Tribune URL), which the
//     primary key alone cannot catch. manual-entry-merge.js's fallback for
//     this is a same-showId+URL match — but that fallback is NOT safe to
//     apply as a blanket identity rule the way the primary key is: the live
//     corpus has 7 legitimate same-show, same-URL, DIFFERENT-critic pairs
//     with no manualEntry involved at all (e.g. anastasia-2017's WSJ review
//     carries both Charles Isherwood and Edward Rothstein under the same
//     URL — co-bylined or corpus artifact, but genuinely two distinct
//     records, not a duplicate to collapse). So the URL match is scoped
//     narrowly: only rescues a pair where at least one side is
//     `manualEntry: true`, applied once over the already-merged output
//     (see the pass below) rather than during identity matching itself.
//   * disjoint identities (present on only one side): union — both sides'
//     additions survive. Safe by the same reasoning as mergeDiaryShows:
//     every writer only adds/updates review-texts files (or, for
//     manual-review-direct.js, a single record) and reruns a full rebuild;
//     nothing here deletes a review-texts file mid-race, so an identity
//     missing from one side is virtually always that side's rebuild
//     predating the other writer's newly-collected review, not an
//     intentional drop.
//     KNOWN LIMITATION (mirrors mergeDiaryShows' field-update limitation):
//     if a review was excluded from ours' rebuild by a flag applied to its
//     review-texts file moments before this run (wrongProduction, etc.), or
//     its review-texts file was deleted outright (e.g.
//     scripts/delete-stub-candidates.js), while remote's older snapshot
//     still carries the pre-exclusion entry, the union could resurrect it.
//     reviews.json carries no flag/tombstone data itself to detect this from
//     the snapshot alone, and this reconciler's private-core-data checkout
//     does not carry review-texts (a separate private repo) to cross-check
//     against — there is no cheap, safe way to close this from inside this
//     merge without also risking dropping a legitimate concurrent addition.
//     NOT strictly bounded to "one push cycle": if the excluding side keeps
//     losing pushes to an older snapshot, the resurrection can recur each
//     time until an uncontended rebuild finally lands. It IS bounded by
//     "eventually corrected by the next rebuild that isn't racing," and is
//     STRICTLY SAFER than the pre-existing status quo this replaces
//     (unconditional `-X ours`), which had no bound at all: it could
//     permanently drop either side's genuine additions depending purely on
//     which push won the race.
//   * same-identity conflict, in order:
//       1. manualEntry wins over non-manual (both manual → keep ours,
//          deterministic, matches the rebase's own `-X ours` default).
//       2. Otherwise, whichever whole SNAPSHOT's `_meta.lastUpdated` is
//          newer wins its version of the record. This is a full-rebuild
//          file: `_meta.lastUpdated` is stamped fresh by rebuild-all-
//          reviews.js on every run and reflects "as of this timestamp, this
//          is the complete, current state of every field for every review,
//          derived from the review-texts corpus at that moment" — a
//          causally meaningful signal for which SIDE more recently observed
//          the shared record (rescored, requoted, retiered, …), unlike a
//          per-field heuristic (contentTier, publishDate) that has no
//          relationship to which side's assignedScore is fresher.
//       3. Timestamps tied or unparseable on either side (rare — e.g. a
//          first-ever write, or a manual-vs-manual tie already resolved
//          above) → fall back to higher contentTier rank (complete >
//          truncated > excerpt > stub > invalid > untiered); else ours.
//   * _meta: newer lastUpdated wins (whole object, so its stats travel
//     together); totalReviews is corrected afterward to the actual merged
//     count, since the two sides' totalReviews almost never equals the
//     union's length.

const { canonicalizeUrlForDedup } = require('./review-guards');
const { criticKey } = require('./manual-entry-merge');
const { isPlaceholderByline } = require('./placeholder-byline');

const TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, stub: 2, invalid: 1 };

function tierRank(review) {
  return TIER_RANK[review && review.contentTier] || 0;
}

function keyOf(review) {
  if (!review || typeof review !== 'object' || !review.showId) return null;
  const outlet = String(review.outlet || 'unknown').toLowerCase().trim();
  return `${review.showId}|${outlet}|${criticKey(review.criticName)}`;
}

/** showId + canonicalized-URL identity — the fallback match manual-entry-merge.js
 * uses when the primary (outlet+critic) key disagrees across a byline swap. */
function urlKeyOf(review) {
  if (!review || typeof review !== 'object' || !review.showId || !review.url) return null;
  try {
    const canonical = canonicalizeUrlForDedup(review.url);
    return canonical ? `${review.showId}|url:${canonical}` : null;
  } catch {
    return null;
  }
}

/** Is this criticName the pipeline's no-byline sentinel rather than a person?
 * rebuild-all-reviews.js and review-file-writer.js both normalise a missing
 * byline to the literal string 'Unknown' (review-file-writer.js:707,
 * `sanitizeCriticName(input.criticName) || 'Unknown'`), and null/'' reach
 * reviews.json from older rows written before that default existed. Deliberately
 * an exact match on the sentinel, NOT a fuzzy "looks anonymous" test: a real
 * byline such as "Unknown Theatre Collective" must stay a distinct identity. */
function isUnknownByline(criticName) {
  if (criticName === null || criticName === undefined) return true;
  const s = String(criticName).trim();
  return s === '' || s.toLowerCase() === 'unknown';
}

function newerIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/** Which whole snapshot's _meta.lastUpdated is newer: true (ours), false
 * (remote), or null (tied / unparseable on either side). */
function snapshotIsNewer(ours, remote) {
  const ta = Date.parse((ours && ours._meta && ours._meta.lastUpdated) || '');
  const tb = Date.parse((remote && remote._meta && remote._meta.lastUpdated) || '');
  if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return null;
  return ta > tb;
}

/** Resolve a same-identity conflict. Returns 'ours' | 'remote'.
 * @param {boolean|null} oursSnapshotNewer precomputed snapshotIsNewer(ours, remote) result */
function resolveConflict(ours, remote, oursSnapshotNewer = null) {
  const oursManual = ours.manualEntry === true;
  const remoteManual = remote.manualEntry === true;
  if (oursManual !== remoteManual) return oursManual ? 'ours' : 'remote';
  if (oursManual && remoteManual) return 'ours';

  if (oursSnapshotNewer === true) return 'ours';
  if (oursSnapshotNewer === false) return 'remote';

  const oursTier = tierRank(ours);
  const remoteTier = tierRank(remote);
  if (oursTier !== remoteTier) return oursTier > remoteTier ? 'ours' : 'remote';

  return 'ours';
}

function mergeReviewsJson(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { reviews: [] };
  remote = remote && typeof remote === 'object' ? remote : { reviews: [] };
  const oursReviews = Array.isArray(ours.reviews) ? ours.reviews : [];
  const remoteReviews = Array.isArray(remote.reviews) ? remote.reviews : [];

  // First occurrence per PRIMARY key wins on EACH side independently before
  // cross-side matching runs — without this, two same-key duplicates on ONE
  // side (e.g. "R. Scott Reedy" and "R Scott Reedy" both surviving one
  // side's rebuild un-deduped, which criticKey's stronger normalization
  // treats as one identity even though rebuild's own weaker dedup key did
  // not) would each independently "consume" the other side's single
  // matching record, so the second consumer's conflict silently wins and
  // the FIRST one's resolution — and the fact that anything was ever
  // ambiguous — evaporates with no count anywhere. Deliberately
  // primary-key-only, not URL-based, on both sides — see the manual-entry
  // URL rescue note below for why a same-URL rule can't safely apply here
  // unscoped.
  // On a same-side collision, a manualEntry record beats a non-manual one
  // regardless of array order — rebuild-all-reviews.js's own mergeManualEntries
  // already guarantees a well-formed rebuild output never carries BOTH a
  // manual correction and its non-manual pipeline twin at the same identity
  // (it replaces the twin in place), but a side reconciling here isn't
  // guaranteed to be a fresh rebuild output — e.g. manual-review-direct.js
  // writes a manual record directly and may not find-and-replace its
  // pipeline twin if its own matching used a different key. Blind
  // first-occurrence-wins would silently discard the manual correction
  // whenever the non-manual twin happens to appear first in the array
  // (Codex adversarial finding, reproduced directly against this code).
  function dedupeByKey(reviews) {
    const byKey = new Map();
    const keyless = [];
    let duplicateKeysSkipped = 0;
    for (const r of reviews) {
      const k = keyOf(r);
      if (!k) {
        keyless.push(r);
        continue;
      }
      if (!byKey.has(k)) {
        byKey.set(k, r);
        continue;
      }
      duplicateKeysSkipped++;
      const existing = byKey.get(k);
      if (r && r.manualEntry === true && !(existing && existing.manualEntry === true)) {
        byKey.set(k, r);
      }
    }
    return { byKey, canonical: [...byKey.values(), ...keyless], duplicateKeysSkipped };
  }

  const oursDeduped = dedupeByKey(oursReviews);
  const remoteDeduped = dedupeByKey(remoteReviews);

  const oursSnapshotNewer = snapshotIsNewer(ours, remote);
  const consumedRemote = new Set();
  const mergedReviews = [];
  let conflicts = 0;
  let conflictsResolvedToRemote = 0;

  for (const r of oursDeduped.canonical) {
    const k = keyOf(r);
    const remoteMatch = k ? remoteDeduped.byKey.get(k) : null;
    if (!remoteMatch) {
      mergedReviews.push(r);
      continue;
    }
    consumedRemote.add(remoteMatch);
    conflicts++;
    if (resolveConflict(r, remoteMatch, oursSnapshotNewer) === 'remote') {
      mergedReviews.push(remoteMatch);
      conflictsResolvedToRemote++;
    } else {
      mergedReviews.push(r);
    }
  }

  let added = 0;
  for (const r of remoteDeduped.canonical) {
    if (consumedRemote.has(r)) continue; // already handled above (kept or conflict-resolved)
    // Remote-only entry — union it in so the race doesn't drop the other
    // writer's addition. See KNOWN LIMITATION in the module comment above.
    mergedReviews.push(r);
    added++;
  }

  // Manual-entry URL rescue (see module comment): after the primary-key
  // merge above, a manualEntry review may still sit alongside a SEPARATE
  // record for the exact same article — either a non-manual pipeline twin
  // (byline SWAP, not just formatting drift — the primary key legitimately
  // treated them as different identities) or, more rarely, a SECOND
  // manualEntry record (two independent human corrections to the same
  // article, e.g. via concurrent manual-review-direct.js runs, that landed
  // with different critic names and therefore different primary keys).
  // Scoped to pairs involving at least one manualEntry record — a bare
  // same-URL rule is unsafe in general (7 legitimate same-URL/
  // different-critic pairs exist in the live corpus with no manual entry
  // involved — see module comment). First-registered manual record per URL
  // wins (mergedReviews is ours-derived entries first, then remote-only
  // additions, so this prefers ours on an ours-vs-remote manual/manual tie
  // — consistent with resolveConflict's "both manual → ours" rule above).
  let urlRescueConflicts = 0;
  const manualUrlIndex = new Map();
  for (const r of mergedReviews) {
    if (r && r.manualEntry === true) {
      const uk = urlKeyOf(r);
      if (uk && !manualUrlIndex.has(uk)) manualUrlIndex.set(uk, r);
    }
  }
  if (manualUrlIndex.size) {
    for (let i = mergedReviews.length - 1; i >= 0; i--) {
      const r = mergedReviews[i];
      if (!r) continue;
      const uk = urlKeyOf(r);
      const twin = uk && manualUrlIndex.get(uk);
      if (twin && twin !== r) {
        mergedReviews.splice(i, 1); // the earlier-registered manual twin wins
        urlRescueConflicts++;
      }
    }
  }

  // Unknown-byline fossil rescue (BRO-2916). A THIRD narrow pass, same shape as
  // the manual-entry rescue above but keyed on the no-byline sentinel instead of
  // manualEntry. Every row in reviews.json is 1:1 with a review-texts file by
  // construction — rebuild-all-reviews.js emits exactly one row per included
  // file — so a second row for the same showId+URL can only have been minted by
  // this merge: the clean side is OURS and the fossil is the REMOTE-only
  // addition that the disjoint-identity union faithfully preserves.
  //
  // It is NOT permanent, and an earlier draft of this comment wrongly said it
  // was. An UNCONTENDED rebuild does clear it — measured: the live
  // into-the-woods-west-end-2025 Radio Times fossil was gone from reviews.json
  // after the 2026-09-06T09:45:46Z rebuild, leaving one bylined row. That
  // matches the union's KNOWN LIMITATION note above, which already says the
  // resurrection is "bounded by eventually corrected by the next rebuild that
  // isn't racing". What this pass buys is the interval: while pushes keep
  // racing, the fossil is re-minted on every contended merge, and Data
  // Validation reds main for the whole window — which is how it managed to red
  // two consecutive runs before anyone looked.
  //
  // How the fossil is born: a review is first collected without a byline and
  // written as criticName 'Unknown'; a later pass resolves the real byline. The
  // primary key is showId|outlet|criticKey(criticName), so 'Unknown' and
  // 'Olivia Garrett' are DIFFERENT identities for the same article and union
  // rather than conflict. validate-data.js then errors with
  // "duplicate URL(s) within same show+outlet" and Data Validation reds main on
  // every subsequent run, for a reason unrelated to whatever that run changed.
  //
  // Safe where a bare same-URL rule is not (the same-URL/different-critic pairs
  // the module comment describes, e.g. anastasia-2017's WSJ row carrying both
  // Charles Isherwood and Edward Rothstein): this drops a row ONLY when its own
  // byline is the sentinel and some other row for the same showId+URL carries a
  // real one. Both sides of every legitimate pair are real bylines, so none of
  // them is reachable.
  //
  // Measured 2026-09-06 against the live corpus, using urlKeyOf and
  // isUnknownByline themselves rather than a hand-rolled probe: 7 same-showId+URL
  // groups carry more than one DISTINCT critic. 1 is this fossil shape
  // (into-the-woods-west-end-2025, Radio Times, "Olivia Garrett" vs "Unknown");
  // 6 are two-real-byline pairs this pass cannot touch; 0 involve a manualEntry.
  // Note for whoever reads the module comment above next: its "7 legitimate
  // pairs" figure is that same group count as it stood on 2026-08-20, so the
  // legitimate subset is 6 today — the 7th is the fossil this pass removes.
  // A manualEntry row is NEVER dropped here, even when its own byline is the
  // sentinel. DEFENCE IN DEPTH, not a live bug fix — be precise about which,
  // because a guard whose comment overclaims is the same defect as a test that
  // asserts less than its name. An adversarial review (gpt-5.4-mini) raised
  // this as a P0: "a manualEntry row with criticName 'Unknown' would be dropped
  // here, defeating the manualEntry priority the module guarantees". Checked
  // rather than taken on trust, and it is NOT reachable today: the manual-entry
  // rescue immediately above registers each manual row's urlKeyOf and then
  // splices EVERY other row sharing that key, so by the time this pass runs a
  // manualEntry row provably has no same-urlKey sibling and can never match.
  // Verified directly: merging a bylined row against a manual sentinel-byline
  // row on one URL returns 1 row (the manual one) with urlRescueConflicts 1 and
  // unknownBylineFossilsDropped 0. The guard stays because it costs one boolean
  // and it is what stops a future reordering of these two passes from silently
  // deleting human corrections — the failure it prevents is a refactor's, not
  // today's.
  // SECOND CONDITION, beyond the shared canonical key: the two rows must also
  // agree on the raw URL PATH, compared case-sensitively. Adversarial-review
  // finding (Codex): canonicalizeUrlForDedup lowercases the WHOLE url, so on a
  // host with case-sensitive paths two genuinely different articles can collapse
  // to one canonical key, and this pass would then delete a real unbylined
  // review. Measured on the live corpus: canonicalization merges distinct raw
  // URLs in exactly 2 groups, and both are the same article differing only by
  // tracking parameters (a WSJ `gaa_*` set, an NYT `?_r=1&`) — so the risk is
  // real in principle and absent in fact today. Requiring identical raw paths
  // keeps the tracking-parameter cases working (their paths are byte-identical)
  // while making a case-only or query-only path collapse unable to authorise a
  // deletion. Deleting derived rows deserves the stricter of two available
  // tests, not the more convenient one.
  const rawPathOf = (u) => {
    try {
      const parsed = new URL(String(u));
      return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };

  let unknownBylineFossilsDropped = 0;
  // Provenance, not just a tally. A pass that DELETES rows must leave enough
  // behind to answer "what went missing and why" without digging through
  // history (adversarial-review finding, Codex: the first version recorded only
  // a count, so a wrong deletion was undiagnosable from the merge result).
  const unknownBylineFossilsDroppedKeys = [];
  // What may ANCHOR a deletion is deliberately stricter than what may BE
  // deleted. Widening the deleted side would remove more rows; narrowing the
  // anchor side only ever removes fewer, so the asymmetry is the safe direction.
  // Three ways a name fails to be a real byline, and isUnknownByline alone
  // catches only the first (codebase-review finding, Claude):
  //   - the sentinel itself;
  //   - placeholder-byline.js's GENERIC_BYLINE_TERMS ('staff', 'news desk',
  //     'editorial team', …) — that module is the repo's canonical predicate
  //     for this same-URL duplicate class (card #1907), so reuse it rather than
  //     grow a second, quietly divergent definition here (CLAUDE.md §15);
  //   - punctuation-only junk. criticKey('—') is 'unknown' while
  //     isUnknownByline('—') is false, so without this a junk em-dash row would
  //     have counted as a real byline and taken out a genuine sentinel row.
  //   - and the outlet's OWN NAME standing in for the critic. That is the very
  //     case placeholder-byline.js was written for ("extraction fell back to
  //     the outlet's own name"), but it is only reachable when the `outlet`
  //     argument is actually supplied — called with the name alone, the
  //     `norm === normOutlet` branch can never fire, so a record whose
  //     criticName is literally its outlet ("Radio Times" at Radio Times)
  //     counted as a real byline and could anchor the deletion of a genuine
  //     sentinel row at that outlet. Passing `outlet` narrows the ANCHOR side,
  //     which by the asymmetry noted above only ever deletes FEWER rows.
  //     `opts.defaultCritic` is deliberately NOT resolved here: this module is
  //     a merge driver wired into core-data-merge-registry.js:639 with a fixed
  //     (ours, remote) signature and no I/O of its own, and reading
  //     outlet-registry.json would break that purity. The cost is bounded and
  //     one-directional — at an outlet named after its own sole critic
  //     (placeholder-byline.js:52-61) that critic reads as a placeholder, so
  //     the pass declines to anchor. That is safe against DELETION, not
  //     against the duplicate gate: such a pair can then survive to
  //     validate-data.js:2081 as a same-show+outlet duplicate URL, which is
  //     loud and self-clearing on the next uncontended rebuild, unlike a
  //     wrongly deleted review. scripts/dedupe-same-url-bylines.js:237 is the
  //     caller that CAN afford the registry lookup and does pass defaultCritic.
  const isRealByline = (rec) => {
    const name = rec && rec.criticName;
    return !isUnknownByline(name)
      && !isPlaceholderByline(name, rec && rec.outlet)
      && criticKey(name) !== 'unknown';
  };

  const bylinedByUrlKey = new Map();
  for (const r of mergedReviews) {
    if (!r || !isRealByline(r)) continue;
    const uk = urlKeyOf(r);
    if (!uk) continue;
    if (!bylinedByUrlKey.has(uk)) bylinedByUrlKey.set(uk, []);
    bylinedByUrlKey.get(uk).push(r);
  }
  if (bylinedByUrlKey.size) {
    for (let i = mergedReviews.length - 1; i >= 0; i--) {
      const r = mergedReviews[i];
      if (!r || r.manualEntry === true || !isUnknownByline(r.criticName)) continue;
      const uk = urlKeyOf(r);
      if (!uk) continue;
      const candidates = bylinedByUrlKey.get(uk);
      if (!candidates) continue;
      const myPath = rawPathOf(r.url);
      // Only a candidate on the SAME raw path may win, and it must not be
      // poorer than the row it replaces. Every other resolution path in this
      // module falls back to tierRank when it has to choose (see
      // resolveConflict); preferring a byline unconditionally would let a
      // bylined `stub` evict a sentinel `complete` and lose the richer text and
      // its score until the next uncontended rebuild (codebase-review finding,
      // Claude — the original tests only exercised the favourable direction).
      // A tie still deletes: same tier, and the bylined row is the better
      // attributed of the two.
      // SAME OUTLET, too. urlKeyOf deliberately carries no outlet, and the
      // source writer documents that aggregator roundup URLs are legitimately
      // shared ACROSS outlets — so on URL alone a named Guardian row and a
      // genuinely unbylined FT row backed by one roundup page would collapse
      // into one, silently removing an outlet from the show's composite
      // (adversarial-review finding, Codex). Scoping to one outlet also makes
      // this pass exactly as wide as the defect it exists for: validate-data.js
      // reports "duplicate URL(s) within same show+outlet", not across outlets.
      const myOutlet = String(r.outlet || '').toLowerCase().trim();
      const winner = myPath && candidates.find(
        (c) => rawPathOf(c.url) === myPath
          && String(c.outlet || '').toLowerCase().trim() === myOutlet
          && tierRank(c) >= tierRank(r),
      );
      if (!winner) continue; // different outlet or raw path, or no candidate at least as rich — not safe to delete
      mergedReviews.splice(i, 1); // the bylined row is the real review
      unknownBylineFossilsDropped++;
      unknownBylineFossilsDroppedKeys.push({
        showId: r.showId,
        outlet: r.outlet,
        url: r.url,
        supersededBy: winner.criticName,
      });
    }
  }

  const merged = { ...ours, reviews: mergedReviews };
  const oursLu = ours._meta && ours._meta.lastUpdated;
  const remoteLu = remote._meta && remote._meta.lastUpdated;
  const lu = newerIso(oursLu, remoteLu);
  // baseMeta must track whichever side's lastUpdated actually ended up as
  // `lu`, so stats and lastUpdated never come from different sides. Cannot
  // reuse oursSnapshotNewer here: it returns null both on an exact tie AND
  // whenever EITHER side is unparseable, but newerIso only falls back to
  // the other side when the CURRENT side specifically is unparseable — so
  // "ours unparseable, remote valid" made oursSnapshotNewer null (→ baseMeta
  // defaulted to ours) while lu still carried remote's value, mismatched
  // (Codex adversarial finding, reproduced directly against this code).
  // Comparing lu against each raw value directly ties toward ours in every
  // case newerIso does (exact tie, or both sides unparseable).
  const baseMeta = (lu === remoteLu && lu !== oursLu && remote._meta) || ours._meta || remote._meta || {};
  merged._meta = { ...baseMeta, ...(lu ? { lastUpdated: lu } : {}) };
  if (merged._meta.stats && typeof merged._meta.stats === 'object') {
    merged._meta.stats = { ...merged._meta.stats, totalReviews: mergedReviews.length };
  }

  return {
    merged,
    stats: {
      added,
      conflicts,
      conflictsResolvedToRemote,
      oursDuplicateKeysSkipped: oursDeduped.duplicateKeysSkipped,
      remoteDuplicateKeysSkipped: remoteDeduped.duplicateKeysSkipped,
      urlRescueConflicts,
      unknownBylineFossilsDropped,
      unknownBylineFossilsDroppedKeys,
      totalReviews: mergedReviews.length,
    },
  };
}

module.exports = { mergeReviewsJson, keyOf, urlKeyOf, resolveConflict, snapshotIsNewer, tierRank, isUnknownByline };
