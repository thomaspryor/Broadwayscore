'use strict';

/**
 * approved-fix-drift.js (BRO-7155): find review-text files whose newest
 * approved-fix stamp for an exclusion field no longer matches the field, and
 * separate the drifts that a later, recorded decision explains from the ones a
 * writer silently erased.
 *
 * Read-only: pure predicates over parsed records. The CLI is
 * scripts/audit-approved-fix-drift.js.
 *
 * Why: BRO-7131 found a stale CI writer erasing an approved isNonReview, and
 * waiting-for-godot-2009/backstage--erik-haagensen.json lost an approved
 * wrongShow=true 16 minutes after it landed (rebuild's BRO-6716 self-heal did
 * not check hasApprovedFlag). Nothing reported either until a manual sweep.
 */

const { approvedFixStillBound, approvedFixBinding } = require('./approved-fix-flag');
const { isTargetInvalidated } = require('./orphaned-duplicate-pointer-heal');

const EXCLUSION_FIELDS = [
  'wrongShow', 'wrongProduction', 'isNonReview', 'isRoundupArticle',
  'duplicateOf', 'crossOutletDuplicate',
];

// A person's clear for a boolean exclusion flag: readers treat the flag as
// cleared while it is set, so a re-set flag next to it is not shown.
const MANUAL_CLEAR_FIELD = {
  wrongShow: 'wrongShowManualClear',
  wrongProduction: 'wrongProductionManualClear',
  isNonReview: 'nonReviewManualClear',
};

/**
 * Drifts a person already looked at, keyed `<show>/<file>|<fixId>`. A new
 * approved stamp on the field changes the fixId, so the file alarms again.
 */
const ACKNOWLEDGED = {
  'elling-2010/reuters--david-rooney.json|69e2b6ef-ea6a-446f-92ce-d05b37c6ee0b':
    'BRO-7155: the approval cleared the flag because the Hollywood Reporter primary was missing; hollywood-reporter--unknown.json is back as a complete copy of the same Rooney review, so this Reuters syndication is correctly the duplicate.',
};

function norm(v) {
  return v === undefined || v === null || v === false || v === '' ? null : v;
}

/** Newest approved stamp (by `at`) that set `field`, or null. */
function latestStamp(record, field) {
  const list = Array.isArray(record && record.approvedFixes) ? record.approvedFixes : [];
  let best = null;
  for (const e of list) {
    if (!e || e.field !== field || !Object.prototype.hasOwnProperty.call(e, 'newValue')) continue;
    if (!best || String(e.at || '') >= String(best.at || '')) best = e;
  }
  return best;
}

function laterApproved(record, field, value, afterAt) {
  const s = latestStamp(record, field);
  return Boolean(s && String(s.at || '') > String(afterAt || '') && s.newValue === value && approvedFixStillBound(s, record));
}

/**
 * Explain a duplicateOf drift (approved pointer, current value differs) from
 * the state of the target file. `siblings` maps a basename in the same show
 * folder to its parsed record (missing key = file absent).
 */
function explainDuplicateOf(file, record, stamp, siblings) {
  const own = file.split('/').pop();
  const target = stamp.newValue;
  if (typeof target !== 'string' || !target) return null;
  if (target === own) return 'invalid-approval: pointer at itself';
  const t = siblings ? siblings[target] : undefined;
  if (siblings && t === undefined) return 'target-missing: the approved target file no longer exists';
  if (!t) return null;
  if (t.duplicateOf === own) return 'cycle: the target now points back at this file, so the pair is still deduplicated';
  // Same test the orphan sweep uses, so a target it would clear stays explained
  // and a recovered target (the she-loves-me case) alarms.
  if (t.contentTier === 'invalid' || isTargetInvalidated(t)) {
    return 'target-excluded: the approved target is now excluded, so pointing at it would hide the review';
  }
  if (record.duplicateTextOf === target) return 'text-duplicate: duplicateTextOf still points at the approved target';
  const ownUrl = approvedFixBinding(record).url;
  const targetUrl = approvedFixBinding(t).url;
  // A pair approved across two urls (a syndicated copy) always differs, so
  // only a url that moved since the approval explains the drift.
  const boundUrl = stamp.boundTo && stamp.boundTo.url;
  const moved = !boundUrl || boundUrl !== ownUrl;
  if (moved && ownUrl && targetUrl && ownUrl !== targetUrl) {
    return 'url-diverged: this file and the approved target now carry different articles';
  }
  return null;
}

/**
 * Classify one record. Returns [] or a list of
 * { file, field, stamp, current, explained: string|null }.
 */
function classifyRecord(file, record, { siblings } = {}) {
  const out = [];
  if (!record || typeof record !== 'object' || !Array.isArray(record.approvedFixes)) return out;
  for (const field of EXCLUSION_FIELDS) {
    const stamp = latestStamp(record, field);
    if (!stamp) continue;
    const want = norm(stamp.newValue);
    const have = norm(record[field]);
    if (want === have) continue;
    let explained = null;
    const ack = ACKNOWLEDGED[`${file}|${stamp.fixId}`];
    if (ack) explained = `acknowledged: ${ack}`;
    else if (want === true && !approvedFixStillBound(stamp, record)) {
      explained = 'unbound: the url or body changed since the approval, so it no longer applies';
    } else if (want !== true && have === true && MANUAL_CLEAR_FIELD[field] && record[MANUAL_CLEAR_FIELD[field]] === true) {
      explained = `manual-clear: ${MANUAL_CLEAR_FIELD[field]} keeps the flag cleared for readers`;
    } else if (want === true && MANUAL_CLEAR_FIELD[field] && laterApproved(record, MANUAL_CLEAR_FIELD[field], true, stamp.at)) {
      explained = `later-approval: a newer approved ${MANUAL_CLEAR_FIELD[field]}=true`;
    } else if (field === 'crossOutletDuplicate' && want === null && laterApproved(record, 'crossOutletVerified', true, stamp.at)) {
      explained = 'later-approval: a newer approved crossOutletVerified=true confirmed the reprint';
    } else if (field === 'duplicateOf' && typeof stamp.newValue === 'string') {
      explained = explainDuplicateOf(file, record, stamp, siblings);
    }
    out.push({ file, field, stamp, current: record[field] === undefined ? null : record[field], explained });
  }
  return out;
}


const DRIFT_ALERT_KEY = 'approved-fix-drift:unexplained';
const DRIFT_ALERT_MAX_ROWS = 25;

/**
 * BRO-7179: the owner-alert-router call for one audit run. Pure. `unexplained`
 * is classifyRecord() output with `explained` false. Returns
 * { action: 'resolve', conditionKey, reason } when nothing is unexplained, else
 * { action: 'route', alert } for routeAlert(). The card names only the file
 * path, field, fixId, dates and the flag values: never review text.
 */
// Exclusion fields hold booleans or a sibling filename; anything else is
// clamped so a malformed value can never carry text into a card.
function flagValue(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v === undefined ? null : v);
  if (typeof v === 'string' && v.length <= 120 && !/\s{2}|\n/.test(v)) return JSON.stringify(v);
  return `<${typeof v}, not shown>`;
}

function decideDriftAlert(unexplained) {
  const list = Array.isArray(unexplained) ? unexplained : [];
  if (!list.length) {
    return { action: 'resolve', conditionKey: DRIFT_ALERT_KEY, reason: 'no unexplained approved-fix drift' };
  }
  const shown = list.slice(0, DRIFT_ALERT_MAX_ROWS);
  const rows = shown.map((d) => {
    const s = d.stamp || {};
    return `- ${d.file} ${d.field}: approved ${flagValue(s.newValue)} at ${s.at || '?'} (fix ${s.fixId || '?'}), now ${flagValue(d.current)}`;
  });
  const more = list.length - shown.length;
  if (more > 0) rows.push(`- ...and ${more} more (run the audit for the full list)`);
  const n = list.length;
  return {
    action: 'route',
    alert: {
      conditionKey: DRIFT_ALERT_KEY,
      title: `Approved-fix drift: ${n} approved exclusion verdict${n === 1 ? '' : 's'} silently undone`,
      description: `The daily approved-fix drift audit found ${n} review-text file${n === 1 ? '' : 's'} whose newest approved-fix stamp no longer matches the field, with no later recorded decision explaining it. This list is the snapshot at filing; run the audit for the current one.\n\n${rows.join('\n')}`,
      hint: 'For each row: restore the approved value with node scripts/new-fix-plan.js --review-edit=<show>/<file>.json:<field>=<value>, then find and fix the writer that erased it. If a later decision is correct, add an ACKNOWLEDGED entry in scripts/lib/approved-fix-drift.js with the reason. Done when node scripts/audit-approved-fix-drift.js --strict exits 0.',
      severity: 'warning',
      disposition: 'auto',
      cooldownHours: 20,
      // No custom `verify`: the router's fallback (check-alert-condition-absent.js on
      // this key) is on verify-gate's allowlist, so the card stays dispatchable.
    },
  };
}

module.exports = { EXCLUSION_FIELDS, ACKNOWLEDGED, DRIFT_ALERT_KEY, latestStamp, classifyRecord, explainDuplicateOf, decideDriftAlert };
