#!/usr/bin/env node

/**
 * Fix corrupted JSON files that have unescaped quotes inside string values.
 *
 * The issue: fullText and bwwExcerpt fields contain literal " characters
 * that should be escaped as \" in JSON.
 */

const fs = require('fs');

const corruptedFiles = [
  'data/review-texts/cabaret-2024/ny-stage-review--frank-scheck.json',
  'data/review-texts/suffs-2024/theatrely--juan-a-ramirez.json',
  'data/review-texts/stranger-things-2024/ny-stage-review--bob-verini.json',
  'data/review-texts/hells-kitchen-2024/new-york-theater--jonathan-mandell.json',
  'data/review-texts/hells-kitchen-2024/ny-stage-review--melissa-rose-bernardo.json',
  'data/review-texts/hells-kitchen-2024/cititour--brian-scott-lipton.json',
  'data/review-texts/buena-vista-social-club-2025/theatrely--kobi-kassal.json',
  'data/review-texts/oedipus-2025/cititour--brian-scott-lipton.json',
  'data/review-texts/operation-mincemeat-2025/culture-sauce--thom-geier.json',
  'data/review-texts/chess-2025/ny-stage-review--bob-verini.json',
  'data/review-texts/chess-2025/ny-stage-review--melissa-rose-bernardo.json',
  'data/review-texts/just-in-time-2025/new-york-theater--jonathan-mandell.json',
  'data/review-texts/just-in-time-2025/cititour--brian-scott-lipton.json',
  'data/review-texts/mamma-mia-2025/new-york-theater--jonathan-mandell.json',
  'data/review-texts/the-great-gatsby-2024/cititour--brian-scott-lipton.json'
];

/**
 * Fix a string field by properly escaping quotes
 */
function fixStringField(content, fieldName) {
  // Match the field pattern: "fieldName": "value"
  // We need to find where the value starts and ends
  const fieldPattern = new RegExp(`"${fieldName}":\\s*"`);
  const match = content.match(fieldPattern);

  if (!match) return content;

  const fieldStart = match.index + match[0].length;

  // Find the end of this string value by looking for the pattern: ",\n  " or "\n}"
  // But we need to track if we're inside the string or not
  let pos = fieldStart;
  let result = content.slice(0, fieldStart);
  let valueContent = '';

  while (pos < content.length) {
    const char = content[pos];
    const nextChar = content[pos + 1];
    const nextTwo = content.slice(pos, pos + 3);
    const nextFour = content.slice(pos, pos + 5);

    // Check for end of string value patterns
    if (char === '"' && (nextTwo === '",\n' || nextTwo === '"\n}' || nextFour === '",\n ')) {
      // This is the closing quote of the field
      // Escape any unescaped quotes in the collected value
      valueContent = valueContent.replace(/(?<!\\)"/g, '\\"');
      result += valueContent + content.slice(pos);
      return result;
    }

    valueContent += char;
    pos++;
  }

  return content;
}

/**
 * Extract and fix a JSON file by manually parsing long string fields
 */
function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Fields that commonly have embedded quotes
  const fieldsToFix = ['fullText', 'bwwExcerpt', 'dtliExcerpt', 'showScoreExcerpt'];

  for (const field of fieldsToFix) {
    content = fixStringField(content, field);
  }

  // Verify
  JSON.parse(content);
  return content;
}

/**
 * Alternative approach: Use regex to find and fix the problematic parts
 */
function fixFileV2(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const fixedLines = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check if this line contains a string field that might have issues
    // Pattern: "fieldName": "value" where value might span multiple...
    // Actually, let's check if the line has an odd number of unescaped quotes

    // Check if line starts a multiline string (ends with unclosed quote)
    if (line.match(/^\s*"(fullText|bwwExcerpt|dtliExcerpt|showScoreExcerpt)":\s*"/)) {
      // This is a potentially problematic field
      // Collect all content until we find the proper closing pattern
      let fullValue = line;
      let j = i + 1;

      // Look for the closing pattern
      while (j < lines.length && !lines[j - 1].match(/",?$/)) {
        fullValue += '\n' + lines[j];
        j++;
      }

      // Actually, let's try a simpler approach
    }

    fixedLines.push(line);
  }

  return fixedLines.join('\n');
}

/**
 * Simplest approach: manually fix each field using known structure
 */
function fixFileV3(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Split by the known field boundaries
  // We know the structure: each field is on its own line or spans lines
  // The issue is quotes inside "fullText" and "bwwExcerpt" values

  // Strategy: Find each problematic field, extract its raw value, escape quotes, rebuild
  const obj = {};

  // Parse line by line, tracking current field
  const lines = content.split('\n');
  let currentField = null;
  let currentValue = '';
  let inString = false;

  for (const line of lines) {
    // Try to match a field start
    const fieldMatch = line.match(/^\s*"([^"]+)":\s*(.*)$/);

    if (fieldMatch && !inString) {
      // Save previous field if any
      if (currentField) {
        obj[currentField] = currentValue;
      }

      currentField = fieldMatch[1];
      const valueStart = fieldMatch[2];

      if (valueStart.startsWith('"')) {
        // String value - might span multiple lines
        if (valueStart.match(/^".*",?$/) && valueStart.split('"').length % 2 === 1) {
          // Complete string on one line
          currentValue = valueStart;
          currentField = null;
        } else {
          inString = true;
          currentValue = valueStart;
        }
      } else {
        currentValue = valueStart;
        currentField = null;
      }
    } else if (inString) {
      currentValue += '\n' + line;
      // Check if string ends on this line
      if (line.match(/^.*",?\s*$/)) {
        // Might be end of string
        obj[currentField] = currentValue;
        currentField = null;
        inString = false;
      }
    }
  }

  // This is getting complex. Let's try the nuclear option:
  // Read the file, manually identify the JSON structure, and rebuild it
  return null;
}

/**
 * Nuclear option: Read raw bytes and manually extract/fix each field
 */
function fixFileNuclear(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // We know the expected structure. Extract each field value carefully.
  const result = {};

  // Helper to extract a string value starting at position
  function extractString(str, startPos) {
    let pos = startPos;
    let value = '';
    let escaped = false;

    while (pos < str.length) {
      const char = str[pos];

      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === '\\') {
        value += char;
        escaped = true;
      } else if (char === '"') {
        // Check if this is a field terminator
        const remaining = str.slice(pos);
        if (remaining.match(/^",?\s*\n\s*"[a-zA-Z]/) || remaining.match(/^"\s*\n\}/)) {
          return { value, endPos: pos };
        }
        // Otherwise it's an unescaped quote inside the string - that's our bug!
        value += '\\"';  // Escape it
      } else {
        value += char;
      }
      pos++;
    }
    return { value, endPos: pos };
  }

  // Find and process each field
  const fieldRegex = /"([^"]+)":\s*/g;
  let match;
  let lastEnd = 0;
  let output = '';

  while ((match = fieldRegex.exec(raw)) !== null) {
    const fieldName = match[1];
    const valueStart = match.index + match[0].length;

    // Add everything before this field
    output += raw.slice(lastEnd, valueStart);

    const firstChar = raw[valueStart];

    if (firstChar === '"') {
      // String value
      const { value, endPos } = extractString(raw, valueStart + 1);
      output += '"' + value + '"';
      lastEnd = endPos + 1;
      fieldRegex.lastIndex = lastEnd;
    } else if (firstChar === 'n') {
      // null
      output += 'null';
      lastEnd = valueStart + 4;
      fieldRegex.lastIndex = lastEnd;
    } else if (firstChar === 't') {
      // true
      output += 'true';
      lastEnd = valueStart + 4;
      fieldRegex.lastIndex = lastEnd;
    } else if (firstChar === 'f') {
      // false
      output += 'false';
      lastEnd = valueStart + 5;
      fieldRegex.lastIndex = lastEnd;
    } else if (firstChar.match(/[0-9-]/)) {
      // Number - find end
      const numMatch = raw.slice(valueStart).match(/^-?[0-9.]+/);
      output += numMatch[0];
      lastEnd = valueStart + numMatch[0].length;
      fieldRegex.lastIndex = lastEnd;
    }
  }

  // Add any remaining content
  output += raw.slice(lastEnd);

  // Verify
  JSON.parse(output);
  return output;
}

let fixed = 0;
let failed = 0;

for (const file of corruptedFiles) {
  try {
    const fixedContent = fixFileNuclear(file);
    fs.writeFileSync(file, fixedContent);
    console.log('✓ Fixed:', file);
    fixed++;
  } catch (e) {
    console.log('✗ Failed:', file, '-', e.message);
    failed++;
  }
}

console.log('\n---');
console.log('Fixed:', fixed);
console.log('Failed:', failed);
