// Full-corpus index of cloud-memory/ (BRO-2556).
//
// cloud-memory/MEMORY.md is a hook-capped (180 line) curated entry point, so
// it lists only a fraction of the notes. Cloud sessions have no recall tool,
// so this reads every note's frontmatter (name + description) straight from
// the files: never stale, nothing generated, nothing for the Mac sync to adopt.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['MEMORY.md']);

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description|type):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function firstLine(text) {
  for (const l of text.split(/\r?\n/)) {
    const t = l.replace(/^#+\s*/, '').trim();
    if (t && t !== '---') return t.slice(0, 200);
  }
  return '';
}

function buildIndex(dir) {
  const entries = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || SKIP.has(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const fm = parseFrontmatter(text);
    entries.push({
      file,
      name: fm.name || file.replace(/\.md$/, ''),
      description: fm.description || firstLine(text),
      type: fm.type || '',
    });
  }
  return entries;
}

// Every term must appear (case-insensitive) in file name, name or description.
function searchIndex(entries, terms) {
  const ts = terms.map((t) => t.toLowerCase()).filter(Boolean);
  return entries.filter((e) => {
    const hay = `${e.file} ${e.name} ${e.description}`.toLowerCase();
    return ts.every((t) => hay.includes(t));
  });
}

function formatEntry(e) {
  return `${e.file} | ${e.description}`;
}

module.exports = { buildIndex, searchIndex, parseFrontmatter, formatEntry };
