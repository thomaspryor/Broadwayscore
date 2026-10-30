'use strict';
/**
 * BRO-6038: audits data-health-check.yml runs in shadow mode (its
 * `shadow-audits` job, every step continue-on-error). Each writes
 * data/audit/shadow-audits/<name>.json with a `findings` count
 * (scripts/lib/audit-counts.js); health-check.js's shadowAuditResults turns it
 * into one "Shadow audit: <label>" digest row at urgency 'low' (no card).
 *
 * `max` is the baseline measured on 2026-10-30 against a real review-texts
 * clone (what CI checks out; the cloud copy differs). Above it the
 * row warns. 0 means any finding is a defect. A nonzero max is a known
 * population awaiting triage, so the row flags growth, not the backlog.
 * `year` (optional): the report's year the baseline was measured for; another
 * year warns until the baseline is re-measured.
 * Arming an audit = raising its playbook urgency once it has run clean.
 * tests/unit/shadow-audits.test.mjs pins every entry to its workflow step.
 */
const SHADOW_AUDITS_DIR = 'data/audit/shadow-audits';

const SHADOW_AUDITS = [
  { name: 'announced-cast', script: 'audit-announced-cast.js', max: 0,
    label: 'announced shows holding an older cast',
    hint: 'node scripts/audit-announced-cast.js lists the rows (BRO-5809); 2026-10-30 baseline: the-wedding-march-off-broadway-2026 has a cast but no data/cast file.' },
  { name: 'scoreless-llmscore', script: 'audit-scoreless-llmscore.js', max: 0,
    label: 'review files with an llmScore but no score',
    hint: 'node scripts/audit-scoreless-llmscore.js lists them; these are never scored or published (BRO-5395).' },
  { name: 'uncounted-real-reviews', script: 'audit-uncounted-real-reviews.js', max: 231, year: 2026,
    label: 'unflagged review texts missing from reviews.json (current year)',
    hint: 'node scripts/audit-uncounted-real-reviews.js lists them (BRO-5794). findings = files with no wrongShow/wrongProduction/roundup/rejection flag and a tier above stub; 231 on 2026 shows at the 2026-10-30 baseline.' },
  { name: 'listing-page-text', script: 'audit-listing-page-text.js', max: 153,
    label: 'review texts that look like listing or search pages',
    hint: 'node scripts/audit-listing-page-text.js lists them (BRO-5375). 2026-10-30 baseline: 153 hits, 0 on a listing header (the rest are read-more/dated signals).' },
  { name: 'promo-booking-copy', script: 'audit-promo-booking-copy.js', max: 0,
    label: 'live review files holding booking copy or a show-hub URL',
    hint: 'node scripts/audit-promo-booking-copy.js lists them (BRO-5902, BRO-5906). Blocked-domain and same-URL twin counts are in the counts file but not in findings: rebuild-all-reviews.js excludes blocked-domain records.' },
  { name: 'ownership-gate-losses', script: 'audit-ownership-gate-losses.js', max: 0,
    label: 'reviews the ownership gate dropped that exist nowhere',
    hint: 'node scripts/audit-ownership-gate-losses.js --days=7 prints the restore inputs (BRO-5373).' },
  { name: 'corpus-determinism', script: 'audit-corpus-determinism.js', max: 10, countsFlag: '--report-out',
    label: 'published review count dropping by 40 or more',
    hint: 'node scripts/audit-corpus-determinism.js --since-hours=48 (task #653); max matches its own --max-decreases gate.' },
];

function shadowAuditCountsPath(name) {
  return `${SHADOW_AUDITS_DIR}/${name}.json`;
}

module.exports = { SHADOW_AUDITS, SHADOW_AUDITS_DIR, shadowAuditCountsPath };
