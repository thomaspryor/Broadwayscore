import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { heuristicClassify } = createRequire(import.meta.url)('./non-review-patterns.js');

const BODY = "Hanging used to be a spectator sport in the UK: crowds would gather to watch the guilty party dropped to their deaths. But in Martin McDonagh's new black comedy it's a hangman we're here to see. The performances are excellent and the set is magnificent, a brilliant production.";

test('WhatsOnStage "Photo Gallery NNN" widget label in front of a review is not a gallery page', () => {
  assert.equal(heuristicClassify(`Photo Gallery 602 ${BODY}`), null);
});

test('a real gallery page still classifies as photo_gallery', () => {
  const r = heuristicClassify('Photo Gallery: first photos from the new West End musical. See the photos of the cast in rehearsal and production photos.');
  assert.equal(r && r.type, 'photo_gallery');
});
