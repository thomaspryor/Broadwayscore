// BRO-113: notion-brain.js `create` silently lost 3 cards in one session
// whose --notes payloads contained section signs, arrows, star emoji, and
// long em-dash runs. This covers the two fixes:
//   1. scripts/lib/notion-text-chunking.js — chunk/overflow cuts must never
//      split a UTF-16 surrogate pair (any astral emoji), which used to
//      silently corrupt the payload sent to Notion.
//   2. scripts/lib/notion-create-safety.js — a post-create existence check
//      that turns "the API call resolved" into a confirmed "the card is
//      really there", throwing loudly otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROP_CHUNK,
  chunkText,
  buildRichTextWithOverflow,
} from '../../scripts/lib/notion-text-chunking.js';
import { verifyCardCreated } from '../../scripts/lib/notion-create-safety.js';

// The exact incident payload class (card 3a9637c5-416f-8120-b09a-ea9efd2d6e72
// in the BRO-113 transcript): section signs, arrows, star emoji, em-dash runs.
const S3_PAYLOAD =
  '## Problem\n§ Section sign test → arrow ⭐ star em-dash run ' +
  '——————————————————————————————————————————\n' +
  '## Suggested approach\ntest\n## Acceptance criteria\n`test -f package.json`';

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

test('chunkText never splits a surrogate pair sitting on the cut boundary', () => {
  // An astral emoji (surrogate pair) placed exactly across a no-newline hard
  // cut at `size` — this is the shape that silently corrupted the payload.
  const filler = 'x'.repeat(1899);
  const s = filler + '\u{1F600}' + 'y'.repeat(500);
  const chunks = chunkText(s, 1900);
  for (const chunk of chunks) assert.equal(hasLoneSurrogate(chunk), false, `chunk corrupted: ${JSON.stringify(chunk.slice(-10))}`);
  // Reassembling the chunks must reproduce the original text exactly.
  assert.equal(chunks.join(''), s);
});

test('chunkText still prefers a newline boundary when one exists', () => {
  const s = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
  const chunks = chunkText(s, 150);
  assert.equal(chunks[0], 'a'.repeat(100));
  assert.equal(chunks[1], 'b'.repeat(100));
});

test('buildRichTextWithOverflow leaves short special-character notes untouched (S3 incident payload)', () => {
  assert.ok(S3_PAYLOAD.length <= PROP_CHUNK, 'fixture should be short enough to stay in the property');
  const { propertyValue, bodyText } = buildRichTextWithOverflow(S3_PAYLOAD);
  assert.equal(bodyText, null);
  assert.equal(propertyValue.rich_text[0].text.content, S3_PAYLOAD);
});

test('buildRichTextWithOverflow overflow cut never splits a surrogate pair, and body text is the untruncated original', () => {
  // Force an overflow whose preview cut lands mid-emoji: no newlines at all,
  // so the cut falls back to the hard `maxPreview` boundary.
  const filler = '§'.repeat(1750) + '\u{2B50}'.repeat(1); // section signs + star (BMP, 1 unit)
  const withEmoji = filler + '\u{1F600}'.repeat(30) + '—'.repeat(200); // astral emoji + em-dash run
  const { propertyValue, bodyText } = buildRichTextWithOverflow(withEmoji);
  assert.ok(bodyText, 'expected overflow to trigger for text longer than PROP_CHUNK');
  const preview = propertyValue.rich_text[0].text.content;
  assert.equal(hasLoneSurrogate(preview), false, 'preview must not end mid-surrogate-pair');
  assert.equal(bodyText, withEmoji, 'full original text must be preserved for the page body');
});

test('verifyCardCreated resolves when the page is retrievable and not archived', async () => {
  const fakeNotion = {
    pages: {
      retrieve: async ({ page_id }) => ({ id: page_id, archived: false, in_trash: false }),
    },
  };
  const page = await verifyCardCreated(fakeNotion, 'page-123');
  assert.equal(page.id, 'page-123');
});

test('verifyCardCreated throws loudly when pages.retrieve rejects (API/network failure)', async () => {
  const fakeNotion = {
    pages: {
      retrieve: async () => {
        throw new Error('Notion API 500: internal_server_error');
      },
    },
  };
  await assert.rejects(
    () => verifyCardCreated(fakeNotion, 'page-456'),
    (err) => {
      assert.match(err.message, /Post-create existence check FAILED/);
      assert.match(err.message, /page-456/);
      assert.match(err.message, /Notion API 500/);
      return true;
    }
  );
});

test('verifyCardCreated throws when the page comes back archived immediately after create', async () => {
  const fakeNotion = {
    pages: {
      retrieve: async ({ page_id }) => ({ id: page_id, archived: true, in_trash: false }),
    },
  };
  await assert.rejects(() => verifyCardCreated(fakeNotion, 'page-789'), /is archived/);
});

test('verifyCardCreated throws when the page comes back in trash immediately after create', async () => {
  const fakeNotion = {
    pages: {
      retrieve: async ({ page_id }) => ({ id: page_id, archived: false, in_trash: true }),
    },
  };
  await assert.rejects(() => verifyCardCreated(fakeNotion, 'page-790'), /is in trash/);
});

test('verifyCardCreated throws when the API returns no page at all', async () => {
  const fakeNotion = {
    pages: {
      retrieve: async () => null,
    },
  };
  await assert.rejects(() => verifyCardCreated(fakeNotion, 'page-791'), /was not returned/);
});
