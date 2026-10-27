#!/usr/bin/env python3
"""Schedule the Benjamin Button compare short on one Buffer channel (BRO-6412).

usage: schedule-compare-short.py <youtube|tiktok|instagram> <dueAt ISO UTC> <thumbnailOffsetMs> [dry]
Run from the repo root. Buffer auth is injected by the agent proxy, so no key or Authorization header is used.
'dry' prints the payload and posts nothing. Caption is read from the reviewed plan file.
"""
import json, subprocess, sys

plan = json.load(open('scripts/video-proto/plans/compare-benjamin-button.plan.json'))
assert plan['review']['pass'], 'caption has not passed copy review'
cap = plan['caption']
URL = 'https://cdn.jsdelivr.net/gh/thomaspryor/Broadwayscore@a90549383abd52f996df4fbfad17091bf1f0bcc8/shorts/compare-benjamin-button-puzzle.mp4'
CH = {'youtube': '6adebecc2f1f5ed648d28ccd', 'tiktok': '69ed4d52031bfa423c42d4fb', 'instagram': '69adf7f67be9f8b171375290'}
which, due, thumb = sys.argv[1], sys.argv[2], int(sys.argv[3])
dry = len(sys.argv) > 4 and sys.argv[4] == 'dry'
title = 'Benjamin Button: London scored it 8 points higher. Why?'
meta = {
    'youtube': {'youtube': {'title': title, 'privacy': 'public', 'categoryId': '24', 'madeForKids': False, 'isAiGenerated': True, 'notifySubscribers': False}},
    'tiktok': {'tiktok': {'isAiGenerated': True, 'title': title}},
    'instagram': {'instagram': {'type': 'reel', 'shouldShareToFeed': True, 'isAiGenerated': True}},
}[which]
inp = {'channelId': CH[which], 'text': cap, 'schedulingType': 'automatic', 'mode': 'customScheduled', 'dueAt': due,
       'assets': [{'video': {'url': URL, 'metadata': {'thumbnailOffset': thumb}}}], 'metadata': meta}
q = 'mutation Create($input: CreatePostInput!){ createPost(input:$input){ ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }'
if dry:
    print(json.dumps(inp, indent=1))
    sys.exit(0)
r = subprocess.run(['curl', '-sS', '-X', 'POST', 'https://api.buffer.com', '-H', 'Content-Type: application/json',
                    '-d', json.dumps({'query': q, 'variables': {'input': inp}})], capture_output=True, text=True)
print(r.stdout[:800])
