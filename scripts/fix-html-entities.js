#!/usr/bin/env node

/**
 * fix-html-entities.js
 *
 * Scans all JSON files in data/review-texts/ recursively and decodes
 * HTML entities in string fields to proper Unicode characters.
 *
 * Usage: node scripts/fix-html-entities.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

// Comprehensive named HTML entity map
const NAMED_ENTITIES = {
  // Accented characters
  'aacute': '\u00E1',   // á
  'Aacute': '\u00C1',   // Á
  'agrave': '\u00E0',   // à
  'Agrave': '\u00C0',   // À
  'acirc': '\u00E2',    // â
  'Acirc': '\u00C2',    // Â
  'atilde': '\u00E3',   // ã
  'Atilde': '\u00C3',   // Ã
  'auml': '\u00E4',     // ä
  'Auml': '\u00C4',     // Ä
  'aring': '\u00E5',    // å
  'Aring': '\u00C5',    // Å
  'aelig': '\u00E6',    // æ
  'AElig': '\u00C6',    // Æ
  'ccedil': '\u00E7',   // ç
  'Ccedil': '\u00C7',   // Ç
  'eacute': '\u00E9',   // é
  'Eacute': '\u00C9',   // É
  'egrave': '\u00E8',   // è
  'Egrave': '\u00C8',   // È
  'ecirc': '\u00EA',    // ê
  'Ecirc': '\u00CA',    // Ê
  'euml': '\u00EB',     // ë
  'Euml': '\u00CB',     // Ë
  'iacute': '\u00ED',   // í
  'Iacute': '\u00CD',   // Í
  'igrave': '\u00EC',   // ì
  'Igrave': '\u00CC',   // Ì
  'icirc': '\u00EE',    // î
  'Icirc': '\u00CE',    // Î
  'iuml': '\u00EF',     // ï
  'Iuml': '\u00CF',     // Ï
  'ntilde': '\u00F1',   // ñ
  'Ntilde': '\u00D1',   // Ñ
  'oacute': '\u00F3',   // ó
  'Oacute': '\u00D3',   // Ó
  'ograve': '\u00F2',   // ò
  'Ograve': '\u00D2',   // Ò
  'ocirc': '\u00F4',    // ô
  'Ocirc': '\u00D4',    // Ô
  'otilde': '\u00F5',   // õ
  'Otilde': '\u00D5',   // Õ
  'ouml': '\u00F6',     // ö
  'Ouml': '\u00D6',     // Ö
  'oslash': '\u00F8',   // ø
  'Oslash': '\u00D8',   // Ø
  'uacute': '\u00FA',   // ú
  'Uacute': '\u00DA',   // Ú
  'ugrave': '\u00F9',   // ù
  'Ugrave': '\u00D9',   // Ù
  'ucirc': '\u00FB',    // û
  'Ucirc': '\u00DB',    // Û
  'uuml': '\u00FC',     // ü
  'Uuml': '\u00DC',     // Ü
  'yacute': '\u00FD',   // ý
  'Yacute': '\u00DD',   // Ý
  'yuml': '\u00FF',     // ÿ
  'szlig': '\u00DF',    // ß
  'eth': '\u00F0',      // ð
  'ETH': '\u00D0',      // Ð
  'thorn': '\u00FE',    // þ
  'THORN': '\u00DE',    // Þ

  // Common punctuation & symbols
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  'apos': "'",
  'nbsp': '\u00A0',     // non-breaking space
  'ldquo': '\u201C',    // "
  'rdquo': '\u201D',    // "
  'lsquo': '\u2018',    // '
  'rsquo': '\u2019',    // '
  'sbquo': '\u201A',    // ‚
  'bdquo': '\u201E',    // „
  'laquo': '\u00AB',    // «
  'raquo': '\u00BB',    // »
  'mdash': '\u2014',    // —
  'ndash': '\u2013',    // –
  'hellip': '\u2026',   // …
  'bull': '\u2022',     // •
  'middot': '\u00B7',   // ·
  'prime': '\u2032',    // ′
  'Prime': '\u2033',    // ″
  'trade': '\u2122',    // ™
  'copy': '\u00A9',     // ©
  'reg': '\u00AE',      // ®
  'deg': '\u00B0',      // °
  'micro': '\u00B5',    // µ
  'para': '\u00B6',     // ¶
  'sect': '\u00A7',     // §
  'pound': '\u00A3',    // £
  'euro': '\u20AC',     // €
  'yen': '\u00A5',      // ¥
  'cent': '\u00A2',     // ¢
  'curren': '\u00A4',   // ¤
  'iexcl': '\u00A1',    // ¡
  'iquest': '\u00BF',   // ¿
  'times': '\u00D7',    // ×
  'divide': '\u00F7',   // ÷
  'plusmn': '\u00B1',   // ±
  'frac12': '\u00BD',   // ½
  'frac14': '\u00BC',   // ¼
  'frac34': '\u00BE',   // ¾
  'sup1': '\u00B9',     // ¹
  'sup2': '\u00B2',     // ²
  'sup3': '\u00B3',     // ³
  'ordf': '\u00AA',     // ª
  'ordm': '\u00BA',     // º
  'not': '\u00AC',      // ¬
  'shy': '\u00AD',      // soft hyphen
  'macr': '\u00AF',     // ¯
  'cedil': '\u00B8',    // ¸

  // Dashes, spaces, formatting
  'ensp': '\u2002',     // en space
  'emsp': '\u2003',     // em space
  'thinsp': '\u2009',   // thin space
  'zwnj': '\u200C',     // zero-width non-joiner
  'zwj': '\u200D',      // zero-width joiner
  'lrm': '\u200E',      // left-to-right mark
  'rlm': '\u200F',      // right-to-left mark

  // Greek letters (common)
  'alpha': '\u03B1', 'beta': '\u03B2', 'gamma': '\u03B3', 'delta': '\u03B4',
  'epsilon': '\u03B5', 'zeta': '\u03B6', 'eta': '\u03B7', 'theta': '\u03B8',
  'iota': '\u03B9', 'kappa': '\u03BA', 'lambda': '\u03BB', 'mu': '\u03BC',
  'nu': '\u03BD', 'xi': '\u03BE', 'omicron': '\u03BF', 'pi': '\u03C0',
  'rho': '\u03C1', 'sigma': '\u03C3', 'tau': '\u03C4', 'upsilon': '\u03C5',
  'phi': '\u03C6', 'chi': '\u03C7', 'psi': '\u03C8', 'omega': '\u03C9',

  // Math symbols
  'minus': '\u2212',    // −
  'lowast': '\u2217',   // ∗
  'radic': '\u221A',    // √
  'infin': '\u221E',    // ∞
  'le': '\u2264',       // ≤
  'ge': '\u2265',       // ≥
  'ne': '\u2260',       // ≠
  'equiv': '\u2261',    // ≡
  'sum': '\u2211',      // ∑
  'prod': '\u220F',     // ∏
  'part': '\u2202',     // ∂
  'int': '\u222B',      // ∫
  'empty': '\u2205',    // ∅
  'isin': '\u2208',     // ∈
  'notin': '\u2209',    // ∉
  'sub': '\u2282',      // ⊂
  'sup': '\u2283',      // ⊃
  'cup': '\u222A',      // ∪
  'cap': '\u2229',      // ∩
  'and': '\u2227',      // ∧
  'or': '\u2228',       // ∨
  'exist': '\u2203',    // ∃
  'forall': '\u2200',   // ∀
  'nabla': '\u2207',    // ∇
  'perp': '\u22A5',     // ⊥

  // Arrows
  'larr': '\u2190',     // ←
  'uarr': '\u2191',     // ↑
  'rarr': '\u2192',     // →
  'darr': '\u2193',     // ↓
  'harr': '\u2194',     // ↔

  // Misc symbols
  'spades': '\u2660',   // ♠
  'clubs': '\u2663',    // ♣
  'hearts': '\u2665',   // ♥
  'diams': '\u2666',    // ♦
  'loz': '\u25CA',      // ◊
  'dagger': '\u2020',   // †
  'Dagger': '\u2021',   // ‡
  'permil': '\u2030',   // ‰
  'fnof': '\u0192',     // ƒ
  'OElig': '\u0152',    // Œ
  'oelig': '\u0153',    // œ
  'Scaron': '\u0160',   // Š
  'scaron': '\u0161',   // š
  'Yuml': '\u0178',     // Ÿ
  'circ': '\u02C6',     // ˆ
  'tilde': '\u02DC',    // ˜
};

// Regex to match all HTML entities: named, decimal numeric, and hex numeric
const ENTITY_REGEX = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode a single HTML entity match.
 */
function decodeEntity(match, entity) {
  // Decimal numeric entity: &#NNN;
  if (entity.startsWith('#') && !entity.startsWith('#x')) {
    const code = parseInt(entity.substring(1), 10);
    if (!isNaN(code) && code > 0) {
      try {
        return String.fromCodePoint(code);
      } catch (e) {
        return match; // invalid code point, leave as-is
      }
    }
    return match;
  }

  // Hex numeric entity: &#xHHH;
  if (entity.startsWith('#x')) {
    const code = parseInt(entity.substring(2), 16);
    if (!isNaN(code) && code > 0) {
      try {
        return String.fromCodePoint(code);
      } catch (e) {
        return match; // invalid code point, leave as-is
      }
    }
    return match;
  }

  // Named entity
  if (NAMED_ENTITIES[entity] !== undefined) {
    return NAMED_ENTITIES[entity];
  }

  // Unknown named entity — leave as-is
  return match;
}

/**
 * Decode all HTML entities in a string.
 * Runs multiple passes to handle nested entities like &amp;#039;
 */
function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return str;

  let result = str;
  let previous;
  // Multiple passes to handle double-encoded entities (e.g., &amp;#039; -> &#039; -> ')
  let maxPasses = 5;
  do {
    previous = result;
    result = result.replace(ENTITY_REGEX, decodeEntity);
    maxPasses--;
  } while (result !== previous && maxPasses > 0);

  return result;
}

/**
 * Recursively walk a JSON value and decode all HTML entities in every string.
 * Returns { value, changes } where changes is an array of { field, old, new }.
 */
function decodeDeep(obj, pathPrefix) {
  const changes = [];

  if (typeof obj === 'string') {
    const decoded = decodeHtmlEntities(obj);
    if (decoded !== obj) {
      const oldDisplay = obj.length > 120 ? obj.substring(0, 120) + '...' : obj;
      const newDisplay = decoded.length > 120 ? decoded.substring(0, 120) + '...' : decoded;
      changes.push({ field: pathPrefix, old: oldDisplay, new: newDisplay });
      return { value: decoded, changes };
    }
    return { value: obj, changes };
  }

  if (Array.isArray(obj)) {
    let anyChanged = false;
    const newArr = obj.map((item, i) => {
      const result = decodeDeep(item, `${pathPrefix}[${i}]`);
      if (result.changes.length > 0) {
        anyChanged = true;
        changes.push(...result.changes);
      }
      return result.value;
    });
    return { value: anyChanged ? newArr : obj, changes };
  }

  if (obj !== null && typeof obj === 'object') {
    let anyChanged = false;
    const newObj = {};
    for (const key of Object.keys(obj)) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const result = decodeDeep(obj[key], childPath);
      newObj[key] = result.value;
      if (result.changes.length > 0) {
        anyChanged = true;
        changes.push(...result.changes);
      }
    }
    return { value: anyChanged ? newObj : obj, changes };
  }

  // numbers, booleans, null — return as-is
  return { value: obj, changes };
}

/**
 * Recursively find all JSON files under a directory.
 */
function findJsonFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'failed-fetches.json') {
      results.push(fullPath);
    }
  }
  return results;
}

// Main
const reviewTextsDir = path.resolve(__dirname, '..', 'data', 'review-texts');

if (!fs.existsSync(reviewTextsDir)) {
  console.error(`Directory not found: ${reviewTextsDir}`);
  process.exit(1);
}

console.log(`Scanning ${reviewTextsDir} for HTML entities...`);
if (DRY_RUN) {
  console.log('(DRY RUN — no files will be modified)\n');
} else {
  console.log('');
}

const jsonFiles = findJsonFiles(reviewTextsDir);
console.log(`Found ${jsonFiles.length} JSON files to scan.\n`);

let totalFilesChanged = 0;
let totalFieldsChanged = 0;
const changedFiles = [];

for (const filePath of jsonFiles) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`  Error reading ${filePath}: ${e.message}`);
    continue;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`  Error parsing ${filePath}: ${e.message}`);
    continue;
  }

  const { value: decoded, changes } = decodeDeep(data, '');

  if (changes.length > 0) {
    totalFilesChanged++;
    totalFieldsChanged += changes.length;
    const relPath = path.relative(path.resolve(__dirname, '..'), filePath);
    changedFiles.push(relPath);
    console.log(`FIXED: ${relPath}`);
    for (const change of changes) {
      console.log(`  ${change.field}:`);
      console.log(`    OLD: ${change.old}`);
      console.log(`    NEW: ${change.new}`);
    }
    console.log('');

    if (!DRY_RUN) {
      const output = JSON.stringify(decoded, null, 2) + '\n';
      fs.writeFileSync(filePath, output, 'utf8');
    }
  }
}

console.log('='.repeat(60));
console.log(`SUMMARY`);
console.log(`  Files scanned:  ${jsonFiles.length}`);
console.log(`  Files changed:  ${totalFilesChanged}`);
console.log(`  Fields changed: ${totalFieldsChanged}`);
if (DRY_RUN) {
  console.log(`  Mode: DRY RUN (no files written)`);
} else {
  console.log(`  Mode: LIVE (files updated in place)`);
}
console.log('='.repeat(60));

if (changedFiles.length > 0) {
  console.log('\nChanged files:');
  for (const f of changedFiles) {
    console.log(`  ${f}`);
  }
}
