// Reader contact details for feedback reports, kept OUT of the public repo
// (BRO-4453). thomaspryor/Broadwayscore is public, and bug-diagnosis issues
// used to carry the reader's name, email and message in their body (visible
// "From:" line plus the hidden DIAGNOSIS_JSON block): 36 reader emails were
// readable by anyone through the issues API.
//
// Now process-feedback.js records those details here, in
// data/feedback-submitters.json, which lives in the PRIVATE core-data repo
// (push-core-data CORE_FILES, gitignored here). Issues carry only an opaque
// submissionId (the Formspree id, already public in
// data/audit/processed-feedback.json). Every consumer that needs the reader
// (thank-you email, owner reader-fix email, approval email, dedup) parses the
// issue with loadIssueDiagnosis(), which puts the details back from this store.
//
// Issues filed before this change still hold the details in their body, and
// hydrateDiagnosis() leaves those values alone when the store has no entry, so
// fixes on old reports keep emailing the right reader.

const fs = require('fs');
const path = require('path');
const { submissionId } = require('./feedback-run-report.js');
const { redactEmails } = require('./pii-scan.js');

const STORE_PATH = path.join(__dirname, '../../data/feedback-submitters.json');
// A plan can be approved weeks after the report; a year covers every real
// case and keeps the file from growing forever.
const RETENTION_DAYS = 365;

// The three DIAGNOSIS_JSON fields that identify the reader. Nothing else in a
// diagnosis is personal: show ids, the LLM summary and findings are about the
// site, not the person.
const PII_DIAGNOSIS_FIELDS = ['submitterName', 'submitterEmail', 'originalMessage'];

function emptyStore() {
  return { version: 1, entries: {} };
}

function loadStore(storePath = STORE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw;
  } catch { /* missing or unreadable: start empty */ }
  return emptyStore();
}

function pruneStore(store, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  for (const [id, e] of Object.entries(store.entries)) {
    const t = Date.parse(e && e.storedAt);
    if (Number.isFinite(t) && t < cutoff) delete store.entries[id];
  }
  return store;
}

function saveStore(store, storePath = STORE_PATH, now = Date.now()) {
  pruneStore(store, now);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
}

function submissionKey(sub) {
  const id = submissionId(sub);
  return id ? String(id) : null;
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v : null);

// Records the reader's details. Returns the key, or null when the submission
// has no id (nothing to key by) or carries no personal details at all.
function recordSubmitter(store, sub, now = Date.now()) {
  const key = submissionKey(sub);
  if (!key) return null;
  const name = clean(sub.name);
  const email = clean(sub.email);
  const message = clean(sub.message);
  if (!name && !email && !message) return null;
  const prev = store.entries[key];
  store.entries[key] = {
    name,
    email,
    show: clean(sub.show),
    message,
    storedAt: (prev && prev.storedAt) || new Date(now).toISOString(),
  };
  return key;
}

function lookupSubmitter(store, key) {
  if (!store || !key) return null;
  return store.entries[String(key)] || null;
}

// Fields of a Formspree submission that are safe in the public repo: ids and
// routing only. An allowlist, so a new form field (phone, _replyto, ...) is
// dropped by default instead of leaking.
const PUBLIC_SUBMISSION_FIELDS = ['_id', 'id', 'createdAt', '_date', 'show', 'category', '_isSpam', '_mergedSubmissionIds'];

// A submission safe to commit to the public repo. The reader's name, email
// and words go; the full copy is in the store under the same id.
function redactSubmission(sub) {
  if (!sub || typeof sub !== 'object') return sub;
  const out = {};
  for (const f of PUBLIC_SUBMISSION_FIELDS) if (sub[f] !== undefined) out[f] = sub[f];
  return out;
}

// Removes the reader fields from a DIAGNOSIS_JSON payload before it goes into
// a public issue body.
function redactDiagnosis(diag) {
  const out = { ...diag };
  for (const f of PII_DIAGNOSIS_FIELDS) delete out[f];
  return out;
}

// Puts the reader's details back into a diagnosis parsed from an issue. Old
// issues (no submissionId, or an id the store has pruned) keep whatever their
// body already carried.
function hydrateDiagnosis(diag, store) {
  if (!diag) return diag;
  const e = lookupSubmitter(store, diag.submissionId);
  if (!e) return diag;
  return {
    ...diag,
    submitterName: e.name || null,
    submitterEmail: e.email || null,
    submitterShow: diag.submitterShow || e.show || null,
    originalMessage: e.message || null,
  };
}

// Keys whose values are LLM-written prose that can quote the reader. Only
// these get the name/message scrub; every other string (show ids, slugs,
// titles, workflow inputs) is routing data and gets the email scrub alone, so
// a reader called "Mary" can never turn mary-poppins-2006 into
// [reader]-poppins-2006.
const PROSE_KEYS = new Set(['summary', 'whatsHappening', 'findings', 'proposedFix', 'recommendedAction', 'reason']);

function scrubForPublic(value, reader, prose = false) {
  if (typeof value === 'string') return prose ? scrubPublicText(value, reader) : redactEmails(value);
  if (Array.isArray(value)) return value.map((v) => scrubForPublic(v, reader, prose));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubForPublic(v, reader, prose || PROSE_KEYS.has(k));
    return out;
  }
  return value;
}

function writePendingWithPrivateReaders(entries, { pendingPath, storePath = STORE_PATH, now = Date.now() } = {}) {
  let storeChanged = false;
  if (entries.length > 0) {
    const store = loadStore(storePath);
    const before = JSON.stringify(store);
    for (const d of entries) if (d && d.submission) recordSubmitter(store, d.submission, now);
    if (JSON.stringify(store) !== before) {
      saveStore(store, storePath, now);
      storeChanged = true;
    }
  }
  // The diagnosis and item are LLM text that can quote the reader, so their
  // prose is scrubbed too, not just the submission.
  const publicEntries = entries.map((d) => {
    if (!d || !d.submission) return d;
    const reader = { name: d.submission.name, message: d.submission.message, show: d.submission.show };
    return scrubForPublic({ ...d, submission: redactSubmission(d.submission) }, reader);
  });
  fs.writeFileSync(pendingPath, JSON.stringify(publicEntries, null, 2) + '\n');
  return { storeChanged, publicEntries };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Scrubs one piece of LLM prose before it goes into a public issue, comment,
// file or log. The builders never insert reader fields, but the model can
// quote the reader ("Jane Quigley at jane@x.com says ..."). Order matters: the
// message goes first (its raw and JSON-escaped forms), because replacing the
// name or an email inside it first would stop the verbatim match. The name is
// scrubbed only when it is a full name (two or more words) and not part of the
// show title: a lone first name identifies nobody and collides with titles
// ("Annie", "Mary Poppins").
function scrubPublicText(text, reader = {}) {
  let out = String(text ?? '');
  const message = clean(reader.message) && reader.message.trim();
  if (message && message.length >= 20) {
    for (const form of [message, JSON.stringify(message).slice(1, -1)]) out = out.split(form).join('[reader message]');
  }
  const name = clean(reader.name) && reader.name.trim();
  const show = String(reader.show || '').toLowerCase();
  if (name && /\s/.test(name) && name.toLowerCase() !== 'anonymous' && !show.includes(name.toLowerCase())) {
    out = out.replace(new RegExp(`(^|[^\\p{L}])${escapeRe(name)}(?![\\p{L}])`, 'giu'), '$1[reader]');
  }
  return redactEmails(out);
}

function parseDiagnosisJson(issueBody) {
  const m = String(issueBody || '').match(/<!-- DIAGNOSIS_JSON\n([\s\S]*?)\nDIAGNOSIS_JSON -->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// The one way consumers read a bug-diagnosis issue: parse, then hydrate.
function loadIssueDiagnosis(issueBody, { store, storePath } = {}) {
  const diag = parseDiagnosisJson(issueBody);
  if (!diag) return null;
  const s = store || loadStore(storePath);
  if (diag.submissionId && !lookupSubmitter(s, diag.submissionId) && !diag.submitterEmail) {
    // Ids only: this lands in public Actions logs.
    console.log(`Reader details for submission ${diag.submissionId} are not in feedback-submitters.json (store push lagging or pruned); continuing without them`);
  }
  return hydrateDiagnosis(diag, s);
}

module.exports = {
  STORE_PATH,
  RETENTION_DAYS,
  PII_DIAGNOSIS_FIELDS,
  emptyStore,
  loadStore,
  saveStore,
  pruneStore,
  submissionKey,
  recordSubmitter,
  lookupSubmitter,
  redactSubmission,
  redactDiagnosis,
  hydrateDiagnosis,
  scrubPublicText,
  scrubForPublic,
  writePendingWithPrivateReaders,
  parseDiagnosisJson,
  loadIssueDiagnosis,
};
