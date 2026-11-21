import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { require: tsxRequire } = require('tsx/cjs/api');
const React = require('react');
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const parse = (path) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
const calls = (root, name) => nodes(root, (n) => ts.isCallExpression(n) && n.expression.getText() === name);
const compact = (node) => node.getText().replace(/\s+/g, '');

const components = [
  'src/components/EmailCaptureModal.tsx',
  'src/contexts/ProGateContext.tsx',
  'src/components/fantasy/FantasyShareButton.tsx',
  'src/components/HeaderSearch.tsx',
  'src/components/ads/AdSlot.tsx',
  'src/app/fantasy/create-league/page.tsx',
  'src/app/fantasy/draft/page.tsx',
];
for (const path of components) {
  test(`${path}: each PostHog call has GA4 parity in the same execution block`, () => {
    const source = parse(path);
    assert.match(read(path), /import \{ gaEvent \} from '@\/lib\/analytics\/ga-event'/);
    const posthog = calls(source, 'captureEvent');
    const ga = calls(source, 'gaEvent');
    assert.ok(posthog.length);
    assert.equal(ga.length, posthog.length, 'one GA event per existing PostHog call');
    for (const call of posthog) {
      const match = ga.find((g) => compact(g.arguments[0]) === compact(call.arguments[0])
        && g.parent.parent === call.parent.parent);
      assert.ok(match, `missing GA4 event: ${call.arguments[0].getText()}`);
      if (call.arguments[0].getText() === "'search_performed'") {
        assert.doesNotMatch(match.arguments[1].getText(), /\bquery\s*:/, 'free-text queries can contain PII');
        for (const key of ['results_count', 'has_results', 'fuzzy_only']) {
          assert.ok(match.arguments[1].getText().includes(key), `missing ${key}`);
        }
      } else {
        assert.equal(compact(match.arguments[1]), compact(call.arguments[1]), 'safe event properties stay in parity');
      }
    }
  });
}

const pages = [
  ['src/app/partners/PartnersPageClient.tsx', 1],
  ['src/app/embed/page.tsx', 2],
  ['src/app/beat-the-critics/rules/page.tsx', 1],
  ['src/app/research/critic-audience-divergence-2026/page.tsx', 1],
];
for (const [path, count] of pages) {
  test(`${path}: all existing mailto links use the tracked client component`, () => {
    const source = parse(path);
    const links = nodes(source, (n) => ts.isJsxOpeningElement(n) && n.attributes.properties.some(
      (p) => ts.isJsxAttribute(p) && p.name.getText() === 'href'
        && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text.startsWith('mailto:'),
    ));
    assert.equal(links.length, count);
    for (const link of links) assert.equal(link.tagName.getText(), 'MailtoLink');
    assert.match(read(path), /import MailtoLink from '@\/components\/MailtoLink'/);
  });
}

// Invoke the actual client component with a ref hook stub. Only the
// browser, clock and transport are faked; its click handler and gaEvent are real.
function mailtoHarness(t, gtag) {
  // tsx uses the classic JSX transform for this Next.js jsx:preserve config.
  const oldReact = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  t.after(() => {
    if (oldReact) Object.defineProperty(globalThis, 'React', oldReact);
    else delete globalThis.React;
  });
  const MailtoLink = tsxRequire('../../src/components/MailtoLink.tsx', import.meta.url).default;
  t.mock.method(React, 'useRef', (value) => ({ current: value }));
  const element = MailtoLink({ href: 'mailto:contact@example.com', children: 'Email us', className: 'underline' });
  const navigations = [];
  const posthog = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    location: { pathname: '/partners', set href(value) { navigations.push(value); } },
    gtag,
    posthog: { capture: (...args) => posthog.push(args) },
  } });
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete globalThis.window;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  return { element, navigations, posthog, click: () => element.props.onClick({ preventDefault() {} }) };
}

test('mailto sends a beacon with no address, waits for acknowledgement, and opens once', (t) => {
  const ga = [];
  const h = mailtoHarness(t, (...args) => ga.push(args));
  assert.equal(h.element.props.href, 'mailto:contact@example.com', 'preserve the no-JS destination');
  assert.equal(h.element.props.className, 'underline');
  h.click();
  h.click();
  assert.equal(ga.length, 1, 'double-click must not send or navigate twice');
  assert.equal(h.posthog.length, 1);
  assert.equal(ga[0][0], 'event');
  assert.equal(ga[0][1], 'email_link_click');
  assert.equal(ga[0][2].page_path, '/partners');
  assert.equal(ga[0][2].transport_type, 'beacon');
  assert.equal(ga[0][2].event_timeout, 400);
  assert.doesNotMatch(JSON.stringify([ga, h.posthog]), /@|mailto:/);
  assert.deepEqual(h.navigations, []);
  ga[0][2].event_callback();
  t.mock.timers.tick(400);
  ga[0][2].event_callback();
  assert.deepEqual(h.navigations, ['mailto:contact@example.com']);
});

test('mailto still opens when GA is blocked or throws', (t) => {
  const h = mailtoHarness(t, () => { throw new Error('blocked'); });
  h.click();
  t.mock.timers.tick(399);
  assert.equal(h.navigations.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(h.navigations, ['mailto:contact@example.com']);
});

test('late GA initialization sends the queued event without opening the mail app twice', (t) => {
  const h = mailtoHarness(t, undefined);
  h.click();
  t.mock.timers.tick(400);
  assert.equal(h.navigations.length, 1);
  const ga = [];
  window.gtag = (...args) => ga.push(args);
  t.mock.timers.tick(250);
  assert.equal(ga.length, 1);
  ga[0][2].event_callback();
  assert.equal(h.navigations.length, 1);
});
