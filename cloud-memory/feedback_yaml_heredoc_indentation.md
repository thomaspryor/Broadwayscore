---
name: feedback_yaml_heredoc_indentation
description: GHA heredoc content that starts at column 0 inside an indented run block breaks YAML parsing — causes actionlint/CI failures
metadata: 
  node_type: memory
  type: feedback
  originSessionId: da27bcff-8389-4b8a-a2dc-04abe1f690bc
---

Keep all content inside GHA `run: |` heredocs indented to match the YAML block (≥10 spaces for typical nested steps). Template literal backtick strings or multi-line strings that start at column 0 are interpreted as YAML structure, not heredoc content.

**Why:** investigate-alert.yml shipped with a YAML parse error on first push — the `node << 'SCRIPT'` heredoc contained JS strings starting at column 0. A parallel session had to fix it (commit 99d136c442).

**How to apply:** When writing `node << 'EOF'` blocks in GHA workflows, either keep all content indented ≥10 spaces, or use `array.join('\n')` for multi-line strings that would naturally start at column 0. Lint locally with `actionlint` before pushing workflow files with large heredocs.
