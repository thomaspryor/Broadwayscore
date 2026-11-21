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
const SOURCE_SCHEMA_PATH = path.join(__dirname, '..', '..', 'data/audit/precursor-source.schema.json');

const PRECURSOR_FIELDS = ['dramaLeague', 'outerCriticsCircle', 'dramadesk'];

let _ajv = null;
let _validate = null;
let _validateSource = null;

function getValidator() {
  if (_validate) return _validate;
  _ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  _validate = _ajv.compile(schema);
  return _validate;
}

function getSourceValidator() {
  if (_validateSource) return _validateSource;
  if (!_ajv) _ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SOURCE_SCHEMA_PATH, 'utf8'));
  _validateSource = _ajv.compile(schema);
  return _validateSource;
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

/**
 * Validate a parsed data/precursors/{name}.json source file against
 * precursor-source.schema.json. Throws on schema violations. Optionally
 * checks every category name against an `isKnownCategory` predicate
 * (returning false → warning collected, NOT thrown). The category check
 * catches transcription typos like "Outstanding Direcetor" that wouldn't
 * fail the schema but would silently miss the +30 win bonus downstream.
 *
 * Returns { ok, name, unknownCategories: string[] }.
 */
function validatePrecursorSource(name, parsed, opts = {}) {
  const validate = getSourceValidator();
  const ok = validate(parsed);
  if (!ok) {
    const errs = formatErrors(validate.errors || [], `data/precursors/${name}.json`);
    throw new Error(`Precursor source ${name}.json failed schema validation:\n${errs}`);
  }
  const unknownCategories = [];
  const { isKnownCategory } = opts;
  if (typeof isKnownCategory === 'function') {
    // For object-shape (DD/OCC/DL/NYDCCC): the OUTER keys are category names.
    // Pulitzer's shape is an array with no category keys — skip there.
    if (parsed && parsed.data && !Array.isArray(parsed.data)) {
      for (const categoryName of Object.keys(parsed.data)) {
        if (!isKnownCategory(categoryName)) {
          unknownCategories.push(categoryName);
        }
      }
    }
  }
  return { ok: true, name, unknownCategories };
}

module.exports = { validateAwardsObject, validateAwardsFile, validatePrecursorSource };
