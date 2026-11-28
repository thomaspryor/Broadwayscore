#!/usr/bin/env python3
"""Schedule the Benjamin Button compare short on one Buffer channel (BRO-6412).

usage: schedule-compare-short.py <youtube|tiktok|instagram|facebook> <dueAt ISO UTC> <thumbnailOffsetMs> [post]
Dry run by default (prints the payload, posts nothing); pass 'post' as the 4th argument to create the post.
This video is already posted on YouTube, TikTok and Instagram (BRO-6412), so a 'post' run there would create a duplicate:
the script refuses when a post with the same copy is already scheduled or sent on the channel (Facebook has none yet). Buffer auth is injected by the
agent proxy, so no key or Authorization header is used. Caption is read from the reviewed plan file, then the link
line is set per network by channel-captions.js (BRO-6737): live tagged link on Facebook, link in bio on TikTok and
Instagram, plain domain at the top on YouTube Shorts (their descriptions are not clickable).
"""
import datetime, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CH = {'youtube': '6adebecc2f1f5ed648d28ccd', 'tiktok': '69ed4d52031bfa423c42d4fb', 'instagram': '69adf7f67be9f8b171375290',
      'facebook': '69adfb857be9f8b171375c63'}
ORG = '69adf7b151aa2532be8bbaab'
# One file per channel (owner, 2026-11-01): each app covers a different part of the screen, so render.js --channel=<x>
# writes <comp>-<channel>.mp4 fitted to that app's safe area. Fill in a channel's URL once its render is committed.
# The original full-frame file (shorts/compare-benjamin-button-puzzle.mp4) went to YouTube, TikTok and Instagram and
# had its logo and captions under TikTok's chrome; it must not be posted again anywhere.
URLS = {}


def video_url(which):
    url = URLS.get(which)
    if not url or not url.endswith('-%s.mp4' % which):
        die('no %s render of this video (render.js --channel=%s); a video made for another app hides text under its buttons' % (which, which))
    return url


def die(msg):
    sys.exit('schedule-compare-short: ' + msg)


def gql(query, variables):
    r = subprocess.run(['curl', '-sS', '--fail-with-body', '--max-time', '30', '-X', 'POST', 'https://api.buffer.com',
                        '-H', 'Content-Type: application/json', '-d', json.dumps({'query': query, 'variables': variables})],
                       capture_output=True, text=True)
    if r.returncode:
        die('curl failed (%d): %s %s' % (r.returncode, r.stderr.strip(), r.stdout[:300]))
    body = json.loads(r.stdout)
    if body.get('errors'):
        die('GraphQL errors: ' + json.dumps(body['errors'])[:500])
    return body['data']


def norm(text):
    """Text as compared by the duplicate guard: straight quotes, single spaces, so Buffer re-encoding cannot hide a post."""
    for a, b in (('\u2018', "'"), ('\u2019', "'"), ('\u201c', '"'), ('\u201d', '"')):
        text = text.replace(a, b)
    return ' '.join(text.split())


def body_marker_of(caption):
    """The start of the video's copy. Every network's text for this video contains it; only the link line differs."""
    return norm(caption.split('\n\n')[0])[:80]


def find_dupes(posts, marker):
    return [p for p in posts if marker in norm(p.get('text') or '')]


MAX_PAGES = 20


def channel_posts(channel):
    """Every scheduled or sent post on a channel, all pages (the image autoposts share Instagram and Facebook)."""
    q = ('query($o:OrganizationId!,$c:[ChannelId!],$a:String){ posts(input:{organizationId:$o,filter:{channelIds:$c,status:[scheduled,sent]}}, first:100, after:$a)'
         '{ pageInfo { hasNextPage endCursor } edges { node { id text status dueAt } } } }')
    out, after = [], None
    for _ in range(MAX_PAGES):
        try:
            page = gql(q, {'o': ORG, 'c': [channel], 'a': after})['posts']
            out += [e['node'] for e in page['edges']]
            more, after = page['pageInfo']['hasNextPage'], page['pageInfo']['endCursor']
        except (KeyError, TypeError):
            die('could not read the existing queue to check for duplicates; not posting')
        if not more:
            return out
    die('more than %d posts on the channel; cannot prove this video is not already posted, not posting' % (MAX_PAGES * 100))


def main():
    if len(sys.argv) < 4 or sys.argv[1] not in CH:
        die('usage: %s <youtube|tiktok|instagram|facebook> <dueAt ISO UTC> <thumbnailOffsetMs> [post]' % sys.argv[0])
    which, due = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 4 and sys.argv[4] != 'post':
        die("4th argument must be 'post' (or omitted for a dry run)")
    live = len(sys.argv) > 4
    try:
        due_dt = datetime.datetime.fromisoformat(due.replace('Z', '+00:00'))
    except ValueError:
        die('dueAt is not an ISO timestamp: ' + due)
    if live and due_dt <= datetime.datetime.now(datetime.timezone.utc):
        die('dueAt is in the past')
    thumb = int(sys.argv[3])

    with open(os.path.join(HERE, 'plans', 'compare-benjamin-button.plan.json')) as f:
        plan = json.load(f)
    # same check as render.js loadVoice: the review must cover this exact plan, not an earlier version of it
    rh = subprocess.run(['node', '-e', "const {reviewHash}=require('./copyreview');process.stdout.write(reviewHash(JSON.parse(require('fs').readFileSync(0,'utf8'))))"],
                        input=json.dumps(plan), capture_output=True, text=True, cwd=HERE)
    if rh.returncode or not plan['review']['pass'] or plan['review'].get('of') != rh.stdout:
        die('caption has not passed copy review for this exact plan')
    # the plan's caption is the reviewed text; only its link line differs per network (channel-captions.js)
    cc = subprocess.run(['node', 'channel-captions.js', os.path.join('plans', 'compare-benjamin-button.plan.json'), which],
                        capture_output=True, text=True, cwd=HERE)
    if cc.returncode:
        die('could not build the %s caption: %s' % (which, cc.stderr.strip()[-300:]))
    cap = cc.stdout.rstrip('\n')
    # the same video body goes to every network, so the duplicate guard matches on it (the link line differs per network)
    marker = body_marker_of(plan['caption'])

    title = 'Benjamin Button: London scored it 8 points higher. Why?'
    meta = {
        'youtube': {'youtube': {'title': title, 'privacy': 'public', 'categoryId': '24', 'madeForKids': False, 'isAiGenerated': True, 'notifySubscribers': False}},
        'tiktok': {'tiktok': {'isAiGenerated': True, 'title': title}},
        'instagram': {'instagram': {'type': 'reel', 'shouldShareToFeed': True, 'isAiGenerated': True}},
        'facebook': {'facebook': {'type': 'reel'}},
    }[which]
    inp = {'channelId': CH[which], 'text': cap, 'schedulingType': 'automatic', 'mode': 'customScheduled', 'dueAt': due,
           'assets': [{'video': {'url': video_url(which), 'metadata': {'thumbnailOffset': thumb}}}], 'metadata': meta}
    if not live:
        print(json.dumps(inp, indent=1))
        sys.exit(0)

    # duplicate guard: one post per show per network, so refuse if this video's caption is already queued or sent on the channel
    dupes = find_dupes(channel_posts(CH[which]), marker)
    if dupes:
        die('already posted/scheduled on %s: %s' % (which, dupes[0]['id']))

    m = ('mutation Create($input: CreatePostInput!){ createPost(input:$input){ ... on PostActionSuccess { post { id dueAt status } } '
         '... on MutationError { message } } }')
    res = gql(m, {'input': inp})['createPost']
    if 'message' in res:
        die('Buffer refused the post: ' + res['message'])
    print(json.dumps(res['post']))


if __name__ == '__main__':
    main()
