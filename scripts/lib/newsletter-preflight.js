// newsletter-preflight.js — pure decision logic for the newsletter pre-send
// image + review-completeness gates (task #823).
//
// Born 2026-08-02: the Sunday checker blessed a WE draft whose top hero card
// (Brainiac Live!) rendered the 🎭 no-image placeholder, and whose featured
// shows had uncollected reviews the aggregators already listed (Brainiac
// gaps=3, Traitors Live gaps=7 in gap-audit-checkpoint.json) — so the scores
// shown to subscribers were built on an incomplete review set. Both are
// mechanical facts the checker can gate on; the owner should never be the one
// catching them.
//
// Everything here is pure (I/O injected) so pre-send-check.mjs and the tests
// exercise the same functions (CLAUDE.md §15).

'use strict';

const SITE_PREFIX = 'https://broadwayscorecard.com/';

// Featured opening shows with no image at all (generate.mjs getImage() → null
// renders the 🎭 placeholder div — invisible to an HTML img-src scan).
function missingImageViolations(openingShows) {
  const out = [];
  for (const s of openingShows || []) {
    if (!s || s.image) continue;
    out.push(`Featured opening "${s.title}" (${s.id}) has NO show image — its card renders the 🎭 placeholder. Add images.thumbnail (fetch-show-images) and re-run refresh-drafts.sh.`);
  }
  return out;
}

// Map a broadwayscorecard.com image URL to its repo-relative public/ path.
// Returns null for non-site URLs (nothing local to verify).
function localPathForImageUrl(url) {
  if (!url || !url.startsWith(SITE_PREFIX)) return null;
  const rel = url.slice(SITE_PREFIX.length).split('?')[0];
  return rel ? 'public/' + decodeURIComponent(rel) : null;
}

// Featured shows whose image metadata points at a file that doesn't exist (or
// is empty) in public/ — the "phantom path" class (Gin Game, task #714):
// shows.json says there's art, the deployed site 404s. Checks BOTH the
// thumbnail (`image`) and the poster: opening cards render the poster when
// images.poster is declared (posterOrThumb in generate.mjs), so a phantom
// poster path breaks the hero card even with a healthy thumbnail. fileOk is
// injected: (repoRelativePath) => boolean.
function phantomImageViolations(openingShows, fileOk) {
  const out = [];
  for (const s of openingShows || []) {
    if (!s) continue;
    for (const [kind, url] of [['image', s.image], ['poster', s.poster]]) {
      if (!url) continue;
      const rel = localPathForImageUrl(url);
      if (!rel) continue;
      if (!fileOk(rel)) {
        out.push(`Featured opening "${s.title}" (${s.id}) ${kind} points at ${rel} which is missing/empty on disk (phantom path) — the email will show a broken image.`);
      }
    }
  }
  return out;
}

// Count <img> tags with an empty src (getImage(...) || '' call sites in
// generate.mjs) — a show row somewhere lost its image.
function countEmptyImgSrc(html) {
  return (String(html || '').match(/<img\s[^>]*src=""/g) || []).length;
}

// Unique broadwayscorecard.com image URLs referenced by the HTML — for the
// best-effort network check (does prod actually serve these?).
function extractSiteImageUrls(html) {
  const urls = new Set();
  for (const m of String(html || '').matchAll(/<img\s[^>]*src="(https:\/\/broadwayscorecard\.com\/[^"]+)"/g)) {
    urls.add(m[1]);
  }
  return [...urls];
}

// Classify one gap-audit-checkpoint entry for a featured show.
//   'gap'     — audit is fresh and reports uncollected reviews → block
//   'ok'      — audit is fresh and reports zero uncollected reviews
//   'stale'   — audit entry exists but is older than freshHours
//   'no-data' — no entry / unparseable / entry predates the uncollected field
// Gate on `uncollected` (missing URLs + cited-no-URL outlets), NOT the summed
// `gaps` field: gaps also counts flaggedMisses — collected-but-excluded files
// whose exclusions are often permanent and correct (non-reviews, roundups) —
// so gaps>0 would false-block shows like Tao of Glass (missing=[], gaps=3)
// every single issue. Entries written before the audit stamped `uncollected`
// classify as no-data (soft/unverified) rather than false-blocking.
function classifyGapEntry(entry, nowMs, { freshHours = 48 } = {}) {
  // Schema safety: only a non-negative integer uncollected count is a usable
  // verdict — a corrupt value (-1, NaN, string) must read as unverified, not
  // silently bless or block. Same for the timestamp: a FUTURE `at` (clock
  // skew, corrupt write) would otherwise stay "fresh" forever; allow 1h of
  // benign skew, beyond that treat the entry as no-data.
  if (!entry || !Number.isInteger(entry.uncollected) || entry.uncollected < 0) return 'no-data';
  const at = Date.parse(entry.at || '');
  if (!Number.isFinite(at)) return 'no-data';
  if (at - nowMs > 3600 * 1000) return 'no-data';
  if (nowMs - at > freshHours * 3600 * 1000) return 'stale';
  return entry.uncollected > 0 ? 'gap' : 'ok';
}

// Review-completeness findings for the featured opening shows.
//   hard: fresh audit says reviews are missing → the displayed score is not
//         settled; blocks the draft until collected (or explicitly waived).
//   soft: completeness could not be verified (stale/no audit data) → banner.
// missingHostsById (optional): showId → [outlet hosts] from the last audit
// results file, to name what's missing in the failure message.
function completenessFindings(openingShows, checkpoint, nowMs, opts = {}) {
  const { freshHours = 48, missingHostsById = {} } = opts;
  const hard = [];
  const soft = [];
  for (const s of openingShows || []) {
    if (!s || !s.id) continue;
    const entry = (checkpoint || {})[s.id];
    const state = classifyGapEntry(entry, nowMs, { freshHours });
    if (state === 'gap') {
      const hosts = (missingHostsById[s.id] || []).slice(0, 6);
      const hostNote = hosts.length ? ` (aggregators list: ${hosts.join(', ')})` : '';
      hard.push(`Featured opening "${s.title}" (${s.id}) is missing ${entry.uncollected} review(s) already cited by aggregators${hostNote} — its score is built on an incomplete set. Collect them (node scripts/audit-show-review-gap.js --show=${s.id} --checkpoint --ingest-missing, then re-run refresh-drafts.sh) or waive once with NEWSLETTER_ALLOW_GAPS=1.`);
    } else if (state === 'stale') {
      const ageH = Math.round((nowMs - Date.parse(entry.at)) / 3600000);
      soft.push(`Review-completeness for "${s.title}" (${s.id}) unverified — gap audit entry is ${ageH}h old (>${freshHours}h). Re-run: node scripts/audit-show-review-gap.js --show=${s.id} --checkpoint`);
    } else if (state === 'no-data') {
      soft.push(`Review-completeness for "${s.title}" (${s.id}) unverified — no usable gap audit entry (missing or pre-uncollected format). Run: node scripts/audit-show-review-gap.js --show=${s.id} --checkpoint`);
    }
  }
  return { hard, soft };
}

// Coverage-gap DISCLOSURE for the featured openings.
//
// Owner decision 2026-08-09: "include ALL shows that opened that week AND
// collect all reviews. It is not one or the other."
//
// History, because the shape of this function is the whole point:
//   task #823  — a gapped opening HARD-BLOCKED the send.
//   task #905  — it was SWAPPED out instead: pre-send-check.mjs re-ran
//                generate.mjs with NEWSLETTER_EXCLUDE_SHOWS=<gapped ids> and a
//                market lead override, so the show was physically removed from
//                the edition.
//   2026-08-03 — that silently deleted THREE openings from one issue (The Pass,
//                Disruption, The Comedy About Spies), and two of the three were
//                triggered by gaps that did not exist (ticket-seller URLs and a
//                duplicate-URL variant — see issue #4). Nobody reading the
//                newsletter could tell an opening was missing.
//
// Swapping traded a VISIBLE incomplete answer for an INVISIBLE wrong one, which
// is the class this whole tracker exists to close. So the mechanism is gone
// rather than defanged: there is no code path here that can remove a show. The
// gap is reported, loudly, and the show ships.
//
// `allowGaps`/`ackedShowIds` no longer change whether a show is sent (it always
// is) — they only mark a gap as already-known, so the banner can say so instead
// of reading like a new problem every week.
//
// @param openingShows  meta.openingShows, in render order
// @param checkpoint    gap-audit-checkpoint.json ({showId: {at,gaps,uncollected}})
// @param nowMs
// @param opts { freshHours, ackedShowIds: Set<string>, allowGaps: boolean }
// @returns {{gapped: Array<{id,title,uncollected,acked}>, notes: string[]}}
function gapDisclosureDecisions(openingShows, checkpoint, nowMs, opts = {}) {
  const { freshHours = 48, ackedShowIds = new Set(), allowGaps = false } = opts;
  const list = (openingShows || []).filter((s) => s && s.id);
  const gapped = [];
  const notes = [];
  for (const s of list) {
    const entry = (checkpoint || {})[s.id];
    const state = classifyGapEntry(entry, nowMs, { freshHours });
    if (state !== 'gap') continue;
    const acked = allowGaps || ackedShowIds.has(s.id);
    gapped.push({ id: s.id, title: s.title, uncollected: entry.uncollected, acked });
    notes.push(
      `COVERAGE GAP — INCLUDED WITH GAP: "${s.title}" (${s.id}) is missing ${entry.uncollected} review(s) `
      + `already cited by aggregators, so its score is built on an incomplete set. The show STAYS in this issue `
      + `(owner decision 2026-08-09: never drop an opening). Collect the rest with `
      + `node scripts/audit-show-review-gap.js --show=${s.id} --checkpoint --ingest-missing, then re-run `
      + `refresh-drafts.sh.${acked ? ' (Gap already acknowledged.)' : ''}`,
    );
  }
  return { gapped, notes };
}

// The invariant, as a function rather than a comment, so a caller can assert it
// and a test can exercise it directly: whatever the gap state, the set of
// openings that goes OUT is the set that came IN.
//
// Deliberately returns a verdict instead of throwing (house rule, mirrors
// scripts/lib/coverage-gate.js: "if either helper can't reach a confident
// answer it returns the permissive one"). An uncaught throw inside
// pre-send-check.mjs would kill the entire send — a strictly worse outcome than
// the dropped show it is meant to prevent. The caller logs ::error:: and
// continues.
//
// @returns {{ok: boolean, droppedIds: string[], addedIds: string[]}}
function openingsPreserved(inputShows, outputShows) {
  const inIds = (inputShows || []).filter((s) => s && s.id).map((s) => s.id);
  const outIds = new Set((outputShows || []).filter((s) => s && s.id).map((s) => s.id));
  const droppedIds = inIds.filter((id) => !outIds.has(id));
  const addedIds = [...outIds].filter((id) => !inIds.includes(id));
  return { ok: droppedIds.length === 0, droppedIds, addedIds };
}

module.exports = {
  missingImageViolations,
  localPathForImageUrl,
  phantomImageViolations,
  countEmptyImgSrc,
  extractSiteImageUrls,
  classifyGapEntry,
  completenessFindings,
  gapDisclosureDecisions,
  openingsPreserved,
};
