// visual-qa is feature-flag blind (#950): a changed file gated behind a
// DEMO_FEATURES flag (directly, or indirectly via a <RedesignOn> wrapper in
// its importer) must be flagged when the visual-qa run had that flag ON —
// otherwise the run silently PASSes a component production never renders,
// which is exactly what shipped ShowHeroRedesign.tsx invisible on 2026-08-03.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseDemoFeatures,
  extractDirectFlagRefs,
  hasEarlyReturnNullGate,
  getDefaultExportName,
  findImporterGatingFlags,
  detectFlagGatedChangedFiles,
} from '../../scripts/lib/visual-qa-flag-awareness.mjs';

const FEATURE_FLAGS_SRC = `
const DEMO_FEATURES = new Set(['userAccounts', 'showPageRedesign', 'showtimes']);
`;

describe('parseDemoFeatures', () => {
  test('extracts the DEMO_FEATURES set from feature-flags.ts source', () => {
    assert.deepStrictEqual(parseDemoFeatures(FEATURE_FLAGS_SRC), ['userAccounts', 'showPageRedesign', 'showtimes']);
  });

  test('returns empty array when DEMO_FEATURES is not found', () => {
    assert.deepStrictEqual(parseDemoFeatures('const x = 1;'), []);
  });
});

describe('extractDirectFlagRefs', () => {
  test('finds featureFlags.<name> references in file content', () => {
    const content = `if (!featureFlags.userAccounts) return null;\nconst x = featureFlags.criticPages;`;
    assert.deepStrictEqual([...extractDirectFlagRefs(content)].sort(), ['criticPages', 'userAccounts']);
  });

  test('returns empty set when no flags referenced', () => {
    assert.deepStrictEqual([...extractDirectFlagRefs('export default function Foo() { return null; }')], []);
  });
});

describe('hasEarlyReturnNullGate', () => {
  test('matches the real early-return-null shape (HeaderUserIcon.tsx pattern)', () => {
    const content = `export default function HeaderUserIcon() {\n  if (!featureFlags.userAccounts) return null;\n  return <div />;\n}`;
    assert.strictEqual(hasEarlyReturnNullGate(content, 'userAccounts'), true);
  });

  test('matches a block-form early return (multi-statement if body)', () => {
    const content = `if (!featureFlags.userAccounts) {\n  console.log('gated');\n  return null;\n}`;
    assert.strictEqual(hasEarlyReturnNullGate(content, 'userAccounts'), true);
  });

  test('does NOT match a flag reference that still renders real content (UserProviders.tsx false-positive found by adversarial review)', () => {
    const content = `export default function UserProviders({ children }) {\n  if (!featureFlags.userAccounts) {\n    return <>{children}</>;\n  }\n  return <AuthProvider>{children}</AuthProvider>;\n}`;
    assert.strictEqual(hasEarlyReturnNullGate(content, 'userAccounts'), false);
  });

  test('does not match when the flag is referenced but unrelated to any return null', () => {
    const content = `const enabled = featureFlags.userAccounts;\nfunction other() { return null; }`;
    assert.strictEqual(hasEarlyReturnNullGate(content, 'userAccounts'), false);
  });
});

describe('getDefaultExportName', () => {
  test('reads a named function default export', () => {
    assert.strictEqual(getDefaultExportName('export default function ShowHeroRedesign() {}', 'x/y/z.tsx'), 'ShowHeroRedesign');
  });

  test('reads a re-exported identifier default export', () => {
    assert.strictEqual(getDefaultExportName('function Foo() {}\nexport default Foo;', 'x/y/z.tsx'), 'Foo');
  });

  test('falls back to file basename when no default export is found', () => {
    assert.strictEqual(getDefaultExportName('export function Foo() {}', 'src/components/Bar.tsx'), 'Bar');
  });
});

describe('findImporterGatingFlags', () => {
  const demoFeatures = ['userAccounts', 'showPageRedesign'];

  test('detects <RedesignOn> wrapping a component usage (the ShowHeroRedesign incident)', () => {
    const importer = `
      import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
      import { RedesignOn, RedesignOff } from '@/components/show-page/RedesignGate';
      export default function Page() {
        return (
          <RedesignOn>
            <ShowHeroRedesign show={show} />
          </RedesignOn>
        );
      }
    `;
    const found = findImporterGatingFlags(importer, 'ShowHeroRedesign', demoFeatures);
    assert.deepStrictEqual([...found], ['showPageRedesign']);
  });

  test('does not flag usage inside <RedesignOff> (the legacy, always-reachable path)', () => {
    const importer = `
      <RedesignOff>
        <LegacyHero show={show} />
      </RedesignOff>
    `;
    const found = findImporterGatingFlags(importer, 'LegacyHero', demoFeatures);
    assert.deepStrictEqual([...found], []);
  });

  test('detects a {featureFlags.X && <Component>} conditional', () => {
    const importer = `
      {featureFlags.userAccounts && (
        <HeaderUserIcon />
      )}
    `;
    const found = findImporterGatingFlags(importer, 'HeaderUserIcon', demoFeatures);
    assert.deepStrictEqual([...found], ['userAccounts']);
  });

  test('does not flag a component rendered unconditionally', () => {
    const importer = `
      export default function Page() {
        return <Footer />;
      }
    `;
    const found = findImporterGatingFlags(importer, 'Footer', demoFeatures);
    assert.deepStrictEqual([...found], []);
  });
});

describe('detectFlagGatedChangedFiles', () => {
  const demoFeatures = ['userAccounts', 'showPageRedesign', 'showtimes'];

  test('flags a changed file gated indirectly via <RedesignOn> when the run had the flag ON', () => {
    const changedFiles = [{
      path: 'src/components/show-page/ShowHeroRedesign.tsx',
      content: 'export default function ShowHeroRedesign() { return null; }',
    }];
    const sourceFiles = [{
      path: 'src/app/show/[slug]/page.tsx',
      content: `
        import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
        import { RedesignOn } from '@/components/show-page/RedesignGate';
        <RedesignOn>
          <ShowHeroRedesign show={show} />
        </RedesignOn>
      `,
    }];
    const findings = detectFlagGatedChangedFiles({
      changedFiles, sourceFiles, demoFeatures, runFeatures: ['showPageRedesign'],
    });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].file, 'src/components/show-page/ShowHeroRedesign.tsx');
    assert.deepStrictEqual(findings[0].flags, ['showPageRedesign']);
    assert.deepStrictEqual(findings[0].via, ['src/app/show/[slug]/page.tsx']);
  });

  test('does NOT flag when the run did not have the gating flag on (acceptance: "the run had it ON")', () => {
    const changedFiles = [{
      path: 'src/components/show-page/ShowHeroRedesign.tsx',
      content: 'export default function ShowHeroRedesign() { return null; }',
    }];
    const sourceFiles = [{
      path: 'src/app/show/[slug]/page.tsx',
      content: `
        import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
        import { RedesignOn } from '@/components/show-page/RedesignGate';
        <RedesignOn>
          <ShowHeroRedesign show={show} />
        </RedesignOn>
      `,
    }];
    const findings = detectFlagGatedChangedFiles({
      changedFiles, sourceFiles, demoFeatures, runFeatures: [],
    });
    assert.deepStrictEqual(findings, []);
  });

  test('flags a changed file gated directly by its own featureFlags.<demoFlag> reference', () => {
    const changedFiles = [{
      path: 'src/components/HeaderUserIcon.tsx',
      content: `export default function HeaderUserIcon() {\n  if (!featureFlags.userAccounts) return null;\n  return <div />;\n}`,
    }];
    const findings = detectFlagGatedChangedFiles({
      changedFiles, sourceFiles: [], demoFeatures, runFeatures: ['userAccounts'],
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].flags, ['userAccounts']);
  });

  test('does not flag a changed file with no flag gating at all', () => {
    const changedFiles = [{
      path: 'src/components/Footer.tsx',
      content: 'export default function Footer() { return <footer />; }',
    }];
    const findings = detectFlagGatedChangedFiles({
      changedFiles, sourceFiles: [], demoFeatures, runFeatures: ['userAccounts', 'showPageRedesign'],
    });
    assert.deepStrictEqual(findings, []);
  });

  test('does not flag a component gated only by a non-demo (launched) feature flag', () => {
    const changedFiles = [{
      path: 'src/components/GoldListBadge.tsx',
      content: `export default function GoldListBadge() {\n  if (!featureFlags.goldLists) return null;\n  return <div />;\n}`,
    }];
    const findings = detectFlagGatedChangedFiles({
      changedFiles, sourceFiles: [], demoFeatures, runFeatures: ['goldLists'],
    });
    assert.deepStrictEqual(findings, []);
  });
});
