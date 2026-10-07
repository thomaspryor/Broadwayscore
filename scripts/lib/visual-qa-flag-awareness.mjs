// scripts/lib/visual-qa-flag-awareness.mjs — demo-only feature-flag detection for visual-qa.mjs
//
// Root cause of #950: a dev server started with a DEMO_FEATURES flag ON
// renders components production never reaches, and visual-qa had no idea
// which flags produced the screenshots it was grading. On 2026-08-03 this
// shipped ShowHeroRedesign.tsx invisible in production — visual-qa returned
// overallPass=true because the dev server (correctly, for QA purposes) had
// showPageRedesign ON, and nothing checked that flag against DEMO_FEATURES.
//
// Two ways a changed file's rendering can depend on a demo-only flag:
//   1. Direct — the file itself reads `featureFlags.<name>`.
//   2. Indirect — the file is gated from the IMPORTING file, e.g.
//      `<RedesignOn><ShowHeroRedesign .../></RedesignOn>` in page.tsx. The
//      component file itself never mentions the flag; only its caller does.
// The 2026-08-03 incident was case 2, so direct-only detection would have
// missed it — findImporterGatingFlags() is the part that actually matters.
//
// Known limitations (heuristic text matching, not AST/control-flow analysis —
// found by adversarial review of this file, kept as deliberate scope, not bugs):
//   - Ancestor/layout gates (e.g. a route wrapped by a redirecting layout N
//     levels up) are invisible unless the changed file itself imports the gate.
//   - Import matching is by basename + default-export name, so renamed
//     imports, barrel re-exports, and dynamic() imports aren't followed.
//   - Only DIRECTLY-imported gating is checked, one hop from the changed file.
// These trade recall for precision deliberately: a missed warning is a no-op
// (today's status quo), a false positive blocks a legitimate ship. See
// hasEarlyReturnNullGate() below for the false-positive fix that mattered.

const FLAG_REF_RE = /featureFlags\.(\w+)/g;

// Chars to look back from a component's JSX usage site for a gating marker.
// Large enough to span a multi-line <RedesignOn> wrapper or a `{featureFlags.x &&`
// conditional with a few lines of JSX in between; small enough to avoid
// picking up unrelated flags earlier in a long file.
const GATE_WINDOW = 600;

/** Parse `const DEMO_FEATURES = new Set([...])` out of feature-flags.ts source. */
export function parseDemoFeatures(sourceText) {
  const m = sourceText.match(/DEMO_FEATURES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** All `featureFlags.<name>` references in a file's own content. */
export function extractDirectFlagRefs(fileContent) {
  const flags = new Set();
  let m;
  FLAG_REF_RE.lastIndex = 0;
  while ((m = FLAG_REF_RE.exec(fileContent))) flags.add(m[1]);
  return flags;
}

// Merely REFERENCING a flag doesn't mean the file is gated by it — e.g.
// UserProviders.tsx checks featureFlags.userAccounts to pick which providers
// to wrap children in, but renders those children (real content) either way.
// Only an early-return-null bail-out means "nothing renders without the
// flag" — every real gate in this repo (HeaderUserIcon, RedesignGate,
// ShowPageWatchlistButton, ...) follows this `if (...featureFlags.X...)
// return null;` shape. Requiring it here avoids flagging always-rendered
// wrapper components as demo-gated (found by adversarial review of #950).
export function hasEarlyReturnNullGate(fileContent, flag) {
  const re = new RegExp(
    `if\\s*\\([^)]*featureFlags\\.${flag}\\b[^)]*\\)\\s*(?:return\\s+null\\s*;|\\{[^}]{0,200}?return\\s+null\\s*;)`
  );
  return re.test(fileContent);
}

/** Best-effort default-export identifier, falling back to the file's basename. */
export function getDefaultExportName(fileContent, filePath) {
  let m = fileContent.match(/export default function (\w+)/);
  if (m) return m[1];
  m = fileContent.match(/export default class (\w+)/);
  if (m) return m[1];
  m = fileContent.match(/export default (\w+)\s*;/);
  if (m) return m[1];
  return basenameNoExt(filePath);
}

function basenameNoExt(p) {
  return p.split('/').pop().replace(/\.(tsx|ts|jsx|js)$/, '');
}

/**
 * Does `importerContent` render <componentName ...> inside a window that
 * also gates on a demo-only flag? Two patterns recognized:
 *   - `{featureFlags.<flag> && ... <Component`
 *   - `<RedesignOn> ... <Component` with no intervening `</RedesignOn>`
 * Returns the subset of `demoFeatures` found gating this usage.
 */
export function findImporterGatingFlags(importerContent, componentName, demoFeatures) {
  const found = new Set();
  const usageRe = new RegExp(`<${componentName}[\\s/>]`, 'g');
  let m;
  while ((m = usageRe.exec(importerContent))) {
    const start = Math.max(0, m.index - GATE_WINDOW);
    const windowText = importerContent.slice(start, m.index);

    for (const flag of demoFeatures) {
      const flagRe = new RegExp(`featureFlags\\.${flag}\\b`);
      if (flagRe.test(windowText)) found.add(flag);
    }

    if (demoFeatures.includes('showPageRedesign')) {
      const lastOpen = windowText.lastIndexOf('<RedesignOn>');
      const lastClose = windowText.lastIndexOf('</RedesignOn>');
      if (lastOpen !== -1 && lastOpen > lastClose) found.add('showPageRedesign');
    }
  }
  return found;
}

/**
 * Main orchestrator. changedFiles/sourceFiles: [{path, content}].
 * Returns findings only for flags that are BOTH demo-only AND present in
 * runFeatures — i.e. the run actually rendered this file via a flag
 * production will never have on (CLAUDE.md #950 acceptance: "the run had it ON").
 */
export function detectFlagGatedChangedFiles({ changedFiles, sourceFiles, demoFeatures, runFeatures }) {
  const runSet = new Set(runFeatures || []);
  const findings = [];

  for (const changed of changedFiles) {
    const flags = new Set();
    for (const f of extractDirectFlagRefs(changed.content)) {
      if (demoFeatures.includes(f) && hasEarlyReturnNullGate(changed.content, f)) flags.add(f);
    }

    const componentName = getDefaultExportName(changed.content, changed.path);
    const via = [];
    const changedBasename = basenameNoExt(changed.path);
    const importRe = new RegExp(`from\\s+['"][^'"]*${changedBasename}['"]`);

    for (const src of (sourceFiles || [])) {
      if (src.path === changed.path) continue;
      if (!importRe.test(src.content)) continue;
      const gated = findImporterGatingFlags(src.content, componentName, demoFeatures);
      for (const f of gated) {
        flags.add(f);
        via.push({ importer: src.path, flag: f });
      }
    }

    const activeDemoFlags = [...flags].filter(f => runSet.has(f));
    if (activeDemoFlags.length > 0) {
      findings.push({
        file: changed.path,
        flags: activeDemoFlags,
        via: via.filter(v => activeDemoFlags.includes(v.flag)).map(v => v.importer),
      });
    }
  }

  return findings;
}
