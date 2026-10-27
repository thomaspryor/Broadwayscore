import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});
const { renderToStaticMarkup } = require('react-dom/server');
const { JSDOM } = require('jsdom');
const BizHeader = require('../../src/components/biz/BizHeader.tsx').default;
const TopicPageShell = require('../../src/components/biz/TopicPageShell.tsx').default;
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const render = (component, props) => new JSDOM(renderToStaticMarkup(React.createElement(component, props))).window.document;

function assertHero(doc, title, tagline) {
  const header = doc.querySelector('header');
  assert.ok(header);
  const eyebrow = header.querySelector('span');
  assert.equal(eyebrow.textContent, 'The Broadway profitability database');
  for (const cls of ['rounded-full', 'border-brand/40', 'text-brand']) assert.ok(eyebrow.classList.contains(cls), cls);
  const heading = header.querySelector('h1');
  assert.equal(heading.textContent, title);
  for (const cls of ['text-4xl', 'sm:text-5xl', 'tracking-tight']) assert.ok(heading.classList.contains(cls), cls);
  const lead = heading.nextElementSibling;
  assert.equal(lead.textContent, tagline);
  for (const cls of ['text-xl', 'sm:text-2xl', 'text-gray-200']) assert.ok(lead.classList.contains(cls), cls);
  assert.equal(header.querySelectorAll('[data-testid="biz-share"]').length, 1);
}

test('shared hero renders the dashboard style and preserves supplemental content', () => {
  const doc = render(BizHeader, {
    title: '2024-2025 Season', tagline: 'Commercial data for all Broadway productions from this season',
    sharePath: '/biz/season/2024-2025',
    children: React.createElement('p', { 'data-testid': 'fine-print' }, 'Source notes and stats'),
  });
  assertHero(doc, '2024-2025 Season', 'Commercial data for all Broadway productions from this season');
  assert.equal(doc.querySelector('header [data-testid="fine-print"]').textContent, 'Source notes and stats');
  assert.equal(doc.querySelectorAll('h1').length, 1);
});

test('topic shell keeps the back link, sourcing, contact, share control and page body', () => {
  const doc = render(TopicPageShell, {
    title: 'Musicals Since Reopening', subtitle: 'Commercial musicals opened September 2021 to today.',
    sharePath: '/biz/musicals-since-reopening',
    children: React.createElement('section', { 'data-testid': 'topic-body' }, 'Unchanged topic content'),
  });
  assertHero(doc, 'Musicals Since Reopening', 'Commercial musicals opened September 2021 to today.');
  const back = doc.querySelector('a[href="/biz"]');
  assert.equal(back.textContent.trim(), 'Profitability Scorecard');
  assert.equal(back.compareDocumentPosition(doc.querySelector('header')) & 4, 4);
  assert.ok(doc.querySelector('header a[href="/methodology#commercial"]'));
  assert.match(doc.querySelector('header').textContent, /Questions, ideas, requests/);
  assert.equal(doc.querySelector('[data-testid="topic-body"]').closest('header'), null);
});

test('dashboard, topic shell, stunt casting and both season states use the shared hero', () => {
  for (const path of ['src/app/biz/page.tsx', 'src/components/biz/TopicPageShell.tsx', 'src/app/biz/stunt-casting/page.tsx', 'src/app/biz/season/[season]/page.tsx']) {
    const source = read(path);
    assert.match(source, /import BizHeader from ['"]@\/components\/biz\/BizHeader['"]/, path);
    assert.match(source, /<BizHeader\b/, path);
    assert.doesNotMatch(source, /<h1\b/, `${path} must use the shared heading`);
    if (path.includes('[season]')) assert.equal((source.match(/<BizHeader\b/g) || []).length, 2);
  }
});
