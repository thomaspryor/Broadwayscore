// BRO-2215: pure helpers for sampling the local task mirror's pending
// backlog against live Notion, to make the card's own acceptance
// measurement ("evenly-spaced sample of >=25 mirror-pending P1s, no more
// than 1 already-Done") a repeatable check instead of a one-off manual
// query. Used by scripts/audit-mirror-status-drift.js (the live-I/O CLI —
// not unit-tested here, same "pure logic vs I/O shell" split
// notion-tasks-sync.js itself uses for reconcileStaleMirrors/notionBrain).

// Fixed-stride sample across the FULL candidate range, not a prefix — a
// `.slice(0, n)` sample would only ever see the oldest-created tasks (task
// ids are assigned sequentially) and could hide drift concentrated in a
// newer/older slice. Deterministic (no Math.random(), which the workflow
// harness forbids and which would make a failing run irreproducible).
function evenlySpacedSample(candidates, sampleSize) {
  if (!Array.isArray(candidates) || !Number.isFinite(sampleSize) || sampleSize <= 0) return [];
  if (candidates.length <= sampleSize) return [...candidates];
  const step = candidates.length / sampleSize;
  const picked = [];
  const seenIdx = new Set();
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.min(candidates.length - 1, Math.floor(i * step));
    if (!seenIdx.has(idx)) { seenIdx.add(idx); picked.push(candidates[idx]); }
  }
  return picked;
}

// Extracts {id, pageId} for local mirror tasks matching a given status +
// priority label, from the raw task JSON shape notion-tasks-sync.js writes
// (description carries "[notion:<pageId>] <priority> · <status> · <category>").
// A task with no notion mapping (never pushed, or created by another tool)
// is skipped — reconciliation can't check something it can't map to a page.
function extractCandidates(taskEntries, { status, priorityLabel }) {
  const out = [];
  for (const t of taskEntries || []) {
    if (!t || t.status !== status) continue;
    const desc = t.description || '';
    if (priorityLabel && !desc.includes(priorityLabel)) continue;
    const m = desc.match(/\[notion:([a-f0-9-]+)\]/);
    if (!m) continue;
    out.push({ id: t.id, pageId: m[1] });
  }
  return out;
}

module.exports = { evenlySpacedSample, extractCandidates };
