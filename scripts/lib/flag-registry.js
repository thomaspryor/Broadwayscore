/**
 * flag-registry.js — single source of truth for every PostHog feature flag
 * this codebase's client code depends on (card #250).
 *
 * Root incident (2026-07-12, discovered 07-20): the mobile-gate-timing A/B
 * client code, monitor cron, and guardrail emails all shipped, but the
 * PostHog flag itself was never created — flag creation was a manual step on
 * a separate card that no one executed. The client polled a nonexistent flag
 * 2,710 times across 8 days, every response null, and nothing detected the
 * mismatch. Root class: code-side and server-side of an experiment can
 * disagree and nothing compared them.
 *
 * This file is the registry (REGISTERED_FLAGS — every flag key referenced in
 * src/, with its EXPECTED PostHog state) plus the pure comparison functions:
 *   - extractReferencedFlagKeys(srcDir)  static scan of src/ for flag keys
 *     actually used by getFeatureFlag() calls (does file I/O — the scan
 *     itself, not the decisions below, per CLAUDE.md §15).
 *   - checkFlagParity(referenced, registry)  pure: which referenced keys
 *     have NO registry entry (this is what fails CI — see
 *     flag-registry.test.mjs and CLAUDE.md test-extraction pattern).
 *   - evaluateFlagHealth(liveFlag, expected)  pure: does a live PostHog flag
 *     match its registry-expected state (generalizes the flagHealth() check
 *     in analyze-gate-cold-start.js to every flag, not just gate-cold-start).
 *
 * Setup contract for new experiments: docs/experiments/README.md.
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// --- Registry ---
//
// expected.exists === false means "this key IS referenced in src/ but there
// is deliberately no live PostHog flag for it" — used for mobile-gate-timing,
// which the 2026-07-21 audit confirmed was NEVER created and is not coming
// back as a live split; the client's poll-then-fallback code always resolves
// to 'fallback' (control behavior) and is being treated as dead code, not an
// active experiment (see src/contexts/ProGateContext.tsx). Do NOT add a new
// entry with exists:false to duck a real missing-flag incident — that's
// exactly the failure mode this registry exists to catch. Only use it for a
// flag that has been explicitly investigated and confirmed non-live.
const REGISTERED_FLAGS = [
  {
    key: 'gate-cold-start',
    expected: {
      exists: true,
      active: true,
      variants: [{ key: 'control', pct: 50 }, { key: 'cold-start', pct: 50 }],
      rollout: 100,
    },
    ownerDoc: 'docs/experiments/gate-cold-start.md',
    note: 'Live A/B — email-gate 2-page minimum vs no minimum.',
  },
  {
    key: 'ticket-single-button',
    expected: {
      exists: true,
      active: true,
      variants: [{ key: 'multi', pct: 50 }, { key: 'single', pct: 50 }],
      rollout: 100,
    },
    ownerDoc: null,
    note: 'Live A/B — TicketButtonsAB.tsx multi-button vs single-button CTA.',
  },
  {
    key: 'ticket-primary-platform',
    expected: {
      exists: true,
      active: true,
      variants: [{ key: 'todaytix', pct: 100 }, { key: 'stubhub', pct: 0 }],
      rollout: 100,
    },
    ownerDoc: null,
    note: 'Concluded — pinned todaytix:100/stubhub:0. Not a live split; flag stays active so cached client state keeps resolving deterministically.',
  },
  {
    key: 'mobile-gate-timing',
    expected: { exists: false },
    ownerDoc: null,
    note: '2026-07-12 incident flag — confirmed via the PostHog API (2026-07-21 audit) to have never been created. No live split exists; the client-side poll-then-fallback code in ProGateContext.tsx always resolves to fallback/control behavior and is treated as a plain production dwell-gate, not an active experiment. See card #250.',
  },
];

// --- Static scan: which flag keys does src/ actually reference? ---

const CALL_RE = /getFeatureFlag\??\.?\(\s*([^)]+?)\s*\)/g;
const LITERAL_RE = /^['"]([^'"]+)['"]$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SCAN_EXTS = ['.ts', '.tsx'];

function walkFiles(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// A flag key is often passed as a string literal directly (TicketButtonsAB.tsx)
// or as an imported UPPER_SNAKE constant (ProGateContext.tsx's COLD_START_FLAG /
// MOBILE_GATE_FLAG, defined in src/lib/gate-logic.ts) — resolve constants by
// searching all scanned files for their `const IDENT = 'value'` definition.
// If two files define the SAME identifier name with DIFFERENT values, silently
// taking the first match risks misattributing a real getFeatureFlag() call to
// the wrong key (a false negative for the real flag — exactly the failure
// mode this scanner exists to prevent). Collect every definition found and
// only resolve when they agree; an ambiguous or absent definition returns
// null, which the caller reports as `unresolved` — loud, not silent.
function resolveIdentifier(ident, files, fileCache) {
  const defRe = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*['"]([^'"]+)['"]`, 'g');
  const values = new Set();
  for (const file of files) {
    const content = fileCache.get(file);
    defRe.lastIndex = 0;
    let m;
    while ((m = defRe.exec(content))) {
      values.add(m[1]);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}

/**
 * Static scan of srcDir for every flag key referenced via getFeatureFlag().
 * @returns {{ keys: Array<{key:string, files:string[]}>, unresolved: Array<{file:string, arg:string}> }}
 */
function extractReferencedFlagKeys(srcDir = SRC_DIR) {
  const files = walkFiles(srcDir, SCAN_EXTS);
  const fileCache = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const refs = new Map(); // key -> Set(relative file paths)
  const unresolved = [];

  for (const file of files) {
    const content = fileCache.get(file);
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(content))) {
      const arg = m[1].trim();
      let key = null;
      const litMatch = arg.match(LITERAL_RE);
      if (litMatch) {
        key = litMatch[1];
      } else if (IDENT_RE.test(arg)) {
        key = resolveIdentifier(arg, files, fileCache);
        if (!key) {
          unresolved.push({ file: path.relative(process.cwd(), file), arg });
          continue;
        }
      } else {
        unresolved.push({ file: path.relative(process.cwd(), file), arg });
        continue;
      }
      if (!refs.has(key)) refs.set(key, new Set());
      refs.get(key).add(path.relative(process.cwd(), file));
    }
  }

  return {
    keys: [...refs.entries()].map(([key, fileSet]) => ({ key, files: [...fileSet].sort() })),
    unresolved,
  };
}

/**
 * Pure: which referenced flag keys have no REGISTERED_FLAGS entry?
 * This is the CI enforcement gate — see flag-registry.test.mjs.
 * @param {Array<{key:string, files:string[]}>} referenced
 * @param {Array} registry
 */
function checkFlagParity(referenced, registry = REGISTERED_FLAGS) {
  const registeredKeys = new Set(registry.map((f) => f.key));
  const missing = referenced.filter((r) => !registeredKeys.has(r.key));
  return { missing };
}

function variantSplit(variants) {
  return (variants || []).map((v) => `${v.key}:${v.pct ?? v.rollout_percentage}`).sort().join(',');
}

/**
 * Pure: does a live PostHog flag object match its registry-expected state?
 * `liveFlag` shape: { active, variants: [{key,pct}], rollout } or null/undefined
 * if the flag doesn't exist in PostHog at all. Generalizes the flagHealth()
 * check in analyze-gate-cold-start.js to any registered flag.
 * @returns {{ ok: boolean, problem: string|null }}
 */
function evaluateFlagHealth(liveFlag, expected) {
  if (!expected.exists) {
    if (liveFlag) {
      return {
        ok: false,
        problem: `flag now EXISTS in PostHog but the registry expects it absent — either the registry is stale (update REGISTERED_FLAGS) or this is a re-launched experiment that needs a fresh registry entry with the intended state`,
      };
    }
    return { ok: true, problem: null };
  }
  if (!liveFlag) {
    return { ok: false, problem: 'FLAG DOES NOT EXIST — code referencing this flag is polling a null response (this exact failure shipped the mobile-gate-timing incident)' };
  }
  if (expected.active && !liveFlag.active) {
    return { ok: false, problem: 'flag exists but is INACTIVE — all traffic falling back' };
  }
  if (expected.variants) {
    const live = variantSplit(liveFlag.variants);
    const exp = variantSplit(expected.variants);
    if (live !== exp) {
      return { ok: false, problem: `variant split drifted from registered [${exp}] to [${live}]` };
    }
  }
  if (expected.rollout != null && liveFlag.rollout !== expected.rollout) {
    return { ok: false, problem: `release rollout is ${liveFlag.rollout}% (expected ${expected.rollout}%)` };
  }
  return { ok: true, problem: null };
}

module.exports = {
  REGISTERED_FLAGS,
  extractReferencedFlagKeys,
  checkFlagParity,
  evaluateFlagHealth,
  SRC_DIR,
};
