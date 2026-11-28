// Pure status-classification helpers for the /ingest bulk-paste flow.
//
// Card #1604 (Lost Boys postmortem Issue #1): the bulk endpoint's UI counted
// 11 submitted, 10 accounted for — one row vanished with no error. Root
// cause (2026-04-29 audit): BatchPasteForm only ever created a log row for
// slots that survived client-side validation (`validSlots`); a slot that
// failed validation (bad URL, <50 char text) or duplicated another slot's
// URL was filtered out before the submit loop ever ran, so it never got a
// row at all. This module is the single source of truth for (a) deciding
// which slots to skip vs submit and why, and (b) turning any outcome
// (submitted-and-succeeded, submitted-and-rejected, or skipped-pre-submit)
// into one of a fixed set of display statuses so every attempted row is
// accounted for. Required both by src/app/admin/ingest/IngestForm.tsx and
// by tests/unit/bulk-ingest-status-reporting.test.mjs — see CLAUDE.md rule
// 15 (extract to scripts/lib/, require() the real function in tests).

// The card's canonical display taxonomy (Suggested approach + Acceptance
// criteria sections). 'other-rejection' is a superset fallback for
// server-side rejections that don't map to one of the six named buckets
// (e.g. 'no-show') — it is never silently dropped, just less specific.
const STATUS_META = {
  success: { icon: '✓', label: 'Saved', tone: 'success' },
  'byline-error': {
    icon: '⚠',
    label: 'Saved as pending — byline not detected (critic set to "Unknown")',
    tone: 'warning',
  },
  'outlet-unknown': {
    icon: '✕',
    label: 'Outlet not in registry — add domain to outlet-registry.json',
    tone: 'error',
  },
  'duplicate-filtered': {
    icon: '⊘',
    label: 'Duplicate — same URL already in this batch',
    tone: 'error',
  },
  'malformed-line': {
    icon: '✕',
    label: 'Malformed — needs a valid URL and review text ≥50 characters',
    tone: 'error',
  },
  'server-error': {
    icon: '✕',
    label: 'GitHub API error — retry or check token',
    tone: 'error',
  },
  'other-rejection': { icon: '✕', label: 'Rejected', tone: 'error' },
  submitting: { icon: '⏳', label: 'Submitting…', tone: 'pending' },
};

// Server-side stale-flag collision reads to the operator exactly like a
// duplicate URL, so it is folded into the same display bucket as the
// client-side same-batch dupe check. 'no-show' and 'other' don't have a
// dedicated bucket in the card's taxonomy, so they fall through to
// 'other-rejection' rather than being mis-labeled.
function classifyServerFailure(failureReason) {
  switch (failureReason) {
    case 'outlet-unknown':
      return 'outlet-unknown';
    case 'duplicate':
      return 'duplicate-filtered';
    case 'malformed-url':
      return 'malformed-line';
    case 'server-error':
      return 'server-error';
    default:
      return 'other-rejection';
  }
}

// entry shape (superset of IngestForm's LogEntry):
//   { status: 'submitting'|'saved'|'failed', failureReason?, pendingReason?,
//     skippedReason?: 'duplicate-filtered'|'malformed-line' }
// skippedReason is set for rows that were skipped BEFORE hitting the API
// (client-side validation / same-batch dedupe) — see buildSubmissionPlan.
function classifyStatus(entry) {
  if (entry.skippedReason) return entry.skippedReason;
  if (entry.status === 'submitting') return 'submitting';
  if (entry.status === 'saved') {
    return entry.pendingReason === 'no-byline' ? 'byline-error' : 'success';
  }
  return classifyServerFailure(entry.failureReason);
}

function describeStatus(displayStatus) {
  return STATUS_META[displayStatus] || STATUS_META['other-rejection'];
}

function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Only the hostname is case-folded (DNS is case-insensitive) — path/query
// are left as-is, matching route.ts's own normalizeUrl (route.ts:713) so a
// slot the server would treat as a genuine duplicate is the same slot this
// treats as one. Also strips the same tracking-param set the server strips,
// so "same article, different utm_source" batches correctly as one review
// instead of two false-negative duplicates.
const TRACKING_PARAM_RE = /^utm_|^fbclid$|^triedRedirect$|^ref$|^mc_eid$/;
function normalizeUrlForDupeCheck(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    for (const key of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim().toLowerCase();
  }
}

// Null when the slot is valid to submit; otherwise the reason it must be
// skipped (matches BatchPasteForm's existing validSlots predicate: valid URL
// + fullText >= 50 chars).
function validateSlotForSubmission(slot) {
  const url = (slot.url || '').trim();
  if (!url || !isValidUrl(url)) return 'malformed-line';
  const text = (slot.fullText || '').trim();
  if (text.length < 50) return 'malformed-line';
  return null;
}

// Slot ids (2nd+ occurrence) whose URL duplicates an earlier slot in the
// same batch. First occurrence is never flagged. Exposed standalone for
// callers that want raw same-URL detection; buildSubmissionPlan below does
// NOT use this directly — see the comment there for why.
function findDuplicateSlotIds(slots) {
  const seen = new Set();
  const dupes = new Set();
  for (const slot of slots) {
    const url = (slot.url || '').trim();
    if (!url) continue;
    const key = normalizeUrlForDupeCheck(url);
    if (seen.has(key)) {
      dupes.add(slot.id);
    } else {
      seen.add(key);
    }
  }
  return dupes;
}

// The fix for Card #1604: every slot with ANY content gets exactly one plan
// entry — 'submit' (goes to the API) or 'skip' (never hits the network, but
// still gets a display row via skipReason). A slot with no url and no text
// is a genuinely blank/unused row, not an attempted submission, and is
// omitted — same as before.
//
// Validation runs BEFORE duplicate-checking, and only slots that already
// PASS validation register a key in the dupe-tracking set. Two independent
// ship-check reviewers (2026-08-19) caught the bug in an earlier version of
// this function: dedup ran first, over the raw (unvalidated) URLs, so two
// slots both containing the same malformed garbage string ("not-a-url"
// twice) classified as one 'malformed-line' + one 'duplicate-filtered' —
// implying the first was accepted when neither was submittable. Malformed
// slots never claim their URL as "seen", so a later slot with the SAME URL
// but valid content still gets its fair chance to submit.
function buildSubmissionPlan(slots) {
  const plan = [];
  const seenUrls = new Set();
  for (const slot of slots) {
    const hasContent = !!(slot.url || '').trim() || !!(slot.fullText || '').trim();
    if (!hasContent) continue;
    const malformedReason = validateSlotForSubmission(slot);
    if (malformedReason) {
      plan.push({ slot, action: 'skip', skipReason: malformedReason });
      continue;
    }
    const key = normalizeUrlForDupeCheck(slot.url.trim());
    if (seenUrls.has(key)) {
      plan.push({ slot, action: 'skip', skipReason: 'duplicate-filtered' });
      continue;
    }
    seenUrls.add(key);
    plan.push({ slot, action: 'submit' });
  }
  return plan;
}

module.exports = {
  STATUS_META,
  classifyStatus,
  classifyServerFailure,
  describeStatus,
  isValidUrl,
  validateSlotForSubmission,
  findDuplicateSlotIds,
  buildSubmissionPlan,
};
