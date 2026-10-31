/**
 * notion-residue-scan.js — pure source-text scan for live code paths that
 * still talk to the retired Notion board (BRO-3018 sweep).
 *
 * Existing notion-write-paths-audit.js only catches `.pages.create(` in files
 * that import @notionhq/client. The sweep found four more channels, so this
 * classifies every channel a file can use to reach Notion:
 *   sdk-write   — @notionhq/client mutation (pages/blocks/comments/databases)
 *   http        — raw api.notion.com / NOTION_BASE request
 *   helper      — imports the repo's own Notion write helpers / createNotionPage
 *   brain-cli   — invokes scripts/notion-brain.js with a create/update verb
 *
 * Comments are stripped FIRST: every guard that argues against Notion quotes
 * the thing it forbids, and four prior checks false-positived on their own
 * comment. No fs, no process.exit (CLAUDE.md rule 15).
 */
'use strict';

function stripComments(src, kind = 'js') {
  let s = String(src);
  if (kind === 'xml') return s.replace(/<!--[\s\S]*?-->/g, '');
  if (kind === 'md') return s; // prompts are scanned verbatim: prose IS the code
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return s
    .split('\n')
    .map((line) => {
      let out = line.replace(/(^|[\s;{}(),])\/\/.*$/, '$1');
      if (kind === 'sh' || kind === 'yml') out = out.replace(/(^|\s)#.*$/, '$1');
      return out;
    })
    .join('\n');
}

function kindOf(file) {
  if (/\.(plist|xml)$/.test(file)) return 'xml';
  if (/\.(sh|bash)$/.test(file)) return 'sh';
  if (/\.ya?ml$/.test(file)) return 'yml';
  if (/\.(md|txt)$/.test(file)) return 'md';
  return 'js';
}

const SDK_WRITE = /\.(pages\.(create|update)|blocks\.children\.append|blocks\.(update|delete)|comments\.create|databases\.(create|update))\s*\(/;
const HTTP = /api\.notion\.com|\bNOTION_BASE\b/;
const HELPER = /(require\(|from\s+)['"][^'"]*\b(notion-writes|notion-api|notion-create-safety)(\.[jt]s)?['"]|\bcreateNotionPage\b|\bnotion\.request\(/;
const BRAIN_REF = /notion-brain(\.js)?\b/;
// js: the verb is a quoted argv element. md/sh/yml: command form only, so a
// prompt that merely forbids Notion ("never use notion-brain.js") is clean.
const BRAIN_VERB_JS = /['"`](create|update)['"`]/;
const BRAIN_CMD = /notion-brain(\.js)?['"`]?\s+(create|update)\b/;

/** @returns {string[]} channel names this file's live code uses (sorted) */
function notionChannels(source, file = 'x.js') {
  const kind = kindOf(file);
  const code = stripComments(source, kind);
  const out = [];
  if (SDK_WRITE.test(code)) out.push('sdk-write');
  if (HTTP.test(code)) out.push('http');
  if (HELPER.test(code)) out.push('helper');
  const verb = kind === 'js' ? BRAIN_VERB_JS : BRAIN_CMD;
  if (BRAIN_REF.test(code) && (verb.test(code) || BRAIN_CMD.test(code))) out.push('brain-cli');
  return out.sort();
}

module.exports = { notionChannels, stripComments, kindOf };
