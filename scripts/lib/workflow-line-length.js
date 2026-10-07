'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LINE_LENGTH = 500;
const EXEMPT_MARKER = '# workflow-line-length-ok:';

// Guards against the class of bug in task #763: a single YAML line holding a
// space-separated list (e.g. `node --test a.mjs b.mjs c.mjs ...`) grows one
// filename at a time as sessions add tests, so any two parallel edits touch
// the exact same line and are a guaranteed git merge conflict. Long lines
// that aren't append-growing lists (e.g. one embedded script one-liner) can
// opt out with an inline `# workflow-line-length-ok: <reason>` comment.
function findLongLines(workflowsDir, maxLength = MAX_LINE_LENGTH) {
  const violations = [];
  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const fullPath = path.join(workflowsDir, file);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (line.length > maxLength && !line.includes(EXEMPT_MARKER)) {
        violations.push({ file, line: idx + 1, length: line.length });
      }
    });
  }

  return violations;
}

module.exports = { findLongLines, MAX_LINE_LENGTH, EXEMPT_MARKER };
