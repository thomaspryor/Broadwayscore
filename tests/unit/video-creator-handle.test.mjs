import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { creatorHandle } = require('../../scripts/lib/video-creator-handle.js');
const creators = require('../../data/video-creators.json').creators;

test('YouTube-primary creator with differing tiktok handle scans the YouTube handle', () => {
  assert.equal(creatorHandle({ primaryPlatform: 'youtube', platforms: { youtube: { channelHandle: 'Yt' }, tiktok: { handle: 'tt' } } }), 'Yt');
  assert.equal(creatorHandle({ primaryPlatform: 'tiktok', platforms: { youtube: { channelHandle: 'Yt' }, tiktok: { handle: 'tt' } } }), 'tt');
});

test('every creator in video-creators.json has a handle on its primary platform', () => {
  for (const c of creators) {
    const h = c.primaryPlatform === 'youtube' ? c.platforms.youtube?.channelHandle : c.platforms.tiktok?.handle;
    assert.ok(h, `${c.id} lacks a ${c.primaryPlatform} handle`);
  }
  for (const id of ['ellietalkstheatre', 'kristinaemily', 'flowertheatre']) assert.ok(creators.find(c => c.id === id), id);
});
