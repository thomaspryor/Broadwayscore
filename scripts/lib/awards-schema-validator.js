/**
 * Validate every precursor entry in data/awards.json against the JSON Schema
 * at data/audit/awards-precursor.schema.json. Throws on the first violation
 * with a useful error message.
 *
 * Why this exists: manual transcription of nominee lists into JS const arrays
 * can silently coerce typos (missing closing bracket, mis-typed key) into
 * malformed objects that pass the existing idempotency assertion but produce
 * scoring garbage downstream. The 6-reviewer plan-review pre-mortem flagged
 * this as the PRIMARY failure scenario; JSON Schema validation throws
 * instead of coercing.
 *
 * Usage:
 *   const { validateAwardsFile } = require('./scripts/lib/awards-schema-validator');
 *   validateAwardsFile('data/awards.json');  // throws on violation
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'data/audit/awards-precursor.schema.json');

const PRECURSOR_FIELDS = ['dramaLeague', 'outerCriticsCircle', 'dramadesk'];

let _ajv = null;
let _validate = null;

function getValidator() {
  if (_validate) return _validate;
  _ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  _validate = _ajv.compile(schema);
  return _validate;
}

function formatErrors(errors, context) {
  return errors
    .map(e => `  - ${context}${e.instancePath || ''}: ${e.message} (${JSON.stringify(e.params)})`)
    .join('\n');
}

/**
 * Validate all precursor entries in the parsed awards.json object.
 * Throws AggregateError-style with all violations.
 */
function validateAwardsObject(awards) {
  const validate = getValidator();
  const violations = [];
  const shows = (awards && awards.shows) || {};
  for (const [showId, data] of Object.entries(shows)) {
    for (const field of PRECURSOR_FIELDS) {
      const node = data[field];
      if (!node) continue;
      const ok = validate(node);
      if (!ok) {
        violations.push({ showId, field, errors: validate.errors });
      }
    }
  }
  if (violations.length > 0) {
    const lines = violations.map(v =>
      `${v.showId}.${v.field}:\n${formatErrors(v.errors, '')}`
    );
    throw new Error(`awards.json schema validation failed for ${violations.length} entries:\n${lines.join('\n\n')}`);
  }
  return { ok: true, validatedCount: Object.keys(shows).length };
}

/**
 * Read and validate awards.json from disk.
 */
function validateAwardsFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const awards = JSON.parse(raw);
  return validateAwardsObject(awards);
}

module.exports = { validateAwardsObject, validateAwardsFile };
