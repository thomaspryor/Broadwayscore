// Distinguishes "this section has no data this week" from "this section
// couldn't reach its data source because a credential is missing" for the
// weekly newsletter's section runner (scripts/lib/newsletter-sections.js).
//
// Card #1158: every section that returns null/empty from `sections.run()`
// was recorded as skipReason 'no-data', whether the cause was a genuinely
// quiet week OR a section whose fetch never ran because GA4_PROPERTY_ID /
// GA_SERVICE_ACCOUNT_KEY are absent (true on any dev machine — those are
// GitHub secrets, never in local .env). A 2026-08-09 local regen silently
// shipped a Broadway draft with "Trending This Week" deleted and nothing
// flagged it; the owner caught it by eye.
//
// SECTION_CREDENTIALS is the enumerated table of every generate.mjs section
// that reads from a live external API rather than local repo JSON (see
// generate.mjs's section-runner block for the full section list — everything
// NOT in this table reads shows.json/reviews.json/cast-changes.json/
// grosses.json/commercial.json/.social.json, all committed to the repo, so
// "no data" there really does mean "no data").
//
//   most-read-pages  — popular-pages.mjs's fetchPopularShowPages() queries
//                       GA4 directly; needs GA4_PROPERTY_ID plus either a
//                       key file or an inline service-account key.
//
// Each entry is a list of "require groups": every group must have at least
// one set env var (AND across groups, OR within a group) for the section to
// be considered credential-OK.
export const SECTION_CREDENTIALS = {
  'most-read-pages': [
    ['GA4_PROPERTY_ID'],
    ['GA_KEY_FILE', 'GA_SERVICE_ACCOUNT_KEY'],
  ],
};

export function isCredentialBacked(name) {
  return Object.prototype.hasOwnProperty.call(SECTION_CREDENTIALS, name);
}

// Returns a human-readable description of the first unmet requirement group
// for `name`, or null when every group is satisfied (including sections with
// no entry in SECTION_CREDENTIALS at all — those never need credentials).
export function missingCredential(name, env = process.env) {
  const groups = SECTION_CREDENTIALS[name];
  if (!groups) return null;
  for (const group of groups) {
    if (!group.some((v) => !!env[v])) {
      return group.length === 1 ? group[0] : group.join(' or ');
    }
  }
  return null;
}

// Reclassifies one section-runner entry ({name, fired, skipReason, ...}):
// a skipped, credential-backed section whose creds are absent is relabeled
// 'no-access: <vars> missing' regardless of what the runner recorded — this
// is the override that keeps a credential gap from ever reading as 'no-data'.
// Fired sections and non-credential sections pass through unchanged.
//
// `noAccess: true` is the discrete field the PATCH-refusal gate below reads —
// deliberately NOT a skipReason string-prefix check, so a future rewording of
// the human-readable reason can't silently stop the gate from firing.
export function classifyEntry(entry, env = process.env) {
  if (!entry || entry.fired) return entry;
  const missing = missingCredential(entry.name, env);
  if (!missing) return entry;
  return { ...entry, skipReason: `no-access: ${missing} missing`, noAccess: true };
}

export function classifyEntries(entries, env = process.env) {
  return entries.map((e) => classifyEntry(e, env));
}

export function noAccessSections(entries) {
  return entries.filter((e) => e && e.noAccess === true);
}

// The PATCH-refusal gate: true when any section in `entries` was skipped for
// a missing credential. NEWSLETTER_ALLOW_NO_ACCESS=1 is the explicit,
// opt-in override (mirrors NEWSLETTER_ALLOW_GAPS) — the default is refuse.
export function hasNoAccessSection(entries, env = process.env) {
  if (env.NEWSLETTER_ALLOW_NO_ACCESS === '1') return false;
  return noAccessSections(entries).length > 0;
}
