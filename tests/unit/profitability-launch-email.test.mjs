// BRO-6772 launch email: links unlock the scorecard for the list, images exist, copy has no em dashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildHtml, IMAGES, SUBJECT } from '../../scripts/email/profitability-launch.mjs';

test('launch email: every site link carries subscriber=1, images ship, no em dashes', () => {
  const html = buildHtml();
  const links = [...html.matchAll(/href="(https:\/\/broadwayscorecard\.com[^"]*)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 8, `found ${links.length} links`);
  for (const l of links) assert.match(l, /[?&]amp;subscriber=1|[?&]subscriber=1/, l);
  assert.match(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  for (const f of IMAGES) {
    assert.ok(fs.existsSync(new URL(`../../public/email/profitability-launch/${f}`, import.meta.url)), f);
    assert.ok(html.includes(`/email/profitability-launch/${f}`), `${f} used`);
  }
  assert.doesNotMatch(html, /—/, 'no em dashes');
  assert.ok(SUBJECT.length > 0);
});
