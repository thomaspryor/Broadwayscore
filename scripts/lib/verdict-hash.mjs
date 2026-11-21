// scripts/lib/verdict-hash.mjs — content-equivalent hash for visual-qa verdicts.
//
// Purpose: identify a verdict by the VISUAL CONTENT it represents (which
// screenshots/refs, what overflow signature, what LLM verdicts, what ref roles),
// not by when it was produced. Re-running /visual-qa on identical pixels must
// yield an identical hash so an existing `APPROVED: <hash>` keeps working.
//
// History: prior `computeVerdictHash` in visual-qa.mjs hashed the entire verdict
// object including `timestamp` and screenshot file paths. Re-runs always rotated
// the hash, forcing a re-approval treadmill on every commit. /plan-review
// 2026-05-25 documented the 6-reviewer consensus to move to content-equivalence.
//
// Schema version 2 (this module). v1 was the inline hash in visual-qa.mjs.

import { createHash, randomUUID } from 'node:crypto';

export const VERDICT_SCHEMA_VERSION = 2;

// Fields that participate in the content hash. Anything else in the verdict
// (timestamp, runId, raw screenshot paths, textPreview snippets, etc.) is
// metadata and does NOT rotate the hash.
//
// Filled in across Sprint 1 as additional stable inputs are mixed in.
// S0 baseline: same shape as v1 minus `timestamp` and the per-task changes
// listed in the sprint plan. Implemented incrementally per S1-T1..T5.
//
// Inputs (after Sprint 1 is complete):
//   - paths, widths, elements, refsDigest, refRoles
//   - overflowReport with textPreview stripped
//   - elementCropsGeometry (selector/width/height/x/y per crop; not file paths)
//   - screenshotsDigest (sha256(fileBytes) per screenshot)
//   - verdicts.{openai,gemini}.verdict + overallPass
//   - headSha (git HEAD at screenshot time)
//
// During Sprint 0 we land the extraction with the v1 shape preserved so
// behaviour is unchanged; Sprint 1 then re-shapes the inputs.

// Metadata fields stripped before hashing. These are stored on the verdict
// for human / audit consumption but do not represent the visual content.
//
// `branch` was originally included (the verdict belongs to a specific branch)
// but /ship-check 2026-05-26 (Codex P1 + Claude P0-1) flagged it: same
// screenshots on two branches should hash identically. headSha already binds
// commit identity; the branch name is just a label.
const HASH_EXCLUDED_TOP_LEVEL_FIELDS = [
  'contentHash',
  'verdictHash',      // legacy v1 field name
  'runId',
  'timestamp',
  'schemaVersion',
  'verdictSchemaVersion',
  'branch',
  // #950: diagnostic-only fields. `features` (the flags actually rendered)
  // stays IN the hash — it changes screenshot content. `featuresSource` and
  // `demoFlagFindings` are commentary about that same run, not content.
  'featuresSource',
  'demoFlagFindings',
];

// Per-screenshot-digest fields stripped before hashing. `path` is the route
// string ("/about"), `width` the viewport — both are already represented in
// the outer paths/widths arrays. Per-digest `path` would cause hash drift
// whenever the order of file enumeration changes. `bytesSha` carries pixel
// identity; that's what the hash needs.
const DIGEST_HASH_FIELDS_SCREENSHOTS = ['bytesSha'];
const DIGEST_HASH_FIELDS_CROPS = ['selector', 'geometry', 'bytesSha'];
const DIGEST_HASH_FIELDS_REFS = ['bytesSha', 'role'];

function pickStableShape(verdict) {
  const out = {};
  for (const [k, v] of Object.entries(verdict)) {
    if (HASH_EXCLUDED_TOP_LEVEL_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  // Project digest arrays to the stable subset so per-run file-path strings
  // can't sneak into the hash (Claude P0-1).
  if (Array.isArray(out.screenshotsDigest)) {
    out.screenshotsDigest = out.screenshotsDigest.map(d => pickFields(d, DIGEST_HASH_FIELDS_SCREENSHOTS));
  }
  if (Array.isArray(out.elementCropsDigest)) {
    out.elementCropsDigest = out.elementCropsDigest.map(d => pickFields(d, DIGEST_HASH_FIELDS_CROPS));
  }
  if (Array.isArray(out.refsDigest)) {
    out.refsDigest = out.refsDigest.map(d => pickFields(d, DIGEST_HASH_FIELDS_REFS));
  }
  return out;
}

function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

export function computeContentHash(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    throw new Error('computeContentHash: verdict must be an object');
  }
  const stable = stableStringify(pickStableShape(verdict));
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

// Deterministic JSON stringify with sorted keys at every object level.
// Arrays preserve order (significant for paths, widths, refs).
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// Generate a fresh run identifier. Stored on the verdict as `runId` so audit
// tooling can distinguish "two re-runs that happened to produce the same
// content hash" — useful when grepping the ledger for which session approved.
export function generateRunId() {
  return randomUUID();
}
