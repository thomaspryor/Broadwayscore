#!/usr/bin/env node
// scripts/lib/check-claude-md-byte-cap.js
//
// Pure decision layer for BRO-124: CLAUDE.md must stay under
// scripts/lib/claude-md-anchors.json's byteLimit — the same check
// .github/workflows/test.yml's "Lint Workflows" job (Audit — CLAUDE.md
// integrity anchors + byte cap step) enforces, but that only runs in CI, so
// an overage previously surfaced only after push. scripts/hooks/pre-push
// calls this as a thin CLI (below) so the same decision runs locally before
// the push leaves the machine. Extracted per CLAUDE.md rule 15 (Test
// Extraction Pattern) so scripts/pre-push.test.mjs can require() the real
// function instead of re-implementing the byte-count logic in the test.

'use strict';

const fs = require('fs');

/**
 * @param {string} mdContent - CLAUDE.md content to check.
 * @param {{byteLimit?: number}} anchorsConfig - parsed claude-md-anchors.json.
 * @returns {{ok: boolean, bytes: number, limit: number|null}}
 */
function checkByteCap(mdContent, anchorsConfig) {
  const bytes = Buffer.byteLength(mdContent, 'utf8');
  const limit = anchorsConfig && anchorsConfig.byteLimit ? anchorsConfig.byteLimit : null;
  if (!limit) return { ok: true, bytes, limit: null };
  return { ok: bytes <= limit, bytes, limit };
}

module.exports = { checkByteCap };

if (require.main === module) {
  const anchorsPath = process.argv[2];
  if (!anchorsPath || !fs.existsSync(anchorsPath)) {
    // Fail open: no config to check against.
    process.exit(0);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  } catch {
    // Fail open: malformed/unreadable config shouldn't block a push.
    process.exit(0);
  }
  const md = fs.readFileSync(0, 'utf8'); // CLAUDE.md content piped via stdin
  const result = checkByteCap(md, cfg);
  if (!result.ok) {
    console.error(`CLAUDE.md is ${result.bytes}B, over the ${result.limit}B cap. Trim it or move detail to memory/.`);
    process.exit(1);
  }
  console.log(`CLAUDE.md OK: ${result.bytes}B <= ${result.limit}B`);
  process.exit(0);
}
