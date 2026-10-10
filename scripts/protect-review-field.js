#!/usr/bin/env node
/**
 * CLI to add/remove/list per-file protectedFields on a review JSON file.
 * Usage:
 *   node scripts/protect-review-field.js --show=SHOW_ID --file=FILENAME --add=FIELD
 *   node scripts/protect-review-field.js --show=SHOW_ID --file=FILENAME --remove=FIELD
 *   node scripts/protect-review-field.js --show=SHOW_ID --file=FILENAME --list
 */

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  })
);

const { show, file, add, remove, list } = args;

if (!show || !file) {
  console.error('Usage: node scripts/protect-review-field.js --show=SHOW_ID --file=FILENAME [--add=FIELD|--remove=FIELD|--list]');
  process.exit(1);
}

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const filePath = path.join(REVIEW_TEXTS_DIR, show, file);

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
data.protectedFields = Array.isArray(data.protectedFields) ? data.protectedFields : [];

if (list || (!add && !remove)) {
  console.log(`protectedFields for ${show}/${file}:`);
  console.log(JSON.stringify(data.protectedFields, null, 2));
  process.exit(0);
}

if (add) {
  if (!data.protectedFields.includes(add)) {
    data.protectedFields.push(add);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    console.log(`Added "${add}" to protectedFields for ${show}/${file}`);
    console.log('protectedFields:', JSON.stringify(data.protectedFields));
  } else {
    console.log(`"${add}" already in protectedFields for ${show}/${file}`);
  }
}

if (remove) {
  const before = data.protectedFields.length;
  data.protectedFields = data.protectedFields.filter(f => f !== remove);
  if (data.protectedFields.length === 0) {
    delete data.protectedFields;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  if (data.protectedFields === undefined || data.protectedFields.length < before) {
    console.log(`Removed "${remove}" from protectedFields for ${show}/${file}`);
  } else {
    console.log(`"${remove}" was not in protectedFields for ${show}/${file}`);
  }
  console.log('protectedFields:', JSON.stringify(data.protectedFields ?? []));
}
