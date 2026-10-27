#!/usr/bin/env python3
"""Schedule the Benjamin Button compare short on one Buffer channel (BRO-6412).

usage: schedule-compare-short.py <youtube|tiktok|instagram> <dueAt ISO UTC> <thumbnailOffsetMs> [post]
Dry run by default (prints the payload, posts nothing); pass 'post' as the 4th argument to create the post.
The three posts for this video already exist (BRO-6412), so a second 'post' run creates a duplicate: the script
refuses unless no post with the same text is already queued on the channel. Buffer auth is injected by the
agent proxy, so no key or Authorization header is used. Caption is read from the reviewed plan file.
"""
import datetime, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CH = {'youtube': '6adebecc2f1f5ed648d28ccd', 'tiktok': '69ed4d52031bfa423c42d4fb', 'instagram': '69adf7f67be9f8b171375290'}
ORG = '69adf7b151aa2532be8bbaab'
URL = 'https://cdn.jsdelivr.net/gh/thomaspryor/Broadwayscore@a90549383abd52f996df4fbfad17091bf1f0bcc8/shorts/compare-benjamin-button-puzzle.mp4'


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


if len(sys.argv) < 4 or sys.argv[1] not in CH:
    die('usage: %s <youtube|tiktok|instagram> <dueAt ISO UTC> <thumbnailOffsetMs> [post]' % sys.argv[0])
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
cap = plan['caption']

title = 'Benjamin Button: London scored it 8 points higher. Why?'
meta = {
    'youtube': {'youtube': {'title': title, 'privacy': 'public', 'categoryId': '24', 'madeForKids': False, 'isAiGenerated': True, 'notifySubscribers': False}},
    'tiktok': {'tiktok': {'isAiGenerated': True, 'title': title}},
    'instagram': {'instagram': {'type': 'reel', 'shouldShareToFeed': True, 'isAiGenerated': True}},
}[which]
inp = {'channelId': CH[which], 'text': cap, 'schedulingType': 'automatic', 'mode': 'customScheduled', 'dueAt': due,
       'assets': [{'video': {'url': URL, 'metadata': {'thumbnailOffset': thumb}}}], 'metadata': meta}
if not live:
    print(json.dumps(inp, indent=1))
    sys.exit(0)

# duplicate guard: one post per show per network, so refuse if this caption is already queued on the channel
q = ('query($o:OrganizationId!,$c:[ChannelId!]){ posts(input:{organizationId:$o,filter:{channelIds:$c,status:[scheduled,sent]}}, first:50)'
     '{ edges { node { id text status dueAt } } } }')
try:
    dupes = [e['node'] for e in gql(q, {'o': ORG, 'c': [CH[which]]})['posts']['edges'] if e['node']['text'] == cap]
except (KeyError, TypeError):
    die('could not read the existing queue to check for duplicates; not posting')
if dupes:
    die('already posted/scheduled on %s: %s' % (which, dupes[0]['id']))

m = ('mutation Create($input: CreatePostInput!){ createPost(input:$input){ ... on PostActionSuccess { post { id dueAt status } } '
     '... on MutationError { message } } }')
res = gql(m, {'input': inp})['createPost']
if 'message' in res:
    die('Buffer refused the post: ' + res['message'])
print(json.dumps(res['post']))
