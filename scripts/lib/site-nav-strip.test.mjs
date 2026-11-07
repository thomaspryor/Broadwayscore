// BRO-5859: site navigation menus captured ahead of the article (Stage and
// Cinema's flat menu, breadcrumbs, multi-line Home/Menu lists) and the Stage
// and Cinema share/donate footer. Requires the real functions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripLeadingSiteNav, stripSiteChrome, stripTrailingJunk } = require('./text-cleaning.js');
const { stripRecord } = require('./site-nav-record.js');

const SC_MENU = 'Home Contact Us Areas We Cover Categories hhhh Boston Chicago D.C. (Maryland / Virginia) International '
  + 'Las Vegas Los Angeles New York Palm Springs (Coachella Valley) Regional San Diego San Francisco (Bay Area) Texas '
  + 'Albums Art and Museums Books Cabaret Concerts / Events Dance Extras Film Interviews Music Theater TV Technology Virtual ';
const PROSE = 'Off-Broadway Review: A MADE-UP SHOW (Some Theatre) by A Critic | October 20, 2026 in New York , Theater '
  + 'The company sings well and the second act moves quickly, though the book sags in places. '.repeat(12);
const SC_FOOTER = ' ✦ ✦ ✦ Share on Facebook 𝕏 Share on X Share on Pinterest Share on Linkedin Share on Email Leave a Comment '
  + 'Cancel Reply Comment Name (required) Email (will not be published) (required) Website Search Articles '
  + 'Please help keep Stage and Cinema going! SUPPORT STAGE & CINEMA DONATE';

test('Stage and Cinema flat menu is cut at the article start', () => {
  const out = stripLeadingSiteNav(SC_MENU + PROSE);
  assert.ok(out.startsWith('Off-Broadway Review: A MADE-UP SHOW'), out.slice(0, 60));
});

test('stripSiteChrome cuts the Stage and Cinema menu and donate footer', () => {
  const out = stripSiteChrome(SC_MENU + PROSE + SC_FOOTER);
  assert.ok(out.startsWith('Off-Broadway Review:'));
  assert.ok(!/Share on Facebook|DONATE/.test(out), out.slice(-80));
  assert.ok(out.endsWith('✦ ✦ ✦'));
});

test('stripTrailingJunk (the ingest path) now removes the menu too', () => {
  const out = stripTrailingJunk(SC_MENU + PROSE + SC_FOOTER);
  assert.ok(out.startsWith('Off-Broadway Review:'));
  assert.ok(!/DONATE/.test(out));
});

test('breadcrumb trail is cut, the title after it stays', () => {
  assert.equal(stripLeadingSiteNav('Home » Reviews » A Made-Up Show, Royal Court ' + PROSE).slice(0, 30), 'A Made-Up Show, Royal Court Of');
  assert.ok(stripLeadingSiteNav('Home / Reviews / Review: A Made-Up Show ' + PROSE).startsWith('Review: A Made-Up Show'));
});

test('multi-line Home/Menu list goes up to the first prose line', () => {
  const menu = ['Menu', '', 'World', 'U.S.', 'Politics', 'Sports', 'Entertainment', 'Business', ''].join('\n');
  const out = stripLeadingSiteNav(menu + '\n' + PROSE);
  assert.ok(out.startsWith('Off-Broadway Review:'), out.slice(0, 40));
});

test('a menu whose lines carry a star rating is left alone', () => {
  const header = ['Home', 'Theater', 'Broadway', 'Recommended', '4 out of 5 stars', 'Buy tickets', ''].join('\n');
  const text = header + '\n' + PROSE;
  assert.equal(stripLeadingSiteNav(text), text);
});

test('prose that opens with "Home" is untouched', () => {
  const text = 'Home is where the heart is, and this play knows it. ' + PROSE;
  assert.equal(stripLeadingSiteNav(text), text);
  const shortList = ['Home', 'Away', 'Back', ''].join('\n') + PROSE;
  assert.equal(stripLeadingSiteNav(shortList), shortList);
});

test('stripRecord clears a pull quote that only the menu held and stamps the trim', () => {
  const d = { fullText: SC_MENU + PROSE + SC_FOOTER, llmPullQuote: 'SUPPORT STAGE & CINEMA', wordCount: 999 };
  const out = stripRecord(d, '2026-10-21T00:00:00Z');
  assert.equal(out.llmPullQuote, null);
  assert.equal(out.fullTextTrimmed.fromLength, d.fullText.length);
  assert.equal(out.fullTextTrimmed.toLength, out.fullText.length);
  assert.ok(out.wordCount < 999);
  assert.equal(stripRecord({ ...d, _locked: true }, 'x'), null);
  assert.equal(stripRecord({ fullText: PROSE }, 'x'), null);
});

test('BRO-5875: Time Out icon-chevron breadcrumb is cut, the title block after it stays', () => {
  const crumbs = ['Worldwide', 'North America', 'United States', 'New York State', 'New York']
    .map((c) => `${c}\n \n icon-chevron-right\n \n\n \n \n `).join('');
  const out = stripLeadingSiteNav(`${crumbs}The Lehman Trilogy\n \n \n \nThe Lehman Trilogy\n \n${PROSE}`);
  assert.ok(out.startsWith('The Lehman Trilogy'), out.slice(0, 60));
  assert.ok(!/icon-chevron-right|Worldwide/.test(out));
});

test('BRO-5875: Chronicle "Toggle Search" drawer is cut up to the byline', () => {
  const drawer = 'Toggle Search\n \n \n Search Keywords\n \n \n \n Search\n \n\n \n Need more options? Try advanced search.\n\n';
  const out = stripLeadingSiteNav(`${drawer}Photo by \n Emily Cui\n | The Chronicle\n\n${PROSE}`);
  assert.ok(out.startsWith('Photo by'), out.slice(0, 60));
  assert.ok(!/Toggle Search|advanced search/.test(out));
});

test('BRO-5875: a credit block opening with "Home" and a prose line starting "Worldwide" are not cut', () => {
  const credits = `Home\nBy Jane Critic\nDirected by Some Director\nMusic by A Composer\nBook by A Writer\n${PROSE}`;
  assert.equal(stripLeadingSiteNav(credits), credits);
  const prose = `Worldwide, audiences have loved this show.\n${PROSE}`;
  assert.equal(stripLeadingSiteNav(prose), prose);
});

test('BRO-5875: a menu that ends right before the byline is cut, the byline stays', () => {
  const t = `Menu\nWorld\nU.S.\nPolitics\nSports\nEntertainment\nBy MARK KENNEDY\n${PROSE}`;
  const out = stripLeadingSiteNav(t);
  assert.ok(out.startsWith('By MARK KENNEDY'), out.slice(0, 40));
});
